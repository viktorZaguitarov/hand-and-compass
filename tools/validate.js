#!/usr/bin/env node
'use strict';

/*
 * Data integrity check for the two versioned draft data files. It also compares
 * them structurally with their embedded copies in draft/index.html, because the
 * standalone draft intentionally has no network requests at runtime.
 */

const { readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');

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
    for (const wordId of dilemma.words) validateRequiredWordReference(ids, owner, 'words', wordId);
  }

  if (!sameJson(dictionary, embeddedWords)) fail('embedded #wordsData differs from draft/words_v3.json');
  if (!sameJson(dilemmas, embeddedDilemmas)) fail('embedded #dilemmasData differs from draft/dilemmas_v1.json');
  if (process.exitCode) return;
  process.stdout.write(`VALIDATE PASS: ${dictionary.words.length} words, ${dilemmas.length} dilemmas, embedded data matches.\n`);
}

main().catch((error) => {
  fail(error.message || String(error));
});
