const Redis = require('ioredis');

const BASE = process.env.SS_TEST_BASE || 'http://127.0.0.1:3123';
const MAIN_REDIS = process.env.SS_MAIN_REDIS || 'redis://127.0.0.1:6399';
const BACKUP_REDIS = process.env.SS_BACKUP_REDIS || 'redis://127.0.0.1:6400';
const ADMIN_ID = '8447133985';

let _main;
function mainRedis() {
  if (!_main) _main = new Redis(MAIN_REDIS);
  return _main;
}
function backupRedis() {
  return new Redis(BACKUP_REDIS);
}

async function closeRedis() {
  if (_main) { await _main.quit(); _main = null; }
}

// Creates a session directly in Redis so tests can authenticate without Telegram.
async function createSession(userId) {
  const r = mainRedis();
  const sessionId = 'test-session-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  await r.set('ss:session:' + sessionId, JSON.stringify({ userId: String(userId) }), 'PX', 3600 * 1000);
  return sessionId;
}

async function req(method, url, opts = {}) {
  const { body, sessionId, raw } = opts;
  const headers = { ...(opts.headers || {}) };
  if (sessionId) headers['Cookie'] = 'session=' + sessionId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, json, text };
}

module.exports = { BASE, MAIN_REDIS, BACKUP_REDIS, ADMIN_ID, mainRedis, backupRedis, closeRedis, createSession, req };
