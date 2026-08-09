'use strict';
/**
 * Static-structure regression tests for js/sheet.js
 *
 * These tests read the source files (never execute the browser app — no jsdom
 * installed) and assert that the required wiring patterns exist and are
 * internally consistent. Each feature maps to unique anchor snippets.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SHEET = fs.readFileSync(path.join(ROOT, 'js', 'sheet.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const HOME = fs.readFileSync(path.join(ROOT, 'js', 'home.js'), 'utf8');

const L = SHEET.split('\n'); // L[i] === line i+1

function lineOf(src, pattern, occurrence) {
    occurrence = occurrence || 1;
    const lines = src.split('\n');
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(pattern)) {
            n++;
            if (n === occurrence) return i + 1;
        }
    }
    return -1;
}

function sliceFromTo(src, startPattern, endPattern) {
    const lines = src.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(startPattern)) { start = i; break; }
    }
    if (start === -1) return { text: '', startLine: -1, endLine: -1 };
    let end = lines.length - 1;
    const re = new RegExp(endPattern);
    for (let i = start + 1; i < lines.length; i++) {
        if (re.test(lines[i])) { end = i; break; }
    }
    return { text: lines.slice(start, end + 1).join('\n'), startLine: start + 1, endLine: end + 1 };
}

function countOccurrences(text, needle) {
    let c = 0, i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
    return c;
}

// HARD GATE: syntax
test('HARD GATE: node --check js/sheet.js passes', () => {
    execFileSync(process.execPath, ['--check', 'js/sheet.js'], { cwd: ROOT });
});

// F1 — Undo survives reload
test('F1a: openFile fetches undo via api.getUndo inside Promise.all (index 3)', () => {
    const ln = lineOf(SHEET, 'api.getUndo(id)');
    assert.ok(ln > 0, 'api.getUndo(id) not found in sheet.js');
    const line = L[ln - 1];
    assert.ok(line.includes('Promise.all'), 'api.getUndo call is not inside Promise.all (line ' + ln + ')');
    assert.ok(line.includes('api.getUndo(id)]);'), 'api.getUndo must be the 4th promise so results[3] is the undo data (line ' + ln + ')');
});

test('F1b: openFileAdmin fetches undo via api.adminUndo inside Promise.all (index 3)', () => {
    const ln = lineOf(SHEET, 'api.adminUndo(id)');
    assert.ok(ln > 0, 'api.adminUndo(id) not found in sheet.js');
    const line = L[ln - 1];
    assert.ok(line.includes('Promise.all'), 'api.adminUndo call is not inside Promise.all (line ' + ln + ')');
    assert.ok(line.includes('api.adminUndo(id)]);'), 'api.adminUndo must be the 4th promise so results[3] is the undo data (line ' + ln + ')');
});

test('F1c: openFile hydrates undo/redo from results[3].undo/.redo (not hard reset)', () => {
    const undoHydrate = lineOf(SHEET, 'state.undoStack = undoData.undo || [];');
    const undoHydrate2 = lineOf(SHEET, 'state.undoStack = undoData.undo || [];', 2);
    const redoHydrate = lineOf(SHEET, 'state.redoStack = undoData.redo || [];');
    const redoHydrate2 = lineOf(SHEET, 'state.redoStack = undoData.redo || [];', 2);
    assert.ok(undoHydrate === 29, 'openFile undo hydration expected line 29, got ' + undoHydrate);
    assert.ok(redoHydrate === 30, 'openFile redo hydration expected line 30, got ' + redoHydrate);
    assert.ok(undoHydrate2 === 83, 'openFileAdmin undo hydration expected line 83, got ' + undoHydrate2);
    assert.ok(redoHydrate2 === 84, 'openFileAdmin redo hydration expected line 84, got ' + redoHydrate2);
});

test('F1d: openFile/openFileAdmin never hard-reset the stacks', () => {
    const open = sliceFromTo(SHEET, '__ss.openFile = async function(id) {', '__ss.openFileAdmin');
    assert.ok(open.startLine === 12, 'openFile body expected to start at line 12, got ' + open.startLine);
    assert.ok(!open.text.includes('state.undoStack = []'), 'openFile must not hard-reset undoStack');
    assert.ok(!open.text.includes('state.redoStack = []'), 'openFile must not hard-reset redoStack');

    const admin = sliceFromTo(SHEET, '__ss.openFileAdmin = async function(id) {', '__ss.closeSheet');
    assert.ok(admin.startLine === 68, 'openFileAdmin body expected to start at line 68, got ' + admin.startLine);
    assert.ok(!admin.text.includes('state.undoStack = []'), 'openFileAdmin must not hard-reset undoStack');
    assert.ok(!admin.text.includes('state.redoStack = []'), 'openFileAdmin must not hard-reset redoStack');
});

// F2 — Undo/redo persist
test('F2a: undo handler calls persist() in both the rows-branch and the cell path', () => {
    const h = sliceFromTo(SHEET, "dom.undoBtn.addEventListener('click', function() {", 'dom.redoBtn.addEventListener');
    assert.ok(h.startLine === 647, 'undo handler expected at line 646, got ' + h.startLine);
    const n = countOccurrences(h.text, 'persist();');
    assert.ok(n >= 2, 'undo handler must call persist() >= 2 times (rows branch + cell path); found ' + n);
});

test('F2b: redo handler calls persist() in both the rows-branch and the cell path', () => {
    const h = sliceFromTo(SHEET, "dom.redoBtn.addEventListener('click', function() {", '^\\s*\\}\\)\\s*;\\s*$');
    assert.ok(h.startLine === 679, 'redo handler expected at line 678, got ' + h.startLine);
    const n = countOccurrences(h.text, 'persist();');
    assert.ok(n >= 2, 'redo handler must call persist() >= 2 times (rows branch + cell path); found ' + n);
});

// F3 — deleteSelectedCells pushes undo before blanking
test('F3a: deleteSelectedCells calls pushUndo(rowIdx, colKey, prevVal) BEFORE blanking', () => {
    const pushIdx = SHEET.indexOf('pushUndo(rowIdx, colKey, prevVal)');
    const blankIdx = SHEET.indexOf("state.rows[rowIdx][colKey] = ''");
    assert.ok(pushIdx > 0, 'pushUndo(rowIdx, colKey, prevVal) missing in deleteSelectedCells');
    assert.ok(blankIdx > 0, "state.rows[rowIdx][colKey] = '' missing in deleteSelectedCells");
    assert.ok(pushIdx < blankIdx, 'pushUndo must be called BEFORE the cell is blanked');
});

test('F3b: pushUndo in deleteSelectedCells is guarded to non-empty cells only', () => {
    const ln = lineOf(SHEET, 'pushUndo(rowIdx, colKey, prevVal);');
    assert.ok(ln > 0, 'pushUndo call not found');
    const line = L[ln - 1];
    assert.ok(line.includes("prevVal !== ''"), 'pushUndo must be guarded by prevVal !== "" (line ' + ln + ')');
    assert.ok(ln === 1305, 'pushUndo expected at line 1304, got ' + ln);
});

// F4 — beforeunload flush
test('F4a: _persistImmediate early-returns when no file is open', () => {
    const fn = sliceFromTo(SHEET, 'async function _persistImmediate(action) {', '^}\\s*$');
    assert.ok(fn.startLine === 184, '_persistImmediate expected at line 184, got ' + fn.startLine);
    const guard = lineOf(SHEET, 'if (!state.currentFileId) return;');
    assert.ok(guard === 185, 'early-return guard expected at line 185, got ' + guard);
    assert.ok(fn.text.includes('if (!state.currentFileId) return;'), 'guard must live inside _persistImmediate');
});

test('F4b: beforeunload listener flushes dirty state via _persistImmediate', () => {
    const b = sliceFromTo(SHEET, "window.addEventListener('beforeunload', function() {", '^\\s*\\}\\)\\s*;\\s*$');
    assert.ok(b.startLine === 220, 'beforeunload listener expected at line 219, got ' + b.startLine);
    assert.ok(b.text.includes('state.currentFileId && state.isDirty'), 'beforeunload must gate on currentFileId && isDirty');
    assert.ok(b.text.includes('clearTimeout(_persistTimer)'), 'beforeunload must clear the debounce timer');
    assert.ok(b.text.includes('_persistImmediate()'), 'beforeunload must call _persistImmediate() to flush');
});

// F5 — runCheck rows-undo + handler branching
test('F5a: runCheck snapshots rows and pushes a rows undo entry', () => {
    const r = sliceFromTo(SHEET, 'async function runCheck() {', '^}\\s*$');
    assert.ok(r.startLine === 278, 'runCheck expected at line 277, got ' + r.startLine);
    assert.ok(r.text.includes('var preCheckRows = state.rows.map(function(r) { return Object.assign({}, r); });'),
        'runCheck must snapshot rows before mutating statuses');
    assert.ok(r.text.includes("state.undoStack.push({ type: 'rows', prevRows: preCheckRows });"),
        'runCheck must push a {type:"rows", prevRows} undo entry');
    assert.ok(r.text.includes('state.redoStack = [];'), 'runCheck must clear the redo stack');
    assert.ok(r.text.includes('state.undoStack.length > 100'), 'runCheck must cap the undo stack');
});

test('F5b: undo handler branches on delta.type and returns before cell-level restore', () => {
    const h = sliceFromTo(SHEET, "dom.undoBtn.addEventListener('click', function() {", 'dom.redoBtn.addEventListener');
    const t = h.text;
    const iBranch = t.indexOf("if (delta.type === 'rows') {");
    const iReturn = t.indexOf('return;', iBranch);
    const iCellRestore = t.indexOf('updateCellInPlace(delta.rowIdx, delta.colKey, delta.prevVal)');
    assert.ok(iBranch >= 0, 'undo handler missing delta.type rows branch');
    assert.ok(iReturn >= 0 && iReturn > iBranch, 'rows branch must return before reaching cell restore');
    assert.ok(iCellRestore >= 0 && iCellRestore > iReturn, 'cell-level restore must come AFTER the rows-branch return');
    assert.ok(t.includes('state.redoStack.push({ type: \'rows\', prevRows: state.rows.map(function(r) { return Object.assign({}, r); }) });'),
        'undo rows branch must push current rows onto redo stack');
    assert.ok(t.includes('renderSheet();'), 'undo rows branch must re-render the sheet');
});

test('F5c: redo handler branches on delta.type and returns before cell-level restore', () => {
    const h = sliceFromTo(SHEET, "dom.redoBtn.addEventListener('click', function() {", '^\\s*\\}\\)\\s*;\\s*$');
    const t = h.text;
    const iBranch = t.indexOf("if (delta.type === 'rows') {");
    const iReturn = t.indexOf('return;', iBranch);
    const iCellRestore = t.indexOf('updateCellInPlace(delta.rowIdx, delta.colKey, delta.prevVal)');
    assert.ok(iBranch >= 0, 'redo handler missing delta.type rows branch');
    assert.ok(iReturn >= 0 && iReturn > iBranch, 'rows branch must return before reaching cell restore');
    assert.ok(iCellRestore >= 0 && iCellRestore > iReturn, 'cell-level restore must come AFTER the rows-branch return');
});

// F6 — WA cache hydrate
test('F6a: runWaChecks calls api.getWaCache(uidArr) and reads response.cache', () => {
    const w = sliceFromTo(SHEET, 'async function runWaChecks() {', '^}\\s*$');
    assert.ok(w.startLine === 319, 'runWaChecks expected at line 318, got ' + w.startLine);
    assert.ok(w.text.includes('api.getWaCache(uidArr)'), 'runWaChecks must call api.getWaCache(uidArr)');
    assert.ok(w.text.includes('cache = (res && res.cache) || {};'), 'runWaChecks must read the cache from the response');
});

test('F6b: runWaChecks stamps eligible/ineligible cache hits and SKIPS error entries', () => {
    const w = sliceFromTo(SHEET, 'async function runWaChecks() {', '^}\\s*$');
    const fStart = w.text.indexOf('waRows = waRows.filter(function(w) {');
    assert.ok(fStart >= 0, 'cache-apply filter block missing in runWaChecks');
    const fEnd = w.text.indexOf('});', fStart) + 3;
    const f = w.text.slice(fStart, fEnd);
    assert.ok(f.includes("hit.status === 'eligible'"), 'cache filter must handle eligible hits');
    assert.ok(f.includes("hit.status === 'ineligible'"), 'cache filter must handle ineligible hits');
    assert.ok(f.includes("w.row.wa_status = 'eligible';"), 'eligible hits must be stamped wa_status=eligible');
    assert.ok(f.includes("w.row.wa_status = 'ineligible';"), 'ineligible hits must be stamped wa_status=ineligible');
    assert.ok(!f.includes("'error'"), 'error cache entries must NOT be stamped (they fall through to live check)');
    assert.ok(f.includes('return true;'), 'unmatched statuses (incl. error) must be kept for the live check');
});

test('F6c: __ss.hydrateWaCache is exported, stamps results, and never throws', () => {
    const sig = lineOf(SHEET, '__ss.hydrateWaCache = async function(rows)');
    assert.ok(sig === 405, 'hydrateWaCache export expected at line 404, got ' + sig);
    const h = sliceFromTo(SHEET, '__ss.hydrateWaCache = async function(rows) {', '^}\\s*;\\s*$');
    assert.ok(h.startLine === 405, 'hydrateWaCache body expected to start at 404, got ' + h.startLine);
    assert.ok(h.text.includes('try {'), 'hydrateWaCache must wrap its logic in try');
    assert.ok(h.text.includes('} catch(e) {}'), 'hydrateWaCache must swallow errors');
    assert.ok(h.text.includes('if (!rows || !rows.length) return;'), 'hydrateWaCache must guard empty rows');
    assert.ok(h.text.includes("typeof api.getWaCache !== 'function'"), 'hydrateWaCache must guard missing api');
    assert.ok(h.text.includes('api.getWaCache(uidArr)'), 'hydrateWaCache must call api.getWaCache(uidArr)');
    assert.ok(h.text.includes("row.wa_status = 'eligible';"), 'hydrateWaCache must stamp eligible');
    assert.ok(h.text.includes("row.wa_status = 'ineligible';"), 'hydrateWaCache must stamp ineligible');
    assert.ok(!h.text.includes("hit.status === 'error'"), 'error cache entries must be skipped by hydrateWaCache');
});

test('F6d: home.js calls __ss.hydrateWaCache(rows) matching the exported signature', () => {
    const ln = lineOf(HOME, '__ss.hydrateWaCache(rows)');
    assert.ok(ln === 605, 'home.js hydrateWaCache call expected at line 605, got ' + ln);
    const line = HOME.split('\n')[ln - 1];
    assert.ok(line.includes('window.__ss && __ss.hydrateWaCache'), 'home.js must guard the existence of the export');
    assert.ok(line.includes('await __ss.hydrateWaCache(rows)'), 'home.js must await __ss.hydrateWaCache(rows) with the rows array');
});

// F7 — every api.* referenced in sheet.js exists in js/api.js
test('F7: all api.* methods used by sheet.js are defined in js/api.js', () => {
    const used = new Set();
    const re = /\bapi\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(SHEET)) !== null) used.add(m[1]);

    const apiObjMatch = API.match(/__ss\.api\s*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(apiObjMatch, 'api.js __ss.api object literal not found');
    const apiObjBody = apiObjMatch[1];

    const missing = [];
    for (const name of used) {
        if (!new RegExp('\\b' + name + '\\s*:').test(apiObjBody)) missing.push(name);
    }
    assert.ok(used.size >= 17, 'expected at least 17 unique api.* refs in sheet.js, got ' + used.size);
    assert.deepStrictEqual(missing, [], 'api methods referenced by sheet.js but missing from api.js: ' + missing.join(', '));
});
