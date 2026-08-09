'use strict';
/**
 * Frontend contract tests: client/server API surface.
 * Verifies:
 *   1. js/api.js wrappers (method + path) match routes defined in server/index.js
 *   2. Every DOM id referenced by js/state.js exists in index.html
 *   3. index.html loads scripts (adapters/filetypes/new files) in the right order
 * Gates: node --check on js/api.js and js/state.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const apiSrc = read('js/api.js');
const stateSrc = read('js/state.js');
const serverSrc = read('server/index.js');
const htmlSrc = read('index.html');

/* ───────────────────────────── gates ───────────────────────────── */

test('gate: js/api.js parses (node --check)', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'js', 'api.js')], { stdio: 'pipe' });
});

test('gate: js/state.js parses (node --check)', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'js', 'state.js')], { stdio: 'pipe' });
});

/* ───────────────────── server route parsing ───────────────────── */

const METHOD_MAP = { get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE' };

function parseServerRoutes(src) {
  const routes = [];
  const re = /app\.(get|put|post|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const p = m[2];
    if (!p.startsWith('/api')) continue; // ignore static fallback / webhook
    routes.push({ method, path: p });
  }
  return routes;
}

const serverRoutes = parseServerRoutes(serverSrc);

/* ────────────────────── api.js wrapper parsing ────────────────────── */

function extractApiObjectBody(src) {
  const marker = '__ss.api =';
  const idx = src.indexOf(marker);
  assert.ok(idx !== -1, 'api.js: __ss.api = not found');
  const open = src.indexOf('{', idx + marker.length);
  let depth = 0;
  let inStr = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" && src[i - 1] !== '\\') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i);
    }
  }
  throw new Error('api.js: unbalanced __ss.api object literal');
}

function extractBalanced(source, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" && source[i - 1] !== '\\') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced group in api.js');
}

function firstTopLevelArg(expr) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'" && expr[i - 1] !== '\\') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return expr.slice(0, i);
  }
  return expr;
}

function parseApiWrappers(body) {
  const wrappers = [];
  const memberRe = /(\w+)\s*:\s*function\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = memberRe.exec(body)) !== null) {
    const name = m[1];
    const openBrace = m.index + m[0].lastIndexOf('{');
    const bodyEnd = extractBalanced(body, openBrace);
    const fnBody = body.slice(openBrace + 1, bodyEnd);
    const call = /return\s+(get|post|put|del)\(/.exec(fnBody);
    if (!call) continue; // e.g. cancelPending
    const method = METHOD_MAP[call[1]];
    const parenIdx = fnBody.indexOf('(', call.index);
    const argEnd = extractBalanced(fnBody, parenIdx);
    const args = fnBody.slice(parenIdx + 1, argEnd);
    const expr = firstTopLevelArg(args);
    wrappers.push({ name, method, expr });
  }
  return wrappers;
}

const apiWrappers = parseApiWrappers(extractApiObjectBody(apiSrc));

/* ─────────────── path template reconstruction ─────────────── */

// Converts a JS string-concatenation expression into a route template.
//   '/files/' + fileId + '/undo'  ->  '/files/:p/undo'
// Any non-literal chunk (param interpolation, encodeURIComponent(...), a
// ternary condition, a stray body argument) becomes ':p'.
function pathTemplateFromExpr(expr) {
  let template = '';
  let hasChunk = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== "'") j++;
      if (hasChunk) { template += ':p'; hasChunk = false; }
      template += expr.slice(i + 1, j);
      i = j;
    } else {
      hasChunk = true;
    }
  }
  if (hasChunk) template += ':p';
  return template;
}

function normalizeServerPath(p) {
  return p.replace(/:[^/]+/g, ':p');
}

// Find a server route matching an api wrapper template (method + path).
// Rule 1: param-aware regex match (api ':p' segments match server ':x').
// Rule 2: if the server route has no params, ignore stray ':p' markers in
//         the api template (covers ternaries like getCrossDups, body args).
function findMatchingServerRoute(method, tpl) {
  const pathOnly = tpl.split('?')[0];
  const candidates = serverRoutes.filter((r) => r.method === method);
  const full = '/api' + pathOnly; // api.js prefixes BASE = '/api'
  const pattern = full
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:p/g, '[^/]+');
  const re = new RegExp('^' + pattern + '$');
  for (const r of candidates) {
    const norm = normalizeServerPath(r.path);
    if (re.test(norm)) return r;
  }
  const stripped = full.replace(/:p/g, '');
  for (const r of candidates) {
    const norm = normalizeServerPath(r.path);
    if (!norm.includes(':p') && norm === stripped) return r;
  }
  return null;
}

/* ─────────────────────── contract: api → server ─────────────────────── */

// Client-side wrappers whose server routes are not implemented yet. Tracked
// explicitly (rather than silently skipped) so they surface when landed.
// All history name/fork wrappers now have server routes, so this set is empty.
const PENDING_SERVER_ROUTES = new Set([]);

test('api.js defines 49 HTTP wrappers inside __ss.api', () => {
  assert.equal(apiWrappers.length, 49,
    'expected 49 wrappers, got ' + apiWrappers.length + ': ' + apiWrappers.map((w) => w.name).join(', '));
});

test('api.js: every wrapper (method + path) has a matching server route', () => {
  const missing = [];
  const pending = [];
  for (const w of apiWrappers) {
    const tpl = pathTemplateFromExpr(w.expr);
    const hit = findMatchingServerRoute(w.method, tpl);
    if (!hit) {
      if (PENDING_SERVER_ROUTES.has(w.name)) pending.push(w.name);
      else missing.push(w.name + ' -> ' + w.method + ' ' + tpl + ' (no matching route)');
    }
  }
  assert.deepEqual(missing, [], 'wrappers without a server route:\n' + missing.join('\n'));
  assert.deepEqual(pending.sort(), [...PENDING_SERVER_ROUTES].sort(),
    'pending-route set changed — update PENDING_SERVER_ROUTES in this test');
});

test('api.js: named contract spot-checks match server routes', () => {
  const expected = {
    getUndo:           ['GET',  '/api/files/:id/undo'],
    getWaCache:        ['GET',  '/api/wa/cache'],
    adminUndo:         ['GET',  '/api/admin/file/:fileId/undo'],
    getCrossDups:      ['GET',  '/api/cross-dups'],
    waCheck:           ['POST', '/api/fb/wa-check'],
    adminFile:         ['GET',  '/api/admin/file/:fileId'],
    adminPersist:      ['PUT',  '/api/admin/file/:fileId/persist'],
    getHistory:        ['GET',  '/api/files/:id/history'],
    getVersion:        ['GET',  '/api/files/:id/history/:v'],
    restoreVersion:    ['POST', '/api/files/:id/history/:v/restore'],
    adminGetHistory:   ['GET',  '/api/admin/file/:fileId/history'],
    adminGetVersion:   ['GET',  '/api/admin/file/:fileId/history/:v'],
    adminRestoreVersion: ['POST', '/api/admin/file/:fileId/history/:v/restore'],
  };
  for (const name of Object.keys(expected)) {
    const [method, routePath] = expected[name];
    const w = apiWrappers.find((x) => x.name === name);
    assert.ok(w, 'api.js is missing wrapper: ' + name);
    const tpl = pathTemplateFromExpr(w.expr);
    const hit = findMatchingServerRoute(w.method, tpl);
    assert.ok(hit, name + ' (' + w.method + ' ' + tpl + ') has no server route');
    assert.equal(hit.path, routePath,
      name + ': expected ' + method + ' ' + routePath + ', got ' + hit.method + ' ' + hit.path + ' (api template: ' + tpl + ')');
  }
  // getUndo must hit the *user* undo endpoint (server ~448), not the admin one.
  const undo = findMatchingServerRoute('GET', pathTemplateFromExpr(apiWrappers.find((w) => w.name === 'getUndo').expr));
  assert.equal(undo.path, '/api/files/:id/undo');
  // adminUndo must hit the admin endpoint (server ~811).
  const aUndo = findMatchingServerRoute('GET', pathTemplateFromExpr(apiWrappers.find((w) => w.name === 'adminUndo').expr));
  assert.equal(aUndo.path, '/api/admin/file/:fileId/undo');
  // getWaCache builds a uids= query string.
  const wa = apiWrappers.find((w) => w.name === 'getWaCache');
  assert.match(wa.expr, /\/wa\/cache\?uids=/);
});

test('api.js: pending history name/fork wrappers target the expected client routes', () => {
  // Server routes for these are not implemented yet (tracked in
  // PENDING_SERVER_ROUTES); assert the client-side path templates so the
  // wrappers match the intended /history/:v/name|fork contract.
  const expectedClient = {
    nameVersion:      { method: 'POST', tpl: '/files/:p/history/:p/name' },
    forkVersion:      { method: 'POST', tpl: '/files/:p/history/:p/fork' },
    adminNameVersion: { method: 'POST', tpl: '/admin/file/:p/history/:p/name' },
    adminForkVersion: { method: 'POST', tpl: '/admin/file/:p/history/:p/fork' },
  };
  for (const name of Object.keys(expectedClient)) {
    const { method, tpl } = expectedClient[name];
    const w = apiWrappers.find((x) => x.name === name);
    assert.ok(w, 'api.js is missing wrapper: ' + name);
    assert.equal(w.method, method, name + ': unexpected method');
    assert.equal(pathTemplateFromExpr(w.expr), tpl, name + ': unexpected route template');
  }
});

/* ─────────────────────── contract: state.js → index.html ─────────────────────── */

function htmlIds() {
  const ids = new Set();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(htmlSrc)) !== null) ids.add(m[1]);
  return ids;
}

function stateDomRefs() {
  const m = stateSrc.match(/var ids = \[([\s\S]*?)\];/);
  assert.ok(m, 'state.js: ids array not found');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('state.js: every DOM ref id exists in index.html', () => {
  const ids = htmlIds();
  const refs = stateDomRefs();
  assert.ok(refs.length > 30, 'sanity: expected many DOM refs, got ' + refs.length);
  const missing = refs.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'DOM refs in state.js missing from index.html: ' + missing.join(', '));
});

test('state.js: new refs (menuMerge, menuVersions, versionOverlay) exist in index.html', () => {
  for (const id of ['menuMerge', 'menuVersions', 'versionOverlay']) {
    assert.ok(htmlSrc.includes('id="' + id + '"'), 'index.html is missing id="' + id + '"');
  }
});

test('index.html: menuMerge/menuVersions reuse existing sheet-more-item classes', () => {
  for (const id of ['menuMerge', 'menuVersions']) {
    const line = htmlSrc.split('\n').find((l) => l.includes('id="' + id + '"')) || '';
    assert.match(line, /class="sheet-more-item"/, id + ' must use .sheet-more-item (theme-consistent)');
    assert.doesNotMatch(line, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, id + ' must not hardcode colors');
  }
});

test('index.html: versionOverlay reuses existing modal classes (no hardcoded colors)', () => {
  const m = htmlSrc.match(/<div class="modal-overlay" id="versionOverlay">[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(m, 'versionOverlay markup not found with modal-overlay class');
  const block = m[0];
  assert.match(block, /class="modal-overlay"/);
  assert.match(block, /class="modal-box"/);
  assert.match(block, /class="modal-title"/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}\b|rgba?\(|style="/, 'versionOverlay must not hardcode colors or inline styles');
});

/* ─────────────────────── contract: index.html script order ─────────────────────── */

test('index.html: loads scripts in the right order', () => {
  const srcs = [...htmlSrc.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const expected = [
    'js/theme.js',
    'js/types.js',
    'js/api.js',
    'js/state.js',
    'js/adapters/index.js',
    'js/adapters/igcookie.js',
    'js/filetypes/index.js',
    'js/filetypes/igcookie.js',
    'js/filetypes/fbcookie.js',
    'js/home.js',
    'js/sheet.js',
    'js/app.js',
  ];
  const pos = expected.map((s) => ({ s, i: srcs.indexOf(s) }));
  for (const p of pos) {
    assert.notEqual(p.i, -1, 'script not loaded in index.html: ' + p.s);
  }
  for (let i = 1; i < pos.length; i++) {
    assert.ok(pos[i - 1].i < pos[i].i,
      'script order wrong: ' + pos[i - 1].s + ' (at ' + pos[i - 1].i + ') must come before ' + pos[i].s + ' (at ' + pos[i].i + ')');
  }
  // registry before adapter, filetype registry before behaviors, fbcookie after igcookie
  assert.ok(srcs.indexOf('js/adapters/index.js') < srcs.indexOf('js/adapters/igcookie.js'));
  assert.ok(srcs.indexOf('js/filetypes/index.js') < srcs.indexOf('js/filetypes/igcookie.js'));
  assert.ok(srcs.indexOf('js/filetypes/igcookie.js') < srcs.indexOf('js/filetypes/fbcookie.js'));
  // app.js boots last
  assert.equal(srcs.indexOf('js/app.js'), srcs.length - 1, 'app.js must be the last <script src>');
  // every referenced local script exists on disk
  for (const s of srcs.filter((x) => x.startsWith('js/'))) {
    assert.ok(fs.existsSync(path.join(ROOT, s)), 'referenced script missing on disk: ' + s);
  }
});

test('index.html: all expected filetype/adapter modules exist on disk', () => {
  const mustExist = [
    'js/adapters/index.js',
    'js/adapters/igcookie.js',
    'js/filetypes/index.js',
    'js/filetypes/igcookie.js',
    'js/filetypes/fbcookie.js',
  ];
  for (const f of mustExist) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), 'missing module: ' + f);
  }
});
