#!/usr/bin/env node
'use strict';

/*
 * Data integrity check for the two versioned draft data files. It also compares
 * them structurally with their embedded copies in draft/index.html, because the
 * standalone draft intentionally has no network requests at runtime.
 */

const { readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { deflateSync, inflateSync } = require('node:zlib');

const ROOT = resolve(__dirname, '..');
const WORDS_PATH = join(ROOT, 'draft/words_v3.json');
const DILEMMAS_PATH = join(ROOT, 'draft/dilemmas_v1.json');
const DRAFT_PATH = join(ROOT, 'draft/index.html');

function fail(message) {
  process.stderr.write(`VALIDATE FAIL: ${message}\n`);
  process.exitCode = 1;
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${label} is not valid JSON (${error.message})`);
    return null;
  }
}

function embeddedJson(html, id) {
  const expression = new RegExp(`<script\\s+id="${id}"\\s+type="application/json">([\\s\\S]*?)<\\/script>`);
  const match = html.match(expression);
  if (!match) {
    fail(`draft/index.html has no embedded #${id} data block`);
    return null;
  }
  return parseJson(match[1], `embedded #${id}`);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireDraftFeature(html, expression, message) {
  if (!expression.test(html)) fail(message);
}

function functionDeclarationSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const bodyStart = source.indexOf('{', start);
  if (bodyStart < 0) return null;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

function validateLinkComparisonPrivacyFilter(draftHtml, dictionary) {
  const normalizeSource = functionDeclarationSource(draftHtml, 'normalizeLinkNickname');
  const builderSource = functionDeclarationSource(draftHtml, 'buildLinkComparisonPayload');
  if (!normalizeSource || !builderSource) {
    fail('draft has no extractable link-comparison payload builder');
    return;
  }
  try {
    const normalizeNickname = Function(`"use strict"; return (${normalizeSource});`)();
    const buildPayload = Function(
      'LINK_COMPARISON_MAX_WORDS', 'LINK_COMPARISON_FORMAT', 'LINK_COMPARISON_VERSION', 'normalizeLinkNickname',
      `"use strict"; return (${builderSource});`
    )(100, 'hand-compass-link', 1, normalizeNickname);
    const sourceState = {
      selectedIds: ['chestnost', 'blizost', 'predatelstvo'],
      privacyByWord: { blizost: 'only-me' },
      wordSigns: { chestnost: '+', blizost: '±', predatelstvo: '-' }
    };
    const shelves = [
      { id: 'values' }, { id: 'goals' }, { id: 'action' }, { id: 'foresight' },
      { id: 'stones' }, { id: 'supports' }, { id: 'triggers' }
    ];
    const payload = buildPayload(sourceState, 'Друг', dictionary.words, shelves);
    const encoded = deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64url');
    const decoded = JSON.parse(inflateSync(Buffer.from(encoded, 'base64url')).toString('utf8'));
    const encodedIds = decoded.w.map((word) => word.i);
    if (encodedIds.join('|') !== 'chestnost') {
      fail(`link payload leaked private words (${encodedIds.join(', ') || 'empty payload'})`);
    }
    if (decoded.w.some((word) => Object.keys(word).sort().join(',') !== 'g,i,s')) {
      fail('link payload exposes fields beyond word id, shelves, and sign');
    }
  } catch (error) {
    fail(`link privacy filter could not be executed (${error.message})`);
  }
}

function validateWordReference(ids, owner, field, reference) {
  if (reference === null || reference === undefined) return;
  if (typeof reference !== 'string' || !reference) {
    fail(`${owner}.${field} must be a non-empty word id or null`);
    return;
  }
  if (!ids.has(reference)) {
    fail(`${owner}.${field} references unknown word id "${reference}"`);
  }
}

function validateRequiredWordReference(ids, owner, field, reference) {
  if (typeof reference !== 'string' || !reference) {
    fail(`${owner}.${field} must be a non-empty word id`);
    return;
  }
  validateWordReference(ids, owner, field, reference);
}

function validateReferenceArray(ids, owner, field, references) {
  if (references === undefined) return;
  if (!Array.isArray(references)) {
    fail(`${owner}.${field} must be an array`);
    return;
  }
  for (const reference of references) validateWordReference(ids, owner, field, reference);
}

async function main() {
  const [wordsSource, dilemmasSource, draftHtml] = await Promise.all([
    readFile(WORDS_PATH, 'utf8'),
    readFile(DILEMMAS_PATH, 'utf8'),
    readFile(DRAFT_PATH, 'utf8')
  ]);
  const dictionary = parseJson(wordsSource, 'draft/words_v3.json');
  const dilemmas = parseJson(dilemmasSource, 'draft/dilemmas_v1.json');
  const embeddedWords = embeddedJson(draftHtml, 'wordsData');
  const embeddedDilemmas = embeddedJson(draftHtml, 'dilemmasData');
  if (!dictionary || !dilemmas || !embeddedWords || !embeddedDilemmas) return;
  if (!Array.isArray(dictionary.words)) {
    fail('draft/words_v3.json.words must be an array');
    return;
  }
  if (!Array.isArray(dilemmas)) {
    fail('draft/dilemmas_v1.json must be an array');
    return;
  }

  const ids = new Set();
  for (const word of dictionary.words) {
    if (!word || typeof word.id !== 'string' || !word.id) {
      fail('dictionary contains a word without a non-empty id');
      continue;
    }
    if (ids.has(word.id)) fail(`dictionary has duplicate word id "${word.id}"`);
    ids.add(word.id);
  }

  for (const word of dictionary.words) {
    const owner = `word:${word.id}`;
    if (word.synonyms !== undefined
      && (!Array.isArray(word.synonyms) || !word.synonyms.every((value) => typeof value === 'string' && value.trim()))) {
      fail(`${owner}.synonyms must be an array of non-empty strings when present`);
    }
    validateReferenceArray(ids, owner, 'neighbors', word.neighbors);
    validateWordReference(ids, owner, 'antonym', word.antonym);
    validateReferenceArray(ids, owner, 'activates', word.activates);
    validateWordReference(ids, owner, 'interest', word.interest);
  }

  const dilemmaIds = new Set();
  for (const dilemma of dilemmas) {
    const owner = `dilemma:${dilemma?.id || '(missing id)'}`;
    if (!dilemma || typeof dilemma.id !== 'string' || !dilemma.id) {
      fail('dilemmas contain an entry without a non-empty id');
      continue;
    }
    if (dilemmaIds.has(dilemma.id)) fail(`dilemmas have duplicate id "${dilemma.id}"`);
    dilemmaIds.add(dilemma.id);
    validateRequiredWordReference(ids, owner, 'candidateA', dilemma.candidateA);
    validateRequiredWordReference(ids, owner, 'candidateB', dilemma.candidateB);
    if (!Array.isArray(dilemma.words)) {
      fail(`${owner}.words must be an array`);
      continue;
    }
    if (new Set(dilemma.words).size !== dilemma.words.length) {
      fail(`${owner}.words must not contain duplicates`);
    }
    for (const wordId of dilemma.words) validateRequiredWordReference(ids, owner, 'words', wordId);
  }

  requireDraftFeature(draftHtml, /wordWeights:\s*\{\}/, 'draft has no personal word-weight state');
  requireDraftFeature(draftHtml, /data-personal-weight/, 'graph nodes do not expose personal weight');
  requireDraftFeature(draftHtml, /точка тем крупнее, чем чаще ты подтверждаешь слово/i, 'graph does not explain the personal-weight dot');
  if (/graphPopularityMark|graph-node-popularity/.test(draftHtml)) {
    fail('graph still exposes profile popularity instead of personal weight');
  }
  requireDraftFeature(draftHtml, /PERSONAL_DILEMMAS_STORAGE_KEY/, 'draft has no local storage for personal dilemmas');
  requireDraftFeature(draftHtml, /id="personalDilemmaText"[^>]+maxlength="500"/, 'personal dilemma text has no 500-character limit');
  requireDraftFeature(draftHtml, /value="vent"[\s\S]+value="options"/, 'personal dilemma does not offer both local modes');
  requireDraftFeature(draftHtml, /matchPersonalDilemmaWords/, 'personal dilemma has no local dictionary analysis');
  requireDraftFeature(draftHtml, /className = 'fork-question'[\s\S]+Как поступишь ты\?/, 'system dilemma does not place the question with the scene');
  if (/to-choice|fork-step-choice/.test(draftHtml)) {
    fail('system dilemma still splits scene and choice across screens');
  }
  requireDraftFeature(draftHtml, /new CompressionStream\('deflate'\)/, 'link comparison does not use deflate compression');
  requireDraftFeature(draftHtml, /new DecompressionStream\('deflate'\)/, 'link comparison cannot open deflate payloads');
  requireDraftFeature(draftHtml, /url\.searchParams\.set\(LINK_COMPARISON_QUERY_KEY, encoded\)/,
    'new link comparison data is not placed in the query');
  requireDraftFeature(draftHtml, /rawHash\.startsWith\(LINK_COMPARISON_HASH_PREFIX\)/,
    'legacy hash comparison links are no longer supported');
  requireDraftFeature(draftHtml, /function linkComparisonEncodedFromText/,
    'link comparison has no parser for a pasted message');
  requireDraftFeature(draftHtml, /Вставь ссылку или сообщение целиком/,
    'link invitation has no manual paste fallback');
  requireDraftFeature(draftHtml, /!payload\.w\.length/, 'empty link-comparison payload is not rejected');
  requireDraftFeature(draftHtml, /Ссылка не дошла целиком\./, 'truncated link has no honest error screen');
  requireDraftFeature(draftHtml, /text: `\$\{nickname\} приглашает тебя сравнить карты\.\\n\$\{url\}`/,
    'system share does not carry the full comparison URL in text');
  requireDraftFeature(draftHtml, /приглашает тебя сравнить карты/, 'link recipient has no invitation screen');
  requireDraftFeature(draftHtml, /function weightedSimilarityBetween/, 'friend comparison does not reuse weighted Jaccard');
  requireDraftFeature(draftHtml, /Что вас связывает[\s\S]+Где вы разные[\s\S]+О чём спросить/, 'friend comparison has an incomplete structure');
  requireDraftFeature(draftHtml, /dataset\.linkComparisonReply/, 'friend comparison has no reverse-link action');
  requireDraftFeature(draftHtml, /MEETING_TRACES_STORAGE_KEY\s*=\s*'hand_compass_meeting_traces_v1'/,
    'friend comparison has no local meeting-trace storage');
  requireDraftFeature(draftHtml, /id="meetingPeopleList"/, 'intersections have no People meeting list');
  requireDraftFeature(draftHtml, /function rememberLinkMeeting\([\s\S]+commonWordIds/,
    'viewing a friend comparison does not save a minimal meeting trace');
  requireDraftFeature(draftHtml, /Чужая карта целиком не сохранялась/,
    'meeting trace does not explain why the full comparison may be unavailable');
  if (/localStorage\.setItem\(MEETING_TRACES_STORAGE_KEY,\s*JSON\.stringify\(linkGuest\)/.test(draftHtml)) {
    fail('meeting traces persist the full guest map');
  }
  validateLinkComparisonPrivacyFilter(draftHtml, dictionary);

  if (!sameJson(dictionary, embeddedWords)) fail('embedded #wordsData differs from draft/words_v3.json');
  if (!sameJson(dilemmas, embeddedDilemmas)) fail('embedded #dilemmasData differs from draft/dilemmas_v1.json');
  if (process.exitCode) return;
  process.stdout.write(`VALIDATE PASS: ${dictionary.words.length} words, ${dilemmas.length} dilemmas, embedded data matches.\n`);
}

main().catch((error) => {
  fail(error.message || String(error));
});
