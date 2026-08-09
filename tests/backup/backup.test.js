'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const DST_URL = 'redis://127.0.0.1:6400';
const BAD_URL = 'redis://127.0.0.1:9';

// ---------------------------------------------------------------------------
// Child-process harness.
//
// backup.js keeps module-level state (_backupRedis, _lastKeyCount) and reads
// process.env.REDIS_BACKUP_URL from getBackupRedis() at call time. ioredis
// sockets also keep the event loop alive, so every scenario runs in its own
// child that force-exits (clean socket teardown, isolated module state).
// ---------------------------------------------------------------------------

function makeEnv(overrides) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(overrides || {})) {
    const v = overrides[k];
    if (v === null || v === undefined) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

function runChild(script, env) {
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 4 * 1024 * 1024,
  });
  let result = null;
  if (r.stdout) {
    const m = r.stdout.match(/RESULT (\{[\s\S]*\})/);
    if (m) {
      try {
        result = JSON.parse(m[1]);
      } catch (e) {
        result = { parseError: String((e && e.message) || e) };
      }
    }
  }
  return {
    status: r.status,
    signal: r.signal,
    spawnError: r.error ? r.error.message : null,
    stdout: r.stdout,
    stderr: r.stderr,
    result,
  };
}

// Shared scaffold. __BODY__ is replaced per scenario.
const PRELUDE = `
const Redis = require('ioredis');
const backup = require('./server/backup.js');
const src = new Redis({ port: 6399, host: '127.0.0.1', lazyConnect: true });
const dst = new Redis({ port: 6400, host: '127.0.0.1', lazyConnect: true });
async function cleanTestKeys() {
  let cur = '0';
  do {
    const r = await src.scan(cur, 'MATCH', 'ss:tbtest:*', 'COUNT', 500);
    cur = r[0];
    if (r[1].length) await src.del(r[1]);
  } while (cur !== '0');
  await src.del('ss:meta:dirty');
}
function out(o) { process.stdout.write('RESULT ' + JSON.stringify(o) + '\\n'); }
(async () => {
  await src.connect();
  await dst.connect();
  await cleanTestKeys();
  __BODY__
})().catch(function (e) { console.error('CHILD_ERROR', (e && e.stack) || e); process.exit(1); });
`;

// ---------------------------------------------------------------------------
// Scenario 1: no dirty marker + _lastKeyCount !== null  ->  returns 0, no copy
// ---------------------------------------------------------------------------
const T1_RETURNS_ZERO = `
  await dst.flushdb();
  await src.set('ss:tbtest:1', 'v1');
  await src.set('ss:tbtest:2', 'v2');
  await src.set('ss:meta:dirty', 'warmup');
  // Warm-up pass: dirty marker present -> full copy, marker deleted, _lastKeyCount set.
  const ret1 = await backup.createBackup(src);
  const markerAfterWarmup = await src.get('ss:meta:dirty');
  const destHas1 = await dst.get('ss:tbtest:1');
  // Remove a key from dest to PROVE the second pass copies nothing.
  await dst.del('ss:tbtest:1');
  const ret2 = await backup.createBackup(src);
  const dest1After = await dst.get('ss:tbtest:1');
  const markerAfter2 = await src.get('ss:meta:dirty');
  const ok = typeof ret1 === 'number' && ret1 >= 2 &&
             markerAfterWarmup === null && destHas1 === 'v1' &&
             ret2 === 0 && dest1After === null && markerAfter2 === null;
  out({ ok, ret1, markerAfterWarmup, destHas1, ret2, dest1After, markerAfter2 });
  if (!ok) process.exit(1);
  await cleanTestKeys();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 2: dirty marker present -> copies 4 typed keys, then deletes marker
// ---------------------------------------------------------------------------
const T2_TYPED_KEYS = `
  await dst.flushdb();
  await src.set('ss:tbtest:1', 'hello');
  await src.rpush('ss:tbtest:2', 'a', 'b', 'c');
  await src.hset('ss:tbtest:3', 'f1', 'v1', 'f2', 'v2');
  await src.sadd('ss:tbtest:4', 'x', 'y', 'z');
  await src.set('ss:meta:dirty', 'dirty-2');
  const ret = await backup.createBackup(src);
  const s1 = await dst.get('ss:tbtest:1');
  const l2 = await dst.lrange('ss:tbtest:2', 0, -1);
  const h3 = await dst.hgetall('ss:tbtest:3');
  const m4 = (await dst.smembers('ss:tbtest:4')).sort();
  const marker = await src.get('ss:meta:dirty');
  const ok = typeof ret === 'number' && ret >= 4 &&
             s1 === 'hello' &&
             l2.length === 3 && l2[0] === 'a' && l2[2] === 'c' &&
             h3.f1 === 'v1' && h3.f2 === 'v2' &&
             m4.length === 3 && m4.indexOf('x') !== -1 && m4.indexOf('y') !== -1 && m4.indexOf('z') !== -1 &&
             marker === null;
  out({ ok, ret, s1, l2, h3, m4, marker });
  if (!ok) process.exit(1);
  await cleanTestKeys();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 3: race - new key + marker update land MID-COPY; marker must survive
// ---------------------------------------------------------------------------
const T3_RACE = `
  await dst.flushdb();
  const pipe = src.pipeline();
  for (let i = 0; i < 2000; i++) { pipe.set('ss:tbtest:race:' + i, 'v' + i); }
  await pipe.exec();
  await src.set('ss:meta:dirty', 'race-start');
  const p = backup.createBackup(src);
  // Deterministic mid-copy write. A fixed setTimeout is racy: on the module's
  // FIRST createBackup call its lazy dest client must still connect(), and if
  // that takes longer than the timer the write lands BEFORE the copy's start
  // read of ss:meta:dirty (module then sees dirty === dirtyAfter and correctly
  // deletes the marker - no *new* write during copy). So instead we wait until
  // the copy is provably in flight (first race key visible on dest), then write
  // a brand-new key AND bump the dirty marker to a new value.
  (async function () {
    let started = false;
    for (let i = 0; i < 6000 && !started; i++) {
      started = !!(await dst.get('ss:tbtest:race:0'));
      if (!started) await new Promise(function (r) { setTimeout(r, 10); });
    }
    if (!started) throw new Error('copy never started - cannot run race scenario');
    await src.set('ss:tbtest:race:late', 'late-value');
    await src.set('ss:meta:dirty', 'race-changed');
  })();
  const ret = await p;
  const marker = await src.get('ss:meta:dirty');
  const lateOnSource = await src.get('ss:tbtest:race:late');
  // A second pass must now re-sync (proving the survived marker triggers it),
  // copy the late key, and then delete the marker.
  const ret2 = await backup.createBackup(src);
  const lateOnDest = await dst.get('ss:tbtest:race:late');
  const marker2 = await src.get('ss:meta:dirty');
  const ok = typeof ret === 'number' && ret >= 2000 &&
             marker === 'race-changed' &&
             lateOnSource === 'late-value' &&
             typeof ret2 === 'number' && ret2 >= 1 &&
             lateOnDest === 'late-value' &&
             marker2 === null;
  out({ ok, ret, marker, lateOnSource, ret2, lateOnDest, marker2 });
  if (!ok) process.exit(1);
  await cleanTestKeys();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 4a: no REDIS_BACKUP_URL  ->  createBackup returns -1
// ---------------------------------------------------------------------------
const T4A_NO_ENV = `
  await src.set('ss:tbtest:1', 'v1');
  await src.set('ss:meta:dirty', 'dirty');
  const ret = await backup.createBackup(src);
  const marker = await src.get('ss:meta:dirty');
  const ok = ret === -1 && marker === 'dirty';
  out({ ok, ret, marker });
  if (!ok) process.exit(1);
  await cleanTestKeys();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 4b: REDIS_BACKUP_URL points at a closed port  ->  -1, marker kept
// ---------------------------------------------------------------------------
const T4B_BAD_URL = `
  await src.set('ss:tbtest:1', 'v1');
  await src.set('ss:meta:dirty', 'dirty');
  const ret = await backup.createBackup(src);
  const marker = await src.get('ss:meta:dirty');
  const ok = ret === -1 && marker === 'dirty';
  out({ ok, ret, marker });
  if (!ok) process.exit(1);
  await cleanTestKeys();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 4c: dest connects but every copy command fails (fake RESP server)
// -> copyKeys reports errors > 0 -> createBackup returns count and KEEPS marker
// ---------------------------------------------------------------------------
const T4C_COPY_FAILS = `
  const net = require('net');
  function tryParseRESP(buf) {
    let offset = 0;
    if (buf[offset] !== 42) return null;
    let i = offset + 1;
    let le = buf.indexOf('\\r\\n', i);
    if (le === -1) return null;
    const count = parseInt(buf.slice(i, le).toString(), 10);
    if (isNaN(count) || count < 0) return null;
    offset = le + 2;
    const parts = [];
    for (let n = 0; n < count; n++) {
      if (buf[offset] !== 36) return null;
      le = buf.indexOf('\\r\\n', offset);
      if (le === -1) return null;
      const len = parseInt(buf.slice(offset + 1, le).toString(), 10);
      if (len < 0) return null;
      offset = le + 2;
      if (buf.length < offset + len + 2) return null;
      parts.push(buf.slice(offset, offset + len).toString());
      offset = offset + len + 2;
    }
    return { length: offset, cmd: parts[0].toUpperCase() };
  }
  const server = net.createServer(function (sock) {
    let buf = Buffer.alloc(0);
    sock.on('data', function (c) {
      buf = Buffer.concat([buf, c]);
      let p2;
      while ((p2 = tryParseRESP(buf))) {
        buf = buf.slice(p2.length);
        sock.write(p2.cmd === 'INFO' ? '+loading:0\\r\\n' : '-ERR simulated\\r\\n');
      }
    });
    sock.on('error', function () {});
  });
  await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
  process.env.REDIS_BACKUP_URL = 'redis://127.0.0.1:' + server.address().port;
  await src.set('ss:tbtest:1', 'v1');
  await src.set('ss:meta:dirty', 'dirty-4c');
  const ret = await backup.createBackup(src);
  const marker = await src.get('ss:meta:dirty');
  const ok = typeof ret === 'number' && ret === 0 && marker === 'dirty-4c';
  out({ ok, ret, marker });
  server.close();
  if (!ok) process.exit(1);
  await cleanTestKeys();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 5a: restore with an EMPTY backup source -> false (backupCount===0)
// Uses :6400 as both the (empty) main redis and the (empty) backup source.
// ---------------------------------------------------------------------------
const T5A_RESTORE_EMPTY = `
  await dst.flushdb();
  const emptyRet = await backup.restoreFromBackup(dst);
  const ok = emptyRet === false;
  out({ ok, emptyRet });
  if (!ok) process.exit(1);
  await dst.flushdb();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 5b: restore with a NON-EMPTY backup source -> true, data copied.
// :6400 is the empty main redis (flushed, dbsize 0); :6399 is the backup
// source via REDIS_BACKUP_URL. seed ss:tbtest:r1 on :6399 and verify it lands
// on :6400. (restore copies all ss:* keys - the live app keys land on :6400
// too, which scenario 6 flushes.)
// ---------------------------------------------------------------------------
const T5B_RESTORE_FULL = `
  await dst.flushdb();
  await src.set('ss:tbtest:r1', 'restored');
  const fullRet = await backup.restoreFromBackup(dst);
  const restored = await dst.get('ss:tbtest:r1');
  const ok = typeof fullRet === 'boolean' && fullRet === true && restored === 'restored';
  out({ ok, fullRet, restored });
  if (!ok) process.exit(1);
  await dst.flushdb();
  await src.del('ss:tbtest:r1');
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 5c: main redis not empty (>3 keys) -> refuses to restore, false.
// :6400 seeded with 4 keys => dbsize 4 > 3 guard trips before any copy.
// ---------------------------------------------------------------------------
const T5C_RESTORE_REFUSE = `
  await dst.flushdb();
  await dst.set('ss:tbtest:g1', '1');
  await dst.set('ss:tbtest:g2', '2');
  await dst.set('ss:tbtest:g3', '3');
  await dst.set('ss:tbtest:g4', '4');
  const ret = await backup.restoreFromBackup(dst);
  const stillThere = await dst.get('ss:tbtest:g1');
  const ok = ret === false && stillThere === '1';
  out({ ok, ret, stillThere });
  if (!ok) process.exit(1);
  await dst.flushdb();
  process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scenario 6: final cleanup - nothing left behind on the source
// ---------------------------------------------------------------------------
const T6_CLEANUP = `
  let cur = '0';
  let left = [];
  do {
    const r = await src.scan(cur, 'MATCH', 'ss:tbtest:*', 'COUNT', 500);
    cur = r[0];
    if (r[1].length) {
      left = left.concat(r[1]);
      await src.del(r[1]);
    }
  } while (cur !== '0');
  await src.del('ss:meta:dirty');
  await dst.flushdb();
  out({ ok: left.length === 0, left });
  if (left.length) process.exit(1);
  process.exit(0);
`;

// ---------------------------------------------------------------------------

function assertScenario(t, r, label) {
  t.diagnostic(label + ' status=' + r.status + ' spawnError=' + r.spawnError +
    ' result=' + JSON.stringify(r.result) +
    ' stderr=' + String(r.stderr || '').slice(0, 400));
  assert.equal(r.spawnError, null, label + ' spawn error: ' + r.spawnError);
  assert.equal(r.status, 0, label + ' child exited with status ' + r.status +
    '; stderr: ' + String(r.stderr || '').slice(0, 1200));
  assert.ok(r.result, label + ' no RESULT line; stdout: ' + String(r.stdout || '').slice(0, 1200));
  assert.strictEqual(r.result.ok, true, label + ' assertions failed: ' + JSON.stringify(r.result));
}

test('1) clean + already synced -> returns 0 and copies nothing', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T1_RETURNS_ZERO), makeEnv({ REDIS_BACKUP_URL: DST_URL }));
  assertScenario(t, r, '[scenario 1]');
});

test('2) dirty marker -> copies string/list/hash/set and clears marker', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T2_TYPED_KEYS), makeEnv({ REDIS_BACKUP_URL: DST_URL }));
  assertScenario(t, r, '[scenario 2]');
});

test('3) RACE: new writes mid-copy keep the dirty marker for the next pass', { timeout: 120000 }, (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T3_RACE), makeEnv({ REDIS_BACKUP_URL: DST_URL }));
  assertScenario(t, r, '[scenario 3]');
});

test('4a) no REDIS_BACKUP_URL -> createBackup returns -1', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T4A_NO_ENV), makeEnv({ REDIS_BACKUP_URL: null }));
  assertScenario(t, r, '[scenario 4a]');
});

test('4b) backup Redis unreachable -> returns -1 and keeps dirty marker', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T4B_BAD_URL), makeEnv({ REDIS_BACKUP_URL: BAD_URL }));
  assertScenario(t, r, '[scenario 4b]');
});

test('4c) copyKeys fails mid-copy -> keeps dirty marker, returns count', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T4C_COPY_FAILS), makeEnv({ REDIS_BACKUP_URL: null }));
  assertScenario(t, r, '[scenario 4c]');
});

test('5a) restoreFromBackup: empty backup source -> false', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T5A_RESTORE_EMPTY), makeEnv({ REDIS_BACKUP_URL: DST_URL }));
  assertScenario(t, r, '[scenario 5a]');
});

test('5b) restoreFromBackup: non-empty backup -> true, data copied to main', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T5B_RESTORE_FULL), makeEnv({ REDIS_BACKUP_URL: 'redis://127.0.0.1:6399' }));
  assertScenario(t, r, '[scenario 5b]');
});

test('5c) restoreFromBackup: main redis not empty (>3 keys) -> refuses, false', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T5C_RESTORE_REFUSE), makeEnv({ REDIS_BACKUP_URL: DST_URL }));
  assertScenario(t, r, '[scenario 5c]');
});

test('6) cleanup: no ss:tbtest:* keys remain on source, dest flushed', (t) => {
  const r = runChild(PRELUDE.replace('__BODY__', T6_CLEANUP), makeEnv({ REDIS_BACKUP_URL: DST_URL }));
  assertScenario(t, r, '[scenario 6]');
});


