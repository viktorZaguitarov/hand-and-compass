#!/usr/bin/env node
'use strict';

/*
 * Dependency-free browser smoke test for the standalone draft.
 * It starts a local static server and talks to Chrome DevTools Protocol directly,
 * so the draft stays network-free and the repository needs no node_modules.
 */

const { createServer, request: httpRequest } = require('node:http');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { existsSync } = require('node:fs');
const { readFile, mkdtemp, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, extname, sep } = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = resolve(__dirname, '..');
const DEFAULT_CHROME_BIN = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome';
const CHROME_BIN = process.env.HAC_CHROME_BIN || DEFAULT_CHROME_BIN;
const TIMEOUT_MS = 30_000;
const GRAPH_BENCHMARK_MODE = process.argv.includes('--graph-151');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function startStaticServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      const relativePath = pathname === '/' ? '/draft/index.html' : pathname;
      const filePath = resolve(root, `.${relativePath}`);
      if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return { server, port: server.address().port };
}

function requestJson(port, method, pathname) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          rejectRequest(new Error(`DevTools returned ${response.statusCode}: ${body}`));
          return;
        }
        try { resolveRequest(JSON.parse(body)); }
        catch (error) { rejectRequest(error); }
      });
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

async function retry(action, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try { return await action(); }
    catch (error) {
      lastError = error;
      await sleep(80);
    }
  }
  throw new Error(`${label}: ${lastError?.message || 'timeout'}`);
}

class DevToolsSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.buffer = Buffer.alloc(0);
    this.fragment = null;
    this.nextId = 1;
  }

  async connect() {
    const port = Number(this.url.port || 80);
    this.socket = net.createConnection({ host: this.url.hostname, port });
    this.socket.setNoDelay(true);
    await new Promise((resolveConnect, rejectConnect) => {
      this.socket.once('error', rejectConnect);
      this.socket.once('connect', resolveConnect);
    });
    const key = randomBytes(16).toString('base64');
    const request = [
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: ${this.url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '', ''
    ].join('\r\n');
    this.socket.write(request);
    const response = await new Promise((resolveHandshake, rejectHandshake) => {
      let handshake = Buffer.alloc(0);
      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end < 0) return;
        this.socket.off('data', onData);
        const headers = handshake.subarray(0, end).toString('utf8');
        if (!/^HTTP\/1\.1 101 /m.test(headers)) {
          rejectHandshake(new Error(`WebSocket handshake failed: ${headers.split('\r\n')[0]}`));
          return;
        }
        resolveHandshake(handshake.subarray(end + 4));
      };
      this.socket.on('data', onData);
      this.socket.once('error', rejectHandshake);
    });
    this.socket.on('data', (chunk) => this.receive(chunk));
    this.socket.on('error', (error) => this.failPending(error));
    this.socket.on('close', () => this.failPending(new Error('DevTools socket closed')));
    if (response.length) this.receive(response);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  call(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.send({ id, method, params });
    });
  }

  send(message) {
    const payload = Buffer.from(JSON.stringify(message));
    const mask = randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let payloadLength = second & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const length = this.buffer.readBigUInt64BE(offset);
        if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DevTools frame is too large');
        payloadLength = Number(length);
        offset += 8;
      }
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + payloadLength) return;
      let payload = this.buffer.subarray(offset, offset + payloadLength);
      this.buffer = this.buffer.subarray(offset + payloadLength);
      if (masked) {
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      if (opcode === 0x8) {
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendControlFrame(0xA, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragment = this.fragment ? Buffer.concat([this.fragment, payload]) : payload;
        if (fin) {
          const text = this.fragment.toString('utf8');
          this.fragment = null;
          this.dispatch(JSON.parse(text));
        }
      }
    }
  }

  sendControlFrame(opcode, payload) {
    const mask = randomBytes(4);
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
    this.socket.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]));
  }

  dispatch(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }
    (this.listeners.get(message.method) || []).forEach((listener) => listener(message.params || {}));
  }

  failPending(error) {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  close() {
    this.socket?.end();
  }
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed');
  }
  return result.result.value;
}

async function waitFor(client, expression, label) {
  return retry(async () => {
    const value = await evaluate(client, expression);
    if (!value) throw new Error('condition is not ready');
    return value;
  }, label);
}

function visible(selector) {
  return `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node && !node.hidden && getComputedStyle(node).display !== 'none'); })()`;
}

async function click(client, selector) {
  return evaluate(client, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    if (node.disabled) throw new Error('Disabled control: ' + ${JSON.stringify(selector)});
    node.click();
    return node.textContent.trim();
  })()`);
}

async function terminate(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => processHandle.once('exit', resolveExit)),
    sleep(2_000)
  ]);
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
}

async function runGraphBenchmark(client, serverPort, consoleErrors) {
  const dictionary = JSON.parse(await readFile(join(ROOT, 'draft/words_v3.json'), 'utf8'));
  const wordIds = dictionary.words.map((word) => word.id);
  assert(wordIds.length === 151, `Expected 151 dictionary words, received ${wordIds.length}`);
  await client.call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });
  await client.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/draft/index.html?graph-benchmark=1` });
  await waitFor(client, "document.readyState === 'complete' && !document.body.classList.contains('is-booting')", 'benchmark bootstrap');
  const selectionWaves = Object.fromEntries(wordIds.map((id) => [id, 1]));
  const benchmarkState = {
    version: 6,
    selectedIds: wordIds,
    customWords: [],
    selectionWaves,
    wordWeights: Object.fromEntries(wordIds.map((id) => [id, 1])),
    waveOneIds: wordIds,
    waveOneCustomIds: [],
    wave: 2,
    view: 'graph',
    pendingCustomId: null,
    pickerReturnView: 'scatter',
    supplementShelfId: null,
    matchTarget: 50,
    matchVisibleCount: 3,
    activeProfileId: null,
    worldWordId: null,
    worldHistory: [],
    worldReturn: null,
    worldProfileId: null,
    intersectionReturn: null,
    snapshotShelfId: 'values',
    wordSigns: {},
    privacyByWord: {},
    topThreeValues: [],
    graphTrailIds: [],
    updatedAt: new Date().toISOString()
  };
  await evaluate(client, `localStorage.setItem('hand_compass_snapshot_v2_draft', ${JSON.stringify(JSON.stringify(benchmarkState))})`);
  const runs = [];
  for (let index = 0; index < 3; index += 1) {
    const startedAt = Date.now();
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, `${visible('#graphScreen')} && document.querySelectorAll('[data-graph-node-id]').length === 151`, `151-node graph render ${index + 1}`);
    runs.push(Date.now() - startedAt);
  }
  const viewport = await evaluate(client, `(() => ({
    width: document.documentElement.clientWidth,
    height: window.innerHeight,
    nodes: document.querySelectorAll('[data-graph-node-id]').length
  }))()`);
  assert(consoleErrors.length === 0, `graph console errors: ${consoleErrors.join(' | ')}`);
  const average = Math.round(runs.reduce((total, value) => total + value, 0) / runs.length);
  console.log(`GRAPH 151 PASS (${viewport.width}×${viewport.height}): ${runs.join(', ')} ms; average ${average} ms; ${viewport.nodes} nodes`);
}

async function main() {
  assert(existsSync(CHROME_BIN), `Chrome не найден: ${CHROME_BIN}. Укажи HAC_CHROME_BIN=/путь/к/chrome.`);
  const startedAt = Date.now();
  const completed = [];
  const consoleErrors = [];
  let server;
  let chrome;
  let client;
  let profileDirectory;
  let serverPort;

  try {
    ({ server, port: serverPort } = await startStaticServer(ROOT));
    const debugPort = await findFreePort();
    profileDirectory = await mkdtemp(join(tmpdir(), 'hand-compass-smoke-'));
    chrome = spawn(CHROME_BIN, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-allow-origins=*', '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDirectory}`, 'about:blank'
    ], { stdio: 'ignore' });

    const target = await retry(async () => {
      const targets = await requestJson(debugPort, 'GET', '/json/list');
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (!page) throw new Error('page target is not ready');
      return page;
    }, 'Chrome DevTools is not ready');

    client = new DevToolsSocket(target.webSocketDebuggerUrl);
    await client.connect();
    client.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(`runtime: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'unknown exception'}`);
    });
    client.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error') consoleErrors.push(`log: ${params.entry.text}`);
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'assert') {
        consoleErrors.push(`console: ${(params.args || []).map((item) => item.value || item.description || '').join(' ')}`);
      }
    });
    await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);

    if (GRAPH_BENCHMARK_MODE) {
      await runGraphBenchmark(client, serverPort, consoleErrors);
      return;
    }

    await client.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/draft/index.html?smoke=1` });
    await waitFor(client, "document.readyState === 'complete' && !document.body.classList.contains('is-booting')", 'draft bootstrap');

    await click(client, '#startLightButton');
    await waitFor(client, visible('#scatterScreen'), 'light word selection');
    for (const id of ['chestnost', 'blizost', 'muzyka', 'knigi', 'vernost']) {
      await click(client, `[data-word-id="${id}"]`);
    }
    await waitFor(client, '!document.getElementById("doneButton").disabled', 'five light words');
    await click(client, '#doneButton');
    await waitFor(client, visible('#darkIntroScreen'), 'dark-wave entry');
    await click(client, '#startDarkButton');
    await waitFor(client, visible('#scatterScreen'), 'dark word selection');
    await click(client, '[data-word-id="predatelstvo"]');
    await click(client, '#doneButton');
    await waitFor(client, `${visible('#snapshotScreen')} && document.querySelectorAll('#shelfGrid .shelf-card').length > 0`, 'snapshot render');
    const initialWeights = await evaluate(client, `(() => {
      const saved = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      return saved.selectedIds.map((id) => saved.wordWeights[id]);
    })()`);
    assert(initialWeights.every((weight) => weight === 1), 'ritual words did not start with personal weight 1');
    completed.push('онбординг → слепок');

    await click(client, '[data-path-chapter="map"]');
    const chapterMotion = await evaluate(client, `(() => {
      const screen = [...document.querySelectorAll('.screen')].find((node) => !node.hidden);
      return screen ? { name: getComputedStyle(screen).animationName, duration: getComputedStyle(screen).animationDuration } : null;
    })()`);
    assert(chapterMotion && chapterMotion.name.includes('chapter-enter') && chapterMotion.duration === '0.3s', 'chapter motion is not active');
    await waitFor(client, `${visible('#graphIntroScreen')} || ${visible('#graphScreen')}`, 'graph entry');
    if (await evaluate(client, visible('#graphIntroScreen'))) await click(client, '#graphIntroNextButton');
    await waitFor(client, `${visible('#graphScreen')} && document.querySelectorAll('[data-graph-node-id]').length >= 6`, 'graph render');
    const initialGraphDots = await evaluate(client, `Object.fromEntries([...document.querySelectorAll('[data-graph-node-id]')].map((node) => [node.dataset.graphNodeId, Number(node.querySelector('.graph-node-weight-dot')?.getAttribute('r'))]))`);
    assert(Object.values(initialGraphDots).every((radius) => Number.isFinite(radius)), 'graph personal-weight dots are missing');
    assert(consoleErrors.length === 0, `graph console errors: ${consoleErrors.join(' | ')}`);
    completed.push('граф без ошибок консоли');

    await click(client, '[data-path-chapter="closeness"]');
    await waitFor(client, visible('#closenessScreen'), 'closeness controls');
    await evaluate(client, `(() => {
      const range = document.getElementById('matchRange');
      range.value = '64';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      return range.getAttribute('aria-valuetext');
    })()`);
    await click(client, '#closenessShowIntersections');
    await waitFor(client, `${visible('#intersectionsScreen')} && document.querySelectorAll('#profileList [data-profile-id]').length >= 3`, 'intersection calculation');
    await click(client, '#profileList [data-profile-id]');
    await waitFor(client, `${visible('#profileIntersectionScreen')} && document.querySelectorAll('#profileIntersectionContent .profile-intersection-section').length === 3`, 'profile intersection');
    await click(client, '[data-profile-intersection-back]');
    await waitFor(client, visible('#intersectionsScreen'), 'intersection list return');
    completed.push('пересечения');

    await click(client, '[data-path-chapter="worlds"]');
    await waitFor(client, `${visible('#worldsScreen')} && document.querySelectorAll('#worldsDirectory [data-world-directory-word]').length > 0`, 'world directory');
    await click(client, '#worldsDirectory [data-world-directory-word]');
    await waitFor(client, `${visible('#wordWorldScreen')} && document.querySelector('#wordWorldContent h1')`, 'word world');
    completed.push('мир слова');

    await click(client, '[data-path-chapter="forks"]');
    await waitFor(client, visible('.fork-step-situation'), 'fork situation');
    await click(client, '[data-fork-action="to-choice"]');
    await waitFor(client, visible('.fork-step-choice'), 'fork own choice');
    await evaluate(client, `(() => {
      const actual = JSON.parse(localStorage.getItem('hand_compass_forks_v1')).history.at(-1).actualChoice;
      const different = actual === 'A' ? 'B' : 'A';
      document.querySelector('[data-fork-action="choose-' + different + '"]').click();
    })()`);
    await waitFor(client, visible('.fork-step-truth'), 'fork truth');
    await waitFor(client, `document.querySelector('.fork-step-truth h1').textContent.includes('иначе')`, 'fork post-choice difference');
    const weightCheck = await evaluate(client, `(() => {
      const state = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      const record = JSON.parse(localStorage.getItem('hand_compass_forks_v1')).history.at(-1);
      const dilemmas = JSON.parse(document.getElementById('dilemmasData').textContent);
      const dilemma = dilemmas.find((item) => item.id === record.dilemmaId);
      const candidate = record.userChoice === 'A' ? dilemma.candidateA : dilemma.candidateB;
      const related = [...new Set([...dilemma.words, candidate])];
      return {
        weighted: record.weightedWordIds,
        weightsApplied: record.weightsApplied,
        weightedAreSelected: record.weightedWordIds.every((id) => state.selectedIds.includes(id)),
        weightedGrew: record.weightedWordIds.every((id) => state.wordWeights[id] === 2),
        outsideSnapshotStayedEmpty: related.filter((id) => !state.selectedIds.includes(id)).every((id) => state.wordWeights[id] === undefined),
        unrelatedStayedOne: state.selectedIds.filter((id) => !related.includes(id)).every((id) => state.wordWeights[id] === 1)
      };
    })()`);
    assert(weightCheck.weightsApplied && weightCheck.weighted.length > 0, 'dilemma did not confirm a selected word');
    assert(weightCheck.weightedAreSelected && weightCheck.weightedGrew, 'dilemma weight was not limited to selected words');
    assert(weightCheck.outsideSnapshotStayedEmpty && weightCheck.unrelatedStayedOne, 'dilemma changed an unrelated or unselected word');
    await click(client, '[data-fork-action="to-outcome"]');
    await waitFor(client, visible('.fork-step-outcome'), 'fork outcome');
    await click(client, '[data-path-chapter="map"]');
    await waitFor(client, visible('#graphScreen'), 'graph after dilemma');
    const grownRadius = await evaluate(client, `Number(document.querySelector('[data-graph-node-id="${weightCheck.weighted[0]}"] .graph-node-weight-dot')?.getAttribute('r'))`);
    assert(grownRadius > initialGraphDots[weightCheck.weighted[0]], 'personal-weight dot did not grow after dilemma');
    completed.push('развилка: 4 шага + личный вес');

    await click(client, '[data-path-chapter="mirror"]');
    await waitFor(client, visible('#snapshotScreen'), 'snapshot before supplement');
    await click(client, '#shelfGrid [data-deepen-shelf]');
    await waitFor(client, `${visible('#scatterScreen')} && document.getElementById('doneButton').textContent.includes('слепку')`, 'shelf supplement');
    const supplementId = await evaluate(client, `(() => {
      const token = [...document.querySelectorAll('#wordField [data-word-id]')].find((node) => node.getAttribute('aria-pressed') === 'false');
      if (!token) throw new Error('No unselected word in supplement');
      token.click();
      return token.dataset.wordId;
    })()`);
    await click(client, '#doneButton');
    await waitFor(client, visible('#snapshotScreen'), 'supplement return to snapshot');
    const supplementWeight = await evaluate(client, `JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft')).wordWeights[${JSON.stringify(supplementId)}]`);
    assert(supplementWeight === 1, 'supplement word did not start with personal weight 1');
    completed.push('дополнить → слепок');

    const legacySelectionCount = await evaluate(client, `(() => {
      const saved = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      const count = saved.selectedIds.length + saved.customWords.length;
      delete saved.wordWeights;
      localStorage.setItem('hand_compass_snapshot_v2_draft', JSON.stringify(saved));
      return count;
    })()`);
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, `${visible('#snapshotScreen')} && !document.body.classList.contains('is-booting')`, 'legacy weight migration');
    await click(client, '[data-path-chapter="map"]');
    await waitFor(client, visible('#graphScreen'), 'migrated graph');
    const migratedWeights = await evaluate(client, `(() => ({
      count: document.querySelectorAll('[data-graph-node-id]').length,
      allOne: [...document.querySelectorAll('[data-graph-node-id]')].every((node) => node.dataset.personalWeight === '1')
    }))()`);
    assert(migratedWeights.count === legacySelectionCount && migratedWeights.allOne, 'legacy selected words were not migrated to weight 1');
    completed.push('миграция веса без потери слов');

    await click(client, '[data-path-chapter="personality"]');
    await waitFor(client, `${visible('#scatterScreen')} && ${visible('#personalityTabs')} && document.getElementById('scatterActions').hidden`, 'returning personality tabs');
    completed.push('возврат → личность без онбординга');

    await client.call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await click(client, '[data-path-chapter="worlds"]');
    const reducedMotionClass = await evaluate(client, `document.querySelector('.is-chapter-entering-forward, .is-chapter-entering-backward')?.className || ''`);
    assert(!reducedMotionClass, 'reduced-motion chapter change should be instant');
    completed.push('reduced motion');

    assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
    console.log(`SMOKE PASS (${Date.now() - startedAt} ms): ${completed.join(' · ')}`);
  } finally {
    client?.close();
    await terminate(chrome);
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`SMOKE FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
