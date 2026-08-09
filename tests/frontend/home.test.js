'use strict';
/**
 * Frontend static-structure tests for js/home.js (no jsdom).
 * Verifies via source reading:
 *   1. resetCrossDupCounts() is wired inside all 5 mutation sites:
 *      deleteSelectedFiles, deleteFile, batchDelete, createFile, import handler.
 *   2. Import handler calls __ss.hydrateWaCache(rows) (matching the export in
 *      js/sheet.js), after rows are built and before persist, wrapped in
 *      try/catch so hydration can never break the import.
 *   3. resetCrossDupCounts() body actually resets state.crossDupCounts.
 * Gate: node --check js/home.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME_PATH = path.join(ROOT, 'js', 'home.js');
const SHEET_PATH = path.join(ROOT, 'js', 'sheet.js');

const homeSrc = fs.readFileSync(HOME_PATH, 'utf8');
const sheetSrc = fs.readFileSync(SHEET_PATH, 'utf8');

/* ─────────────────────────── gate ─────────────────────────── */

test('gate: js/home.js parses (node --check)', () => {
  execFileSync(process.execPath, ['--check', HOME_PATH], { stdio: 'pipe' });
});

/* ──────────────────────── helpers ──────────────────────── */

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

// From an opening `{`, return the balanced block { start, end, body },
// skipping string literals, template literals, // and /* */ comments.
function findBraceBlock(src, open) {
  let depth = 0;
  let inStr = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start: open, end: i, body: src.slice(open + 1, i) };
    }
  }
  throw new Error('unbalanced braces from ' + open);
}

// Find a function/assignment by marker regex, return its body + start line.
function getFunctionBody(src, markerRegex) {
  const m = new RegExp(markerRegex).exec(src);
  assert.ok(m, 'marker not found: ' + markerRegex);
  const open = src.indexOf('{', m.index + m[0].length);
  assert.ok(open !== -1, 'no opening brace after marker: ' + markerRegex);
  const block = findBraceBlock(src, open);
  return { body: block.body, startLine: lineOf(src, m.index) };
}

const IMPORT_MARKER = "dom\\.xlsxFileInputHome\\.addEventListener\\(['\"]change['\"]\\s*,\\s*async function\\s*\\(\\s*e\\s*\\)";

/* ─────────────── feature 1: resetCrossDupCounts sites ─────────────── */

const MUTATION_SITES = [
  { name: 'deleteSelectedFiles', marker: 'async function deleteSelectedFiles\\s*\\(\\s*\\)' },
  { name: 'deleteFile', marker: '__ss\\.deleteFile\\s*=\\s*async function\\s*\\(\\s*id\\s*\\)' },
  { name: 'batchDelete (archive selection delete)', marker: 'dom\\.archiveSelDelete\\.addEventListener\\([\'"]click[\'"]\\s*,\\s*async function\\s*\\(\\s*\\)' },
  { name: 'createFile', marker: '__ss\\.createFile\\s*=\\s*async function\\s*\\(\\s*typeKey\\s*\\)' },
  { name: 'import handler (xlsx upload)', marker: IMPORT_MARKER },
];

for (const site of MUTATION_SITES) {
  test('resetCrossDupCounts wired in ' + site.name, () => {
    const { body, startLine } = getFunctionBody(homeSrc, site.marker);
    assert.match(body, /(?:__ss\.)?resetCrossDupCounts\s*\(\s*\)/,
      site.name + ' (line ' + startLine + ') does not call resetCrossDupCounts()');
  });
}

test('resetCrossDupCounts appears 6 times in home.js (1 definition + 5 call sites)', () => {
  const count = (homeSrc.match(/resetCrossDupCounts/g) || []).length;
  assert.equal(count, 6, 'expected 6 occurrences, got ' + count);
});

/* ─────────────── feature 2: WA cache hydration at import ─────────────── */

test('import handler calls __ss.hydrateWaCache(rows) after rows built, before persist', () => {
  const { body, startLine } = getFunctionBody(homeSrc, IMPORT_MARKER);

  const callIdx = body.indexOf('__ss.hydrateWaCache(rows)');
  assert.notEqual(callIdx, -1,
    'import handler (line ' + startLine + ') is missing __ss.hydrateWaCache(rows)');

  const rowsDecl = body.indexOf('var rows = []');
  assert.notEqual(rowsDecl, -1, 'import handler must build a rows array');
  assert.ok(rowsDecl < callIdx, 'hydrateWaCache must run after rows are built');

  const persistIdx = body.indexOf('api.persist(');
  assert.notEqual(persistIdx, -1, 'import handler must call api.persist');
  assert.ok(callIdx < persistIdx, 'hydrateWaCache must run before persist');
});

test('hydrateWaCache call is wrapped in try/catch so hydration never breaks import', () => {
  const { body } = getFunctionBody(homeSrc, IMPORT_MARKER);
  const callIdx = body.indexOf('__ss.hydrateWaCache(rows)');
  assert.notEqual(callIdx, -1, 'hydrateWaCache call not found');
  const before = body.slice(Math.max(0, callIdx - 100), callIdx);
  const after = body.slice(callIdx, callIdx + 150);
  assert.match(before, /try\s*\{/, 'no try { immediately before hydrateWaCache call');
  assert.match(after, /catch\s*\(\s*e\s*\)\s*\{\s*\}/, 'no catch (e) {} after hydrateWaCache call');
});

test('js/sheet.js exports __ss.hydrateWaCache(rows) — name matches home.js call', () => {
  const m = sheetSrc.match(/__ss\.hydrateWaCache\s*=\s*async function\s*\(\s*rows\s*\)/);
  assert.ok(m, 'sheet.js must export __ss.hydrateWaCache = async function(rows)');
  // The implementation consumes row.uid / row.cookies; home.js rows must carry
  // those keys for fb_cookie imports (columns: cookies, twofakey, uid).
  assert.match(sheetSrc, /row\.uid/, 'sheet.js hydrateWaCache must read row.uid');
  assert.match(sheetSrc, /row\.cookies/, 'sheet.js hydrateWaCache must read row.cookies');
});

test('import builds column-keyed row objects with uid/cookies for fb_cookie (shape match)', () => {
  const { body } = getFunctionBody(homeSrc, IMPORT_MARKER);
  // Rows are built as { [column.key]: String(value) } objects.
  assert.match(body, /row\[cm\.key\]\s*=\s*String\(val\)/,
    'import must build rows as { key: value } objects (shape hydrateWaCache expects)');
  // fb_cookie uid back-fill from cookies exists, so rows carry cookies + uid.
  assert.match(body, /typeKey\s*===\s*'fb_cookie'/, 'import must special-case fb_cookie rows');
  assert.match(body, /r\.cookies\.match\(\/c_user=\(\\d\+\)\/\)/,
    'fb_cookie uid extraction from cookies must be present');
});

/* ─────────────── feature 3: resetCrossDupCounts body ─────────────── */

test('resetCrossDupCounts body actually resets state.crossDupCounts (not a no-op)', () => {
  const { body, startLine } = getFunctionBody(homeSrc, 'function\\s+resetCrossDupCounts\\s*\\(\\s*\\)');
  assert.match(body, /state\.crossDupCounts\s*=\s*(null|\{\}|false|0|undefined)/,
    'resetCrossDupCounts (line ' + startLine + ') body must reset state.crossDupCounts, got: "' + body.trim() + '"');
});

