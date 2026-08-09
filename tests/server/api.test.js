const test = require('node:test');
const assert = require('node:assert');
const h = require('../helpers');

const USER = '999001';
const ADMIN = h.ADMIN_ID;

// Helpers
let fileCounter = 0;
function nextId() { return 'ft' + Date.now() + '_' + (++fileCounter); }

async function createFile(sessionId, id, name) {
  const res = await h.req('POST', '/api/files', { sessionId, body: { id, name: name || id, type: 'ig_cookie', columns: [{ key: 'username' }, { key: 'password' }, { key: 'twofa' }] } });
  assert.strictEqual(res.status, 200, 'POST /api/files: ' + JSON.stringify(res.json));
  return res.json;
}

async function seedData(id, { rows, undo, redo, sync, hist } = {}) {
  const r = h.mainRedis();
  if (rows !== undefined) await r.set('ss:rows:' + id, JSON.stringify(rows));
  if (undo !== undefined) await r.set('ss:undo:' + id, JSON.stringify(undo));
  if (redo !== undefined) await r.set('ss:redo:' + id, JSON.stringify(redo));
  if (sync !== undefined) await r.set('ss:sync:' + id, JSON.stringify(sync));
  await r.set('ss:logs:' + id, JSON.stringify([]));
  await r.set('ss:hist:' + id, JSON.stringify([]));
}

async function keysFor(id) {
  const r = h.mainRedis();
  return {
    rows: await r.exists('ss:rows:' + id),
    undo: await r.exists('ss:undo:' + id),
    redo: await r.exists('ss:redo:' + id),
    sync: await r.exists('ss:sync:' + id),
    logs: await r.exists('ss:logs:' + id),
    hist: await r.exists('ss:hist:' + id),
  };
}

async function archiveFile(sessionId, id) {
  const res = await h.req('DELETE', '/api/files/' + id, { sessionId });
  assert.strictEqual(res.status, 200, 'DELETE /api/files: ' + JSON.stringify(res.json));
  return res.json;
}

async function permanentDelete(sessionId, id) {
  const res = await h.req('DELETE', '/api/archive/' + id, { sessionId });
  return res;
}

// ─────────────────────────────────────────────────────────────
test('AUTH: createSession + health', async () => {
  const sessionId = await h.createSession(USER);
  assert.ok(sessionId, 'session created');
  const r = await h.req('GET', '/api/files', { sessionId });
  assert.strictEqual(r.status, 200, 'GET /api/files authed');
});

test('UNAUTH: /api/files returns 401 without session', async () => {
  const r = await h.req('GET', '/api/files');
  assert.strictEqual(r.status, 401);
});

// ─────────────────────────────────────────────────────────────
test('UNDO GET: returns undo/redo arrays', async () => {
  const sessionId = await h.createSession(USER);
  const id = nextId();
  await createFile(sessionId, id, 'undo-test');
  await seedData(id, { undo: [{ type: 'cell', row: 0, col: 'password', prev: 'a' }], redo: [{ type: 'cell', row: 1, col: 'password', prev: 'b' }] });

  const r = await h.req('GET', '/api/files/' + id + '/undo', { sessionId });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.undo), 'undo is array');
  assert.ok(Array.isArray(r.json.redo), 'redo is array');
  assert.strictEqual(r.json.undo.length, 1);
  assert.strictEqual(r.json.redo.length, 1);
  assert.strictEqual(r.json.undo[0].type, 'cell');
});

test('UNDO GET: admin mirror route works', async () => {
  const adminSession = await h.createSession(ADMIN);
  const sessionId = await h.createSession(USER);
  const id = nextId();
  await createFile(sessionId, id, 'admin-undo');
  await seedData(id, { undo: [{ type: 'cell', row: 0, col: 'twofa', prev: 'x' }] });

  const r = await h.req('GET', '/api/admin/file/' + id + '/undo', { sessionId: adminSession });
  assert.strictEqual(r.status, 200, 'admin undo route');
  assert.ok(Array.isArray(r.json.undo));
  assert.strictEqual(r.json.undo.length, 1);
});

test('UNDO GET: non-owner cannot read undo', async () => {
  const owner = await h.createSession(USER);
  const other = await h.createSession('999002');
  const id = nextId();
  await createFile(owner, id, 'no-access');
  await seedData(id, { undo: [{ type: 'cell', row: 0, col: 'username', prev: 'q' }] });

  const r = await h.req('GET', '/api/files/' + id + '/undo', { sessionId: other });
  assert.ok(r.status === 403 || r.status === 401 || r.status === 404, 'expected 403/401/404, got ' + r.status);
});

// ─────────────────────────────────────────────────────────────
test('PERSIST: sets ss:meta:dirty timestamp (user)', async () => {
  const sessionId = await h.createSession(USER);
  const id = nextId();
  await createFile(sessionId, id, 'dirty-user');
  const before = Date.now();
  const res = await h.req('PUT', '/api/files/' + id + '/persist', { sessionId, body: { rows: [{ username: 'u1' }], undo: [], redo: [] } });
  assert.strictEqual(res.status, 200, 'persist: ' + JSON.stringify(res.json));

  const dirtyVal = await h.mainRedis().get('ss:meta:dirty');
  assert.ok(dirtyVal, 'ss:meta:dirty exists');
  assert.ok(parseInt(dirtyVal, 10) >= before - 1000, 'dirty is fresh timestamp');
});

test('PERSIST: sets ss:meta:dirty timestamp (admin)', async () => {
  const adminSession = await h.createSession(ADMIN);
  const sessionId = await h.createSession(USER);
  const id = nextId();
  await createFile(sessionId, id, 'dirty-admin');
  const before = Date.now();
  const res = await h.req('PUT', '/api/admin/file/' + id + '/persist', { sessionId: adminSession, body: { rows: [{ username: 'a1' }], userId: USER } });
  assert.strictEqual(res.status, 200, 'admin persist: ' + JSON.stringify(res.json));

  const dirtyVal = await h.mainRedis().get('ss:meta:dirty');
  assert.ok(dirtyVal, 'ss:meta:dirty exists');
  assert.ok(parseInt(dirtyVal, 10) >= before - 1000, 'dirty is fresh timestamp');
});

// ─────────────────────────────────────────────────────────────
test('PERM-DELETE prefix bug: id 7 delete does not touch id 70 (user endpoint)', async () => {
  const sessionId = await h.createSession(USER);
  const small = 'prefix7';
  const big = 'prefix70';
  await createFile(sessionId, small, 'small');
  await createFile(sessionId, big, 'big');
  await seedData(small, { rows: [{ username: 's' }], undo: [{ type: 'cell', row: 0, col: 'username', prev: 's' }], redo: [], sync: { enabled: true } });
  await seedData(big, { rows: [{ username: 'b' }], undo: [{ type: 'cell', row: 0, col: 'username', prev: 'b' }], redo: [], sync: { enabled: true } });

  await archiveFile(sessionId, small);
  const del = await permanentDelete(sessionId, small);
  assert.strictEqual(del.status, 200, 'permanent delete: ' + JSON.stringify(del.json));

  const smallKeys = await keysFor(small);
  const bigKeys = await keysFor(big);

  // small must be fully gone
  assert.strictEqual(smallKeys.rows, 0, 'small rows gone');
  assert.strictEqual(smallKeys.undo, 0, 'small undo gone');
  assert.strictEqual(smallKeys.redo, 0, 'small redo gone');
  assert.strictEqual(smallKeys.sync, 0, 'small sync gone');
  assert.strictEqual(smallKeys.logs, 0, 'small logs gone');
  assert.strictEqual(smallKeys.hist, 0, 'small hist gone');

  // big (prefix-superset) must be fully intact
  assert.strictEqual(bigKeys.rows, 1, 'big rows intact');
  assert.strictEqual(bigKeys.undo, 1, 'big undo intact');
  assert.strictEqual(bigKeys.redo, 1, 'big redo intact');
  assert.strictEqual(bigKeys.sync, 1, 'big sync intact');
  assert.strictEqual(bigKeys.logs, 1, 'big logs intact');
  assert.strictEqual(bigKeys.hist, 1, 'big hist intact');

  // cleanup
  await archiveFile(sessionId, big);
  await permanentDelete(sessionId, big);
});

test('PERM-DELETE prefix bug: id 7 delete does not touch id 70 (batch endpoint)', async () => {
  const sessionId = await h.createSession(USER);
  const small = 'b7';
  const big = 'b70';
  await createFile(sessionId, small, 'small');
  await createFile(sessionId, big, 'big');
  await seedData(small, { rows: [{ username: 's' }] });
  await seedData(big, { rows: [{ username: 'b' }] });

  await archiveFile(sessionId, small);
  await archiveFile(sessionId, big);
  const res = await h.req('POST', '/api/archive/batch-delete', { sessionId, body: { ids: [small] } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.deleted, 1);

  assert.strictEqual((await keysFor(small)).rows, 0, 'small rows gone (batch)');
  assert.strictEqual((await keysFor(small)).hist, 0, 'small hist gone (batch)');
  assert.strictEqual((await keysFor(big)).rows, 1, 'big rows intact (batch)');
  assert.strictEqual((await keysFor(big)).hist, 1, 'big hist intact (batch)');

  await permanentDelete(sessionId, big);
});

test('PERM-DELETE prefix bug: admin delete endpoint', async () => {
  const adminSession = await h.createSession(ADMIN);
  const sessionId = await h.createSession(USER);
  const small = 'ad7';
  const big = 'ad70';
  await createFile(sessionId, small, 'small');
  await createFile(sessionId, big, 'big');
  await seedData(small, { rows: [{ username: 's' }] });
  await seedData(big, { rows: [{ username: 'b' }] });

  const res = await h.req('DELETE', '/api/admin/file/' + small, { sessionId: adminSession });
  assert.strictEqual(res.status, 200, 'admin delete: ' + JSON.stringify(res.json));

  assert.strictEqual((await keysFor(small)).rows, 0, 'small rows gone (admin)');
  assert.strictEqual((await keysFor(small)).hist, 0, 'small hist gone (admin)');
  assert.strictEqual((await keysFor(big)).rows, 1, 'big rows intact (admin)');
  assert.strictEqual((await keysFor(big)).hist, 1, 'big hist intact (admin)');

  await permanentDelete(sessionId, big);
});

// ─────────────────────────────────────────────────────────────
test('WA CACHE: seeded cache entry appears in /api/wa/cache', async () => {
  const sessionId = await h.createSession(USER);
  const uid = '1000' + Date.now();
  const r = h.mainRedis();
  await r.set('ss:wa:' + uid, JSON.stringify({ status: 'eligible', banReason: null, error: null, ts: Date.now(), checkedAt: Date.now() }));

  const res = await h.req('GET', '/api/wa/cache?uids=' + uid, { sessionId });
  assert.strictEqual(res.status, 200);
  assert.ok(res.json.cache, 'cache object present');
  assert.strictEqual(res.json.cache[uid].status, 'eligible', 'seeded status returned');
});

test('WA CACHE: missing uid returns empty cache entry', async () => {
  const sessionId = await h.createSession(USER);
  const res = await h.req('GET', '/api/wa/cache?uids=999999999999999999', { sessionId });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.json.cache, {}, 'no stale entry');
});
