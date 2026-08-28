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
const { readFile, writeFile, mkdtemp, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, extname, sep } = require('node:path');
const { spawn } = require('node:child_process');
const { deflateSync } = require('node:zlib');

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
  let fullSnapshotLinkLength = null;

  try {
    ({ server, port: serverPort } = await startStaticServer(ROOT));
    const debugPort = await findFreePort();
    profileDirectory = await mkdtemp(join(tmpdir(), 'hand-compass-smoke-'));
    chrome = spawn(CHROME_BIN, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
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

    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true
    });
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
    const snapshotHeading = await evaluate(client, `(() => ({
      title: document.getElementById('snapshotTitle').textContent.trim(),
      subtitle: document.querySelector('#snapshotScreen .snapshot-head .lead').textContent.trim()
    }))()`);
    assert(snapshotHeading.title === 'Это гипотезы из твоих слов' && snapshotHeading.subtitle === 'Править их можешь только ты', 'snapshot heading is stale');
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
    const defaultConnections = await evaluate(client, `(() => ({
      pressed: document.getElementById('graphAllConnectionsButton').getAttribute('aria-pressed'),
      saved: JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft')).graphAllConnections
    }))()`);
    assert(defaultConnections.pressed === 'true' && defaultConnections.saved === true, 'all graph connections are not enabled by default');
    await click(client, '#graphAllConnectionsButton');
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, `${visible('#graphScreen')} && document.getElementById('graphAllConnectionsButton').getAttribute('aria-pressed') === 'false'`, 'saved all-connections toggle');
    await click(client, '#graphAllConnectionsButton');
    await evaluate(client, `document.querySelector('[data-graph-node-id="chestnost"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitFor(client, `${visible('#graphCard')} && document.querySelector('#graphCard .graph-card-details')`, 'always-open graph details');
    const graphDetails = await evaluate(client, `(() => {
      const details = document.querySelector('#graphCard .graph-card-details');
      const content = details.querySelector('.graph-card-detail-content');
      return { tag: details.tagName, visible: getComputedStyle(content).display !== 'none', title: details.querySelector('.graph-card-details-title')?.textContent };
    })()`);
    assert(graphDetails.tag === 'SECTION' && graphDetails.visible && graphDetails.title === 'Подробнее', 'graph details can still collapse');
    await click(client, '#graphJumpButton');
    await waitFor(client, `document.getElementById('graphStatus').textContent.startsWith('Выбрано:') && document.getElementById('graphStatus').textContent.includes('Соединено с:')`, 'distant jump connection summary');
    const initialGraphDots = await evaluate(client, `Object.fromEntries([...document.querySelectorAll('[data-graph-node-id]')].map((node) => [node.dataset.graphNodeId, Number(node.querySelector('.graph-node-weight-dot')?.getAttribute('r'))]))`);
    assert(Object.values(initialGraphDots).every((radius) => Number.isFinite(radius)), 'graph personal-weight dots are missing');
    assert(consoleErrors.length === 0, `graph console errors: ${consoleErrors.join(' | ')}`);
    completed.push('граф без ошибок консоли');

    const pathStructure = await evaluate(client, `(() => ({
      chapters: [...document.querySelectorAll('[data-path-chapter]')].map((node) => node.dataset.pathChapter),
      closenessScreens: document.querySelectorAll('#closenessScreen').length
    }))()`);
    assert(pathStructure.chapters.length === 6 && !pathStructure.chapters.includes('closeness') && pathStructure.closenessScreens === 0, 'closeness is still a separate chapter');
    await click(client, '[data-path-chapter="intersections"]');
    await waitFor(client, `${visible('#intersectionsScreen')} && ${visible('#matchRange')} && document.querySelectorAll('#profileList [data-profile-id]').length >= 3`, 'combined intersections controls');
    await evaluate(client, `(() => {
      const saved = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      saved.view = 'closeness';
      localStorage.setItem('hand_compass_snapshot_v2_draft', JSON.stringify(saved));
    })()`);
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, `${visible('#intersectionsScreen')} && document.querySelector('[data-path-chapter="intersections"]').getAttribute('aria-current') === 'step'`, 'legacy closeness migration');
    await evaluate(client, `(() => {
      const range = document.getElementById('matchRange');
      range.value = '64';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      return range.getAttribute('aria-valuetext');
    })()`);
    await waitFor(client, `document.querySelectorAll('#profileList [data-profile-id]').length >= 3`, 'intersection calculation');
    await click(client, '#profileList [data-profile-id]');
    await waitFor(client, `${visible('#profileIntersectionScreen')} && document.querySelectorAll('#profileIntersectionContent .profile-intersection-section').length === 3`, 'profile intersection');
    await click(client, '[data-profile-intersection-back]');
    await waitFor(client, visible('#intersectionsScreen'), 'intersection list return');
    completed.push('пересечения');

    await evaluate(client, `(() => {
      const saved = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      saved.privacyByWord = { ...(saved.privacyByWord || {}), blizost: 'only-me', predatelstvo: 'only-me' };
      saved.view = 'intersections';
      localStorage.setItem('hand_compass_snapshot_v2_draft', JSON.stringify(saved));
    })()`);
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, visible('#intersectionsScreen'), 'sender intersections after privacy update');
    await click(client, '#openLinkShareButton');
    await waitFor(client, visible('#linkShareScreen'), 'friend link preview');
    const senderPreview = await evaluate(client, `(() => ({
      words: [...document.querySelectorAll('#linkShareContent .link-preview-word')].map((node) => node.textContent.trim()),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(senderPreview.words.includes('честность'), 'public word is missing from friend-link preview');
    assert(!senderPreview.words.includes('близость') && !senderPreview.words.includes('предательство'), 'private word leaked into friend-link preview');
    assert(!senderPreview.overflow, 'friend-link preview overflows at 390px');
    await evaluate(client, `(() => {
      const input = document.querySelector('#linkShareContent [name="nickname"]');
      input.value = 'Отправитель';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#linkShareContent [data-link-share-form]').requestSubmit();
    })()`);
    await waitFor(client, `new URL(document.querySelector('#linkShareContent .link-share-url')?.value).searchParams.has('c')`, 'sender query-link creation');
    const senderBundle = await evaluate(client, `(() => ({
      url: document.querySelector('#linkShareContent .link-share-url').value,
      storage: Object.fromEntries(Object.entries(localStorage))
    }))()`);
    assert(new URL(senderBundle.url).searchParams.get('c') && !new URL(senderBundle.url).hash,
      'sender link is not using the query-only payload format');

    await evaluate(client, 'localStorage.clear(); sessionStorage.clear(); true');
    await client.call('Page.navigate', { url: 'about:blank' });
    await client.call('Page.navigate', { url: senderBundle.url });
    await waitFor(client, `${visible('#linkInviteScreen')} && !document.body.classList.contains('is-booting')`, 'clean-profile friend invitation');
    const invitation = await evaluate(client, `(() => ({
      title: document.getElementById('linkInviteTitle').textContent.trim(),
      pathHidden: document.getElementById('pathNav').hidden,
      browserHint: document.querySelector('#linkInviteContent .link-browser-hint')?.textContent.trim(),
      browserHintTag: document.querySelector('#linkInviteContent .link-browser-hint')?.tagName,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(invitation.title === 'Отправитель приглашает тебя сравнить карты.', 'friend invitation has the wrong sender');
    assert(invitation.pathHidden && !invitation.overflow, 'friend invitation navigation or 390px layout is broken');
    assert(invitation.browserHint === 'Если у тебя уже есть карта — открой ссылку в обычном браузере: меню ⋯ → "Открыть в Safari" (или Chrome).'
      && invitation.browserHintTag === 'P', 'friend invitation has no plain-text regular-browser hint');
    assert(await evaluate(client, `Boolean(document.querySelector('#linkInviteContent [data-link-paste-form] [name="linkMessage"]'))`),
      'friend invitation has no manual message field');
    await click(client, '[data-link-invite-start]');
    await waitFor(client, visible('#scatterScreen'), 'recipient ritual start');
    const recipientLightIds = await evaluate(client, `(() => {
      const excluded = new Set(['knigi', 'vernost', 'blizost']);
      const preferred = ['chestnost', 'muzyka'];
      const words = new Map(JSON.parse(document.getElementById('wordsData').textContent).words.map((word) => [word.id, word]));
      const available = [...document.querySelectorAll('#wordField [data-word-id]')]
        .map((node) => node.dataset.wordId)
        .filter((id) => !excluded.has(id) && !preferred.includes(id)
          && !(words.get(id).shelves || []).some((shelf) => shelf === 'stones' || shelf === 'triggers'));
      const selected = preferred.concat(available.slice(0, 28));
      selected.forEach((id) => document.querySelector('#wordField [data-word-id="' + id + '"]').click());
      return selected;
    })()`);
    assert(recipientLightIds.length === 30, 'recipient ritual did not select enough shareable words for a real response payload');
    await click(client, '#doneButton');
    await waitFor(client, visible('#darkIntroScreen'), 'recipient dark-wave entry');
    await click(client, '#startDarkButton');
    await click(client, '[data-word-id="davlenie"]');
    await click(client, '#doneButton');
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.querySelectorAll('#linkComparisonContent .link-comparison-section').length === 3`, 'recipient comparison screen');
    const recipientComparison = await evaluate(client, `(() => {
      const stateText = localStorage.getItem('hand_compass_snapshot_v2_draft');
      const state = JSON.parse(stateText);
      return {
        headings: [...document.querySelectorAll('#linkComparisonContent .link-comparison-section h2')].map((node) => node.textContent.trim()),
        selectedIds: state.selectedIds,
        storedGuest: stateText.includes('Отправитель') || stateText.includes('linkGuest'),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert(recipientComparison.headings.join('|') === 'Что вас связывает|Где вы разные|О чём спросить Отправитель', 'comparison structure is incomplete');
    assert(!recipientComparison.selectedIds.includes('knigi') && !recipientComparison.selectedIds.includes('vernost'), 'guest words were imported into the recipient snapshot');
    assert(!recipientComparison.storedGuest && !recipientComparison.overflow, 'guest data was stored or comparison overflows at 390px');
    const recipientMeetingTrace = await evaluate(client, `(() => {
      const stored = JSON.parse(localStorage.getItem('hand_compass_meeting_traces_v1'));
      const trace = stored.items.at(-1);
      return {
        count: stored.items.length,
        nickname: trace.nickname,
        commonWordIds: trace.commonWordIds,
        fields: Object.keys(trace).sort(),
        foreignWordLeaked: JSON.stringify(stored).includes('knigi') || JSON.stringify(stored).includes('vernost'),
        guestShapeLeaked: Object.hasOwn(trace, 'words') || Object.hasOwn(trace, 'guest') || Object.hasOwn(trace, 'encoded')
      };
    })()`);
    assert(recipientMeetingTrace.count === 1 && recipientMeetingTrace.nickname === 'Отправитель', 'comparison did not save one meeting trace');
    assert(recipientMeetingTrace.commonWordIds.sort().join('|') === 'chestnost|muzyka', 'meeting trace saved the wrong common words');
    assert(recipientMeetingTrace.fields.join('|') === 'commonWordIds|id|nickname|viewedAt'
      && !recipientMeetingTrace.foreignWordLeaked && !recipientMeetingTrace.guestShapeLeaked,
      'meeting trace stored data beyond nickname, date, and common words');
    await click(client, '[data-link-comparison-reply]');
    await waitFor(client, visible('#linkShareScreen'), 'reply-link preview');
    await evaluate(client, `(() => {
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data) => { window.__lastComparisonShare = data; }
      });
      const input = document.querySelector('#linkShareContent [name="nickname"]');
      input.value = 'Друг';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#linkShareContent [data-link-share-form]').requestSubmit();
    })()`);
    await waitFor(client, `new URL(document.querySelector('#linkShareContent .link-share-url')?.value).searchParams.has('c')`, 'reply query-link creation');
    const responseBundle = await evaluate(client, `(async () => {
      const url = document.querySelector('#linkShareContent .link-share-url').value;
      const parsedUrl = new URL(url);
      const encoded = parsedUrl.searchParams.get('c');
      const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      const payload = JSON.parse(await new Response(stream).text());
      return {
        url,
        length: url.length,
        queryPayload: encoded,
        hash: parsedUrl.hash,
        payloadWords: payload.w?.map((word) => word.i) || [],
        shared: window.__lastComparisonShare || null
      };
    })()`);
    assert(responseBundle.length > 500, `reply link is suspiciously short (${responseBundle.length} characters)`);
    assert(responseBundle.queryPayload && !responseBundle.hash, 'reply link is not using the query-only payload format');
    assert(responseBundle.payloadWords.length === recipientLightIds.length,
      `reply payload is empty, broken, or does not contain the fresh ritual words (${JSON.stringify({ selected: recipientLightIds.length, payload: responseBundle.payloadWords.length })})`);
    assert(responseBundle.payloadWords.every((id) => recipientLightIds.includes(id)), 'reply payload contains words outside the recipient ritual');
    assert(responseBundle.shared && responseBundle.shared.text.includes(responseBundle.url), 'system share did not receive the full query URL');
    assert(!Object.hasOwn(responseBundle.shared, 'url'), 'system share unexpectedly split the comparison URL out of the message text');
    const responseLink = responseBundle.url;

    await evaluate(client, `(() => {
      localStorage.clear();
      Object.entries(${JSON.stringify(senderBundle.storage)}).forEach(([key, value]) => localStorage.setItem(key, value));
      sessionStorage.clear();
    })()`);
    await client.call('Page.navigate', { url: 'about:blank' });
    await client.call('Page.navigate', { url: responseLink });
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.getElementById('linkComparisonTitle').textContent.includes('Друг')`, 'sender opens reply link');
    const returnedComparison = await evaluate(client, `(() => ({
      sections: document.querySelectorAll('#linkComparisonContent .link-comparison-section').length,
      ritualVisible: !document.getElementById('scatterScreen').hidden || !document.getElementById('lightIntroScreen').hidden,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(returnedComparison.sections === 3 && !returnedComparison.ritualVisible && !returnedComparison.overflow,
      'reply opened the ritual instead of the comparison, or overflows at 390px');

    const truncatedResponseLink = new URL(responseLink);
    truncatedResponseLink.searchParams.set('c', responseBundle.queryPayload.slice(0, Math.floor(responseBundle.queryPayload.length / 2)));
    await client.call('Page.navigate', { url: 'about:blank' });
    await client.call('Page.navigate', { url: truncatedResponseLink.href });
    await waitFor(client, `${visible('#linkInviteScreen')} && document.getElementById('linkInviteTitle').textContent === 'Ссылка не дошла целиком.'`, 'truncated reply error');
    const truncatedScreen = await evaluate(client, `(() => ({
      lead: document.querySelector('#linkInviteScreen .lead').textContent.trim(),
      detail: document.querySelector('#linkInviteContent .link-warning').textContent.trim(),
      ritualVisible: !document.getElementById('scatterScreen').hidden || !document.getElementById('lightIntroScreen').hidden,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(truncatedScreen.lead === 'Попроси отправить её заново.'
      && truncatedScreen.detail === 'Данные карты повреждены или обрываются.'
      && !truncatedScreen.ritualVisible && !truncatedScreen.overflow,
      'truncated comparison link silently fell back to the ritual or overflows at 390px');

    await evaluate(client, `(() => {
      const input = document.querySelector('#linkInviteContent [name="linkMessage"]');
      input.value = 'Друг приглашает тебя сравнить карты.\\n' + ${JSON.stringify(responseLink)} + '\\nСообщение из Telegram';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#linkInviteContent [data-link-paste-form]').requestSubmit();
    })()`);
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.getElementById('linkComparisonTitle').textContent.includes('Друг')`, 'manual message paste comparison');
    assert(!await evaluate(client, visible('#scatterScreen')), 'manual message paste fell back to the ritual');

    const legacyHashLink = new URL(responseLink);
    legacyHashLink.searchParams.delete('c');
    legacyHashLink.hash = `compare=${responseBundle.queryPayload}`;
    await client.call('Page.navigate', { url: 'about:blank' });
    await client.call('Page.navigate', { url: legacyHashLink.href });
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.getElementById('linkComparisonTitle').textContent.includes('Друг')`, 'legacy hash comparison');
    assert(!await evaluate(client, visible('#scatterScreen')), 'legacy hash link fell back to the ritual');
    await click(client, '[data-link-comparison-back]');
    await waitFor(client, visible('#intersectionsScreen'), 'return from friend comparison');
    await waitFor(client, `document.querySelectorAll('#meetingPeopleList [data-meeting-trace-id]').length === 1`, 'People meeting list');
    const peopleBlock = await evaluate(client, `(() => {
      const card = document.querySelector('#meetingPeopleList [data-meeting-trace-id]');
      const people = document.querySelector('.meeting-people');
      const matchPanel = document.querySelector('.match-panel');
      return {
        name: card.querySelector('.meeting-card-name')?.textContent.trim(),
        chips: [...card.querySelectorAll('.meeting-card-word')].map((node) => node.textContent.trim()),
        dateTime: card.querySelector('time')?.dateTime,
        beforeTwins: Boolean(people.compareDocumentPosition(matchPanel) & Node.DOCUMENT_POSITION_FOLLOWING),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    })()`);
    assert(peopleBlock.name === 'Друг' && peopleBlock.chips.length > 0 && peopleBlock.chips.length <= 3
      && peopleBlock.dateTime && peopleBlock.beforeTwins && !peopleBlock.overflow,
      'People card is incomplete, misplaced, or overflows at 390px');
    await click(client, '#meetingPeopleList [data-meeting-trace-id]');
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.querySelectorAll('#linkComparisonContent .link-comparison-section').length === 3`, 'available saved comparison');
    await click(client, '[data-link-comparison-back]');
    await waitFor(client, visible('#intersectionsScreen'), 'return from available saved comparison');
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, `${visible('#intersectionsScreen')} && document.querySelector('#meetingPeopleList [data-meeting-trace-id]')`, 'persisted People meeting list');
    await click(client, '#meetingPeopleList [data-meeting-trace-id]');
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.querySelector('[data-meeting-trace-detail]')`, 'minimal meeting trace without guest payload');
    const unavailableTrace = await evaluate(client, `(() => ({
      note: document.querySelector('[data-meeting-trace-detail] p:last-of-type')?.textContent.trim(),
      fullSections: document.querySelectorAll('#linkComparisonContent .link-comparison-section').length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(unavailableTrace.note.startsWith('Чужая карта целиком не сохранялась')
      && unavailableTrace.fullSections === 0 && !unavailableTrace.overflow,
      'unavailable comparison does not degrade to the minimal meeting card');
    await click(client, '[data-link-comparison-back]');
    await waitFor(client, visible('#intersectionsScreen'), 'return from minimal meeting trace');
    completed.push(`ссылка query + ручная вставка + старый hash + след встречи (${responseBundle.length} символов)`);

    const signedComparisonStorage = await evaluate(client, `Object.fromEntries(Object.entries(localStorage))`);
    await evaluate(client, `(() => {
      const saved = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      saved.selectedIds = ['vernost', 'chestnost', 'muzyka'];
      saved.customWords = [];
      saved.selectionWaves = { vernost: 1, chestnost: 1, muzyka: 1 };
      saved.wordWeights = { vernost: 1, chestnost: 1, muzyka: 1 };
      saved.waveOneIds = ['vernost', 'chestnost', 'muzyka'];
      saved.waveOneCustomIds = [];
      saved.wordSigns = { vernost: '+', chestnost: '+', muzyka: '+' };
      saved.privacyByWord = {};
      saved.ritualComplete = true;
      saved.view = 'intersections';
      localStorage.setItem('hand_compass_snapshot_v2_draft', JSON.stringify(saved));
    })()`);
    const signedComparisonLink = (guestSign, caseName) => {
      const payload = {
        f: 'hand-compass-link', v: 1, n: 'Гость',
        w: [{ i: 'predatelstvo', s: ['triggers'], g: guestSign }]
      };
      const encoded = deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
      return `http://127.0.0.1:${serverPort}/draft/index.html?signed-antonym=${caseName}&c=${encoded}`;
    };
    await client.call('Page.navigate', { url: signedComparisonLink('-', 'aligned') });
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.querySelector('[data-antonym-alignment]')`, 'aligned signed antonyms');
    const alignedAntonyms = await evaluate(client, `(() => ({
      summary: document.querySelector('[data-antonym-alignment] strong')?.textContent.trim(),
      signs: document.querySelector('[data-antonym-alignment] span')?.textContent.trim(),
      differences: document.querySelectorAll('#linkComparisonContent .link-contrast').length,
      score: Number(document.querySelector('[data-link-comparison-score]')?.dataset.linkComparisonScore),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(alignedAntonyms.summary === 'Оба против «предательство».'
      && alignedAntonyms.signs.includes('предательство — отталкивает')
      && alignedAntonyms.signs.includes('верность — тянет')
      && alignedAntonyms.differences === 0 && alignedAntonyms.score > 0 && !alignedAntonyms.overflow,
      'vernost+ vs predatelstvo- is not shown as one signed position');
    if (process.env.HAC_SMOKE_SCREENSHOT) {
      await client.call('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 1, mobile: true
      });
      await sleep(100);
      const screenshot = await client.call('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false
      });
      await writeFile(resolve(process.env.HAC_SMOKE_SCREENSHOT), Buffer.from(screenshot.data, 'base64'));
      await client.call('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 3, mobile: true
      });
    }

    await client.call('Page.navigate', { url: signedComparisonLink('+', 'opposite') });
    await waitFor(client, `${visible('#linkComparisonScreen')} && document.querySelector('#linkComparisonContent .link-contrast')`, 'opposite signed antonyms');
    const oppositeAntonyms = await evaluate(client, `(() => ({
      commonAlignment: document.querySelectorAll('[data-antonym-alignment]').length,
      pair: document.querySelector('#linkComparisonContent .link-contrast-pair')?.textContent.trim(),
      note: document.querySelector('#linkComparisonContent .link-contrast span')?.textContent.trim(),
      score: Number(document.querySelector('[data-link-comparison-score]')?.dataset.linkComparisonScore),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(oppositeAntonyms.commonAlignment === 0
      && oppositeAntonyms.pair.includes('предательство — тянет')
      && oppositeAntonyms.pair.includes('верность — тянет')
      && oppositeAntonyms.note === 'два разных полюса' && oppositeAntonyms.score === 0 && !oppositeAntonyms.overflow,
      'vernost+ vs predatelstvo+ is not shown as opposite signed positions');
    await evaluate(client, `(() => {
      localStorage.clear();
      Object.entries(${JSON.stringify(signedComparisonStorage)}).forEach(([key, value]) => localStorage.setItem(key, value));
      sessionStorage.clear();
    })()`);
    await client.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/draft/index.html?smoke=1` });
    await waitFor(client, visible('#intersectionsScreen'), 'intersections after signed-antonym cases');
    completed.push('знаки антонимов: совпадение и противоположность');

    await click(client, '[data-path-chapter="worlds"]');
    await waitFor(client, `${visible('#worldsScreen')} && document.querySelectorAll('#worldsDirectory [data-world-directory-word]').length > 0`, 'world directory');
    const worldsLead = await evaluate(client, `document.querySelector('#worldsScreen .lead').textContent.trim()`);
    assert(worldsLead === 'Нажми на слово, чтобы войти глубже.', 'word worlds still repeat the shelf explanation');
    await click(client, '#worldsDirectory [data-world-directory-word]');
    await waitFor(client, `${visible('#wordWorldScreen')} && document.querySelector('#wordWorldContent h1')`, 'word world');
    completed.push('мир слова');

    await click(client, '[data-path-chapter="forks"]');
    await waitFor(client, visible('.fork-step-situation'), 'fork situation');
    const combinedForkStep = await evaluate(client, `(() => ({
      question: document.querySelector('.fork-step-situation .fork-question')?.textContent.trim(),
      choices: document.querySelectorAll('.fork-step-situation [data-fork-action^="choose-"]').length,
      legacyButton: document.querySelectorAll('[data-fork-action="to-choice"]').length
    }))()`);
    assert(combinedForkStep.question === 'Как поступишь ты?' && combinedForkStep.choices === 2 && combinedForkStep.legacyButton === 0, 'fork scene and choices are still split across screens');
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
    await waitFor(client, `${visible('#graphIntroScreen')} || ${visible('#graphScreen')}`, 'graph entry after dilemma');
    if (await evaluate(client, visible('#graphIntroScreen'))) await click(client, '#graphIntroNextButton');
    await waitFor(client, visible('#graphScreen'), 'graph after dilemma');
    const grownRadius = await evaluate(client, `Number(document.querySelector('[data-graph-node-id="${weightCheck.weighted[0]}"] .graph-node-weight-dot')?.getAttribute('r'))`);
    assert(grownRadius > initialGraphDots[weightCheck.weighted[0]], 'personal-weight dot did not grow after dilemma');
    completed.push('развилка: сцена + выбор → правда + личный вес');

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
    const returningPersonality = await evaluate(client, `(() => {
      const tabs = [...document.querySelectorAll('#personalityTabs [data-personality-wave]')];
      const style = getComputedStyle(document.getElementById('personalityTabs'));
      const box = document.getElementById('personalityTabs').getBoundingClientRect();
      const saved = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      return {
        wave: saved.wave,
        labels: tabs.map((tab) => tab.textContent.trim()),
        active: tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.personalityWave,
        title: document.getElementById('scatterTitle').textContent.trim(),
        position: style.position,
        bottomGap: Math.round(window.innerHeight - box.bottom)
      };
    })()`);
    assert(returningPersonality.wave === 1 && returningPersonality.active === '1', 'returning personality did not open on responsive words');
    assert(returningPersonality.labels.join('|') === 'Что откликается|Что нарушает равновесие', 'returning personality tab labels are stale');
    assert(returningPersonality.title === 'Выбери слова, которые твои — которые откликаются в тебе', 'returning personality invitation is stale');
    assert(returningPersonality.position === 'fixed' && returningPersonality.bottomGap <= 16, 'returning personality tabs are not floating at the bottom');
    await click(client, '#personalityTabs [data-personality-wave="2"]');
    await waitFor(client, `document.querySelector('#personalityTabs [data-personality-wave="2"]').getAttribute('aria-selected') === 'true'`, 'personality balance tab');
    await click(client, '[data-path-chapter="map"]');
    await waitFor(client, visible('#graphScreen'), 'map after personality tab');
    await click(client, '[data-path-chapter="personality"]');
    await waitFor(client, `document.querySelector('#personalityTabs [data-personality-wave="1"]').getAttribute('aria-selected') === 'true'`, 'personality resets to first tab');
    completed.push('возврат → личность без онбординга');

    await click(client, '[data-path-chapter="forks"]');
    await waitFor(client, `${visible('#forksScreen')} && ${visible('#personalDilemmaOpen')}`, 'personal dilemma entry');
    await click(client, '#personalDilemmaOpen');
    await waitFor(client, visible('#personalDilemmaComposer'), 'personal dilemma composer');
    const softCounter = await evaluate(client, `(() => {
      const input = document.getElementById('personalDilemmaText');
      input.value = 'я'.repeat(451);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        maxLength: input.maxLength,
        text: document.getElementById('personalDilemmaCount').textContent,
        near: document.getElementById('personalDilemmaCount').classList.contains('is-near-limit')
      };
    })()`);
    assert(softCounter.maxLength === 500 && softCounter.text === '451 / 500' && softCounter.near, 'personal dilemma soft counter is broken');
    const weightsBeforePersonal = await evaluate(client, `JSON.stringify(JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft')).wordWeights)`);
    await evaluate(client, `(() => {
      const input = document.getElementById('personalDilemmaText');
      input.value = 'Мне важны честность и близость, но я устал об этом спорить.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[name="personalDilemmaMode"][value="vent"]').click();
    })()`);
    await click(client, '#personalDilemmaForm button[type="submit"]');
    const ventResult = await evaluate(client, `(() => {
      const data = JSON.parse(localStorage.getItem('hand_compass_personal_dilemmas_v1'));
      const weights = JSON.stringify(JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft')).wordWeights);
      return { count: data.items.length, mode: data.items[0].mode, outcomes: data.items[0].outcomes.length, weights };
    })()`);
    assert(ventResult.count === 1 && ventResult.mode === 'vent' && ventResult.outcomes === 0, 'vent-only personal dilemma was not saved correctly');
    assert(ventResult.weights === weightsBeforePersonal, 'vent-only personal dilemma changed word weights');

    const unselectedCandidate = await evaluate(client, `(() => {
      const state = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      const words = JSON.parse(document.getElementById('wordsData').textContent).words;
      const word = words.find((item) => !state.selectedIds.includes(item.id) && item.word.length >= 5);
      return { id: word.id, word: word.word };
    })()`);
    await evaluate(client, `(() => {
      const input = document.getElementById('personalDilemmaText');
      input.value = 'Я думаю про ' + ${JSON.stringify(unselectedCandidate.word)} + ' и не знаю, куда идти.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[name="personalDilemmaMode"][value="options"]').click();
      const options = document.querySelectorAll('[data-personal-dilemma-option]');
      options[0].value = 'Остаться и поговорить';
      options[1].value = 'Уйти и дать себе время';
      options[2].value = '';
    })()`);
    await click(client, '#personalDilemmaForm button[type="submit"]');
    const optionsResult = await evaluate(client, `(() => {
      const data = JSON.parse(localStorage.getItem('hand_compass_personal_dilemmas_v1'));
      const item = data.items.at(-1);
      const weights = JSON.stringify(JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft')).wordWeights);
      return { count: data.items.length, mode: item.mode, outcomes: item.outcomes.length, candidates: item.candidateIds, weights };
    })()`);
    assert(optionsResult.count === 2 && optionsResult.mode === 'options' && optionsResult.outcomes === 2, 'options personal dilemma was not saved correctly');
    assert(optionsResult.candidates.includes(unselectedCandidate.id), 'local dictionary analysis missed an exact word');
    assert(optionsResult.weights === weightsBeforePersonal, 'saving an options dilemma changed word weights');
    await click(client, `[data-personal-candidate-id="${unselectedCandidate.id}"]`);
    const acceptedPersonalCandidate = await evaluate(client, `(() => {
      const state = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      return { selected: state.selectedIds.includes(${JSON.stringify(unselectedCandidate.id)}), weight: state.wordWeights[${JSON.stringify(unselectedCandidate.id)}] };
    })()`);
    assert(acceptedPersonalCandidate.selected && acceptedPersonalCandidate.weight === 1, 'personal dilemma candidate did not enter the snapshot at weight 1');
    await click(client, '#personalDilemmaList [data-delete-personal-dilemma]');
    const personalCountAfterDelete = await evaluate(client, `JSON.parse(localStorage.getItem('hand_compass_personal_dilemmas_v1')).items.length`);
    assert(personalCountAfterDelete === 1, 'personal dilemma was not deleted locally');
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, `${visible('#forksScreen')} && document.querySelectorAll('#personalDilemmaList .personal-dilemma-item').length === 1`, 'personal dilemma after reload');
    completed.push('свои ситуации: оба режима · локальный разбор · удаление');

    await client.call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await click(client, '[data-path-chapter="worlds"]');
    const reducedMotionClass = await evaluate(client, `document.querySelector('.is-chapter-entering-forward, .is-chapter-entering-backward')?.className || ''`);
    assert(!reducedMotionClass, 'reduced-motion chapter change should be instant');
    completed.push('reduced motion');

    await evaluate(client, `(() => {
      const saved = JSON.parse(localStorage.getItem('hand_compass_snapshot_v2_draft'));
      const ids = JSON.parse(document.getElementById('wordsData').textContent).words.slice(0, 70).map((word) => word.id);
      saved.selectedIds = ids;
      saved.selectionWaves = Object.fromEntries(ids.map((id) => [id, 1]));
      saved.wordWeights = Object.fromEntries(ids.map((id) => [id, 1]));
      saved.waveOneIds = ids;
      saved.privacyByWord = Object.fromEntries(ids.map((id) => [id, 'on-match']));
      saved.ritualComplete = true;
      saved.view = 'intersections';
      localStorage.setItem('hand_compass_snapshot_v2_draft', JSON.stringify(saved));
    })()`);
    await client.call('Page.reload', { ignoreCache: true });
    await waitFor(client, visible('#intersectionsScreen'), 'full-snapshot link setup');
    await click(client, '#openLinkShareButton');
    await waitFor(client, visible('#linkShareScreen'), 'full-snapshot preview');
    const fullPreview = await evaluate(client, `(() => ({
      count: new Set([...document.querySelectorAll('#linkShareContent .link-preview-word')].map((node) => node.textContent.trim())).size,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`);
    assert(fullPreview.count === 70 && !fullPreview.overflow,
      `70-word link preview is incomplete or overflows at 390px (${JSON.stringify(fullPreview)})`);
    await evaluate(client, `(() => {
      const input = document.querySelector('#linkShareContent [name="nickname"]');
      input.value = 'Полная карта';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#linkShareContent [data-link-share-form]').requestSubmit();
    })()`);
    await waitFor(client, `new URL(document.querySelector('#linkShareContent .link-share-url')?.value).searchParams.has('c')`, '70-word query-link creation');
    fullSnapshotLinkLength = await evaluate(client, `document.querySelector('#linkShareContent .link-share-url').value.length`);
    completed.push(`ссылка на 70 слов: ${fullSnapshotLinkLength} символов`);

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
