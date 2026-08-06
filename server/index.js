require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var express = require('express');
var path = require('path');
var Redis = require('ioredis');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');

var app = express();
app.use(express.json({ limit: '10mb' }));

// ── Request logger ──
app.use(function(req, res, next) {
    var start = Date.now();
    res.on('finish', function() {
        var ms = Date.now() - start;
        console.log('[API] ' + req.method + ' ' + req.originalUrl + ' → ' + res.statusCode + ' (' + ms + 'ms)');
    });
    next();
});

var redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
var redisOpts = {
    retryStrategy: function(times) {
        return Math.min(times * 500, 10000);
    }
};
if (redisUrl.startsWith('rediss://') || redisUrl.includes('upstash.io')) {
    redisOpts.tls = {};
}
var redis = new Redis(redisUrl, redisOpts);

redis.on('error', function(err) {
    console.error('Redis connection error:', err.message);
});

var redisReady = false;
redis.on('ready', function() {
    if (!redisReady) {
        redisReady = true;
        console.log('Connected to Redis');
    }
});

// ── Helpers ──
function key(k) { return 'ss:' + k; }

async function getJSON(k) {
    try {
        var raw = await redis.get(key(k));
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

async function setJSON(k, val) {
    try { await redis.set(key(k), JSON.stringify(val)); return true; }
    catch { return false; }
}

async function setJSONex(k, val, ms) {
    try { await redis.set(key(k), JSON.stringify(val), 'PX', ms); return true; }
    catch { return false; }
}

async function delKey(k) {
    try { await redis.del(key(k)); return true; }
    catch { return false; }
}

async function getUserFiles(userId) {
    return await getJSON('files:' + userId) || [];
}

async function findUserFile(userId, fileId) {
    var files = await getUserFiles(userId);
    var idx = files.findIndex(function(f) { return f.id === fileId; });
    return { files: files, idx: idx, file: idx !== -1 ? files[idx] : null };
}

function countDataRows(rows, columns) {
    if (!rows || !rows.length) return 0;
    var keys = columns ? columns.map(function(c) { return c.key; }) : null;
    return rows.filter(function(row) {
        if (keys) return keys.some(function(k) { return row[k]; });
        return Object.values(row).some(function(v) { return v; });
    }).length;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ── Session cache ──
var sessionCache = new Map();
var SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Migrated log keys cache ──
var _migratedLogKeys = new Set();

// ── Admin IDs ──
var ADMIN_IDS = (process.env.ADMIN_IDS || '8447133985,1772093705').split(',').map(function(s) { return s.trim(); }).filter(Boolean);

function isAdmin(userId) {
    return ADMIN_IDS.indexOf(String(userId)) !== -1;
}

// ── Telegram Bot ──
var BOT_TOKEN = process.env.TG_BOT_TOKEN;
var APP_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : (process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000));
var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

async function tg(method, body) {
    var bodyStr = body !== undefined ? JSON.stringify(body).slice(0, 200) : '(no body)';
    console.log('[Bot] tg.' + method + ' body=' + bodyStr);
    var opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var res = await fetch(TG_API + '/' + method, opts);
    var json = await res.json();
    if (json.ok) {
        console.log('[Bot] tg.' + method + ' → ok=' + json.ok);
    } else {
        console.log('[Bot] tg.' + method + ' → ok=' + json.ok + ' error_code=' + json.error_code + ' description="' + json.description + '"');
    }
    return json;
}

// ── Session helpers ──
function getSessionId(req) {
    var cookies = req.headers.cookie || '';
    var match = cookies.match(/session=([^;]+)/);
    return match ? match[1] : null;
}

async function requireAuth(req, res, next) {
    var sessionId = getSessionId(req);
    if (!sessionId) { res.status(401).json({ error: 'Not authenticated' }); return; }
    var cached = sessionCache.get(sessionId);
    if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL) {
        req.userId = cached.userId;
        next();
        return;
    }
    var session = await getJSON('session:' + sessionId);
    if (!session) { res.status(401).json({ error: 'Session expired' }); return; }
    sessionCache.set(sessionId, { userId: String(session.userId), ts: Date.now() });
    if (sessionCache.size > 1000) {
        var firstKey = sessionCache.keys().next().value;
        sessionCache.delete(firstKey);
    }
    req.userId = String(session.userId);
    next();
}

// ── Auth routes ──
app.get('/api/auth/telegram', async function(req, res) {
    var token = req.query.token;
    if (!token) { res.status(400).send('Missing token'); return; }
    console.log('[Auth] login callback with token=' + token.slice(0, 8) + '...');

    var loginData = await getJSON('login:' + token);
    if (!loginData) { console.log('[Auth] invalid token'); res.status(400).send('Invalid or expired token'); return; }

    console.log('[Auth] login for chatId=' + loginData.chatId);
    var userInfo = null;
    try {
        var chatRes = await tg('getChat', { chat_id: loginData.chatId });
        if (chatRes.ok) {
            userInfo = {
                id: loginData.chatId,
                firstName: chatRes.result.first_name || '',
                lastName: chatRes.result.last_name || '',
                username: chatRes.result.username || '',
                fileId: null
            };
            try {
                var photosRes = await tg('getUserProfilePhotos', { user_id: loginData.chatId, limit: 1 });
                if (photosRes.ok && photosRes.result.photos.length > 0) {
                    userInfo.fileId = photosRes.result.photos[0][photosRes.result.photos[0].length - 1].file_id;
                }
            } catch {}
        }
    } catch {}

    if (!userInfo) { console.log('[Auth] failed to get user info'); res.status(500).send('Failed to get user info'); return; }

    console.log('[Auth] user=' + (userInfo.username || userInfo.firstName) + ' id=' + userInfo.id);

    var existing = await getJSON('user:' + userInfo.id) || {};
    var merged = {
        id: userInfo.id,
        firstName: userInfo.firstName,
        lastName: userInfo.lastName,
        username: userInfo.username,
        fileId: userInfo.fileId || existing.fileId || null,
        lastLogin: Date.now()
    };
    await setJSON('user:' + userInfo.id, merged);
    await redis.sadd(key('userIds'), String(userInfo.id));

    var sessionId = generateToken();
    await setJSONex('session:' + sessionId, { userId: userInfo.id }, 2592000000);
    await delKey('login:' + token);

    if (loginData.did && /^[A-Za-z0-9-]{8,64}$/.test(loginData.did)) {
        await setJSONex('device:' + loginData.did, { sessionId: sessionId }, 3600000);
        console.log('[Auth] session bound to device ' + loginData.did.slice(0, 8) + '...');
    }

    res.setHeader('Set-Cookie', 'session=' + sessionId + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
    console.log('[Auth] session created, redirecting');

    tg('sendMessage', {
        chat_id: loginData.chatId,
        text: '<b>Login Successful</b>\n\nHey @' + (userInfo.username || userInfo.firstName) + ', you are signed in to SheetSubmit.\n\nIf this was not you, contact the admin immediately.',
        parse_mode: 'HTML'
    });

    res.redirect('/');
});

app.get('/api/auth/photo/:userId', async function(req, res) {
    var user = await getJSON('user:' + req.params.userId);
    if (!user || !user.fileId) { res.status(404).end(); return; }
    try {
        var fileRes = await tg('getFile', { file_id: user.fileId });
        if (fileRes.ok) {
            res.redirect('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + fileRes.result.file_path);
        } else {
            res.status(404).end();
        }
    } catch { res.status(500).end(); }
});

app.get('/api/auth/logout', async function(req, res) {
    var sessionId = getSessionId(req);
    console.log('[Auth] logout session=' + (sessionId ? sessionId.slice(0, 8) + '...' : 'none'));
    if (sessionId) {
        await delKey('session:' + sessionId);
        sessionCache.delete(sessionId);
    }
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
});

app.get('/api/auth/me', async function(req, res) {
    var sessionId = getSessionId(req);
    if (!sessionId) { res.json(null); return; }
    var session = await getJSON('session:' + sessionId);
    if (!session) { console.log('[Auth] me: session expired'); res.json(null); return; }
    var user = await getJSON('user:' + session.userId);
    if (user) {
        user.photoUrl = user.fileId ? '/api/auth/photo/' + user.id : null;
        user.isAdmin = user && isAdmin(user.id);
    }
    console.log('[Auth] me: user=' + (user ? user.username || user.firstName || user.id : 'null') + ' admin=' + (user ? user.isAdmin : false));
    res.json(user || null);
});

// ── Device login poll (used by the Android WebView app) ──
app.get('/api/auth/device', async function(req, res) {
    var did = (req.query.token || '').trim();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) { res.json({ ok: false }); return; }
    var info = await getJSON('device:' + did);
    if (!info || !info.sessionId) { res.json({ ok: false }); return; }
    await delKey('device:' + did);
    console.log('[Auth] device ' + did.slice(0, 8) + '... picked up session');
    res.json({ ok: true, sessionId: info.sessionId });
});

// ── Ownership check middleware ──
async function requireFileAccess(req, res, next) {
    var result = await findUserFile(req.userId, req.params.id);
    if (!result.file) { res.status(404).json({ error: 'file not found' }); return; }
    req.file = result.file;
    req.files = result.files;
    req.fileIdx = result.idx;
    next();
}

// ── API: Files (auth required) ──
app.get('/api/files', requireAuth, async function(req, res) {
    var files = await getUserFiles(req.userId);
    res.json(files);
});

app.get('/api/files/:id', requireAuth, requireFileAccess, async function(req, res) {
    res.json(req.file);
});

app.post('/api/files', requireAuth, async function(req, res) {
    var files = await getUserFiles(req.userId);
    var file = req.body;
    file.userId = req.userId;
    file.createdAt = Date.now();
    file.updatedAt = Date.now();
    files.unshift(file);
    await setJSON('files:' + req.userId, files);
    res.json(file);
});

app.put('/api/files/:id', requireAuth, requireFileAccess, async function(req, res) {
    var file = req.files[req.fileIdx];
    var updates = req.body;
    Object.keys(updates).forEach(function(k) { file[k] = updates[k]; });
    file.updatedAt = Date.now();
    await setJSON('files:' + req.userId, req.files);
    res.json(file);
});

app.delete('/api/files/:id', requireAuth, requireFileAccess, async function(req, res) {
    var file = req.files.splice(req.fileIdx, 1)[0];
    file.deletedAt = Date.now();
    var archived = await getJSON('archive:' + req.userId) || [];
    archived.unshift(file);
    await setJSON('files:' + req.userId, req.files);
    await setJSON('archive:' + req.userId, archived);
    res.json({ ok: true });
});

// ── API: Batch persist (auth required) ──
app.put('/api/files/:id/persist', requireAuth, requireFileAccess, async function(req, res) {
    var body = req.body;
    var pipeline = redis.pipeline();
    if (body.rows !== undefined) pipeline.set(key('rows:' + req.params.id), JSON.stringify(body.rows));
    if (body.logs !== undefined) {
        var logKey = key('logs:' + req.params.id);
        pipeline.del(logKey);
        body.logs.forEach(function(l) { pipeline.rpush(logKey, JSON.stringify(l)); });
    }
    if (body.undo !== undefined) pipeline.set(key('undo:' + req.params.id), JSON.stringify(body.undo));
    if (body.redo !== undefined) pipeline.set(key('redo:' + req.params.id), JSON.stringify(body.redo));
    if (body.dataCount !== undefined) {
        req.files[req.fileIdx].dataCount = body.dataCount;
        req.files[req.fileIdx].updatedAt = Date.now();
        pipeline.set(key('files:' + req.userId), JSON.stringify(req.files));
    }
    try {
        var results = await pipeline.exec();
        var failedCmd = results.find(function(r) { return r[0] !== null; });
        if (failedCmd) {
            console.error('[Persist] pipeline command error:', failedCmd[0]);
            res.status(500).json({ error: 'Partial persist failure' });
            return;
        }
    } catch(e) {
        console.error('[Persist] pipeline error:', e.message);
        res.status(500).json({ error: 'Failed to persist data' });
        return;
    }
    res.json({ ok: true, file: req.file });
});

// ── API: Archive (auth required) ──
app.get('/api/archive', requireAuth, async function(req, res) {
    var archived = await getJSON('archive:' + req.userId) || [];
    res.json(archived);
});

app.post('/api/archive/:id/restore', requireAuth, async function(req, res) {
    var archived = await getJSON('archive:' + req.userId) || [];
    var idx = archived.findIndex(function(f) { return f.id === req.params.id; });
    if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var file = archived.splice(idx, 1)[0];
    delete file.deletedAt;
    var files = await getUserFiles(req.userId);
    files.unshift(file);
    await setJSON('archive:' + req.userId, archived);
    await setJSON('files:' + req.userId, files);
    res.json({ ok: true });
});

app.post('/api/archive/batch-restore', requireAuth, async function(req, res) {
    var ids = req.body.ids;
    if (!ids || !ids.length) { res.status(400).json({ error: 'no ids' }); return; }
    var archived = await getJSON('archive:' + req.userId) || [];
    var files = await getUserFiles(req.userId);
    var restored = [];
    archived = archived.filter(function(f) {
        if (ids.indexOf(f.id) !== -1) {
            delete f.deletedAt;
            files.unshift(f);
            restored.push(f);
            return false;
        }
        return true;
    });
    await setJSON('archive:' + req.userId, archived);
    await setJSON('files:' + req.userId, files);
    res.json({ restored: restored.length });
});

app.delete('/api/archive/:id', requireAuth, async function(req, res) {
    var archived = await getJSON('archive:' + req.userId) || [];
    var existed = archived.some(function(f) { return f.id === req.params.id; });
    if (!existed) { res.status(404).json({ error: 'not found' }); return; }
    archived = archived.filter(function(f) { return f.id !== req.params.id; });
    await setJSON('archive:' + req.userId, archived);
    redis.pipeline().del('rows:' + req.params.id, 'undo:' + req.params.id, 'redo:' + req.params.id, 'sync:' + req.params.id, 'logs:' + req.params.id).exec();
    res.json({ ok: true });
});

app.post('/api/archive/batch-delete', requireAuth, async function(req, res) {
    var ids = req.body.ids;
    if (!ids || !ids.length) { res.status(400).json({ error: 'no ids' }); return; }
    var archived = await getJSON('archive:' + req.userId) || [];
    var idSet = {};
    ids.forEach(function(id) { idSet[id] = true; });
    archived = archived.filter(function(f) { return !idSet[f.id]; });
    await setJSON('archive:' + req.userId, archived);
    var delPromises = [];
    ids.forEach(function(id) {
        delPromises.push(delKey('rows:' + id));
        delPromises.push(delKey('undo:' + id));
        delPromises.push(delKey('redo:' + id));
        delPromises.push(delKey('sync:' + id));
        delPromises.push(delKey('logs:' + id));
    });
    await Promise.all(delPromises);
    res.json({ deleted: ids.length });
});

// ── API: Rows (auth required) ──
app.get('/api/files/:id/rows', requireAuth, requireFileAccess, async function(req, res) {
    var rows = await getJSON('rows:' + req.params.id);
    res.json(rows || []);
});

// ── API: Sync state (auth required) ──
app.get('/api/files/:id/sync', requireAuth, requireFileAccess, async function(req, res) {
    var sync = await getJSON('sync:' + req.params.id);
    res.json(sync || { enabled: false });
});

app.put('/api/files/:id/sync', requireAuth, requireFileAccess, async function(req, res) {
    await setJSON('sync:' + req.params.id, req.body);
    res.json({ ok: true });
});

// ── API: Cell update (auth required) ──
app.put('/api/files/:id/cell', requireAuth, requireFileAccess, async function(req, res) {
    var rows = await getJSON('rows:' + req.params.id) || [];
    var r = req.body;
    if (r.rowIdx !== undefined && r.colKey !== undefined) {
        while (rows.length <= r.rowIdx) rows.push({});
        rows[r.rowIdx][r.colKey] = r.value;
        await setJSON('rows:' + req.params.id, rows);
    }
    res.json({ ok: true });
});

// ── API: Log append (auth required) ──
app.post('/api/files/:id/log', requireAuth, requireFileAccess, async function(req, res) {
    try {
        var logKey = key('logs:' + req.params.id);
        await migrateLogKey(logKey);
        await redis.rpush(logKey, JSON.stringify(req.body.log));
        await redis.ltrim(logKey, -500, -1);
        res.json({ ok: true });
    } catch(e) {
        console.error('[Log] Error:', e.message);
        res.status(500).json({ error: 'Failed to append log' });
    }
});

// ── API: Logs (auth required) ──
app.get('/api/files/:id/logs', requireAuth, requireFileAccess, async function(req, res) {
    try {
        var logKey = key('logs:' + req.params.id);
        await migrateLogKey(logKey);
        var logs = await redis.lrange(logKey, 0, -1);
        var parsed = [];
        logs.forEach(function(l) {
            try { parsed.push(JSON.parse(l)); } catch(e) {}
        });
        res.json(parsed);
    } catch(e) {
        console.error('[Logs] Error:', e.message);
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

// ── Cross-file duplicates ──
function getDedupKey(type, row) {
    if (type === 'fb_cookie') return row.uid || (row.cookies ? (row.cookies.match(/c_user=(\d+)/) || [])[1] : null) || null;
    if (type === 'ig_cookie') return row.username || null;
    return null;
}

app.get('/api/cross-dups', requireAuth, async function(req, res) {
    try {
        var fileId = req.query.fileId || null;
        var files = await getUserFiles(req.userId);
        var typeFiles = {};
        files.forEach(function(f) {
            if (!typeFiles[f.type]) typeFiles[f.type] = [];
            typeFiles[f.type].push(f);
        });
        var allDups = {};
        var counts = {};
        files.forEach(function(f) { counts[f.id] = 0; });

        for (var typeKey in typeFiles) {
            var tf = typeFiles[typeKey];
            if (tf.length < 2) continue;
            var p = redis.pipeline();
            tf.forEach(function(f) { p.get(key('rows:' + f.id)); });
            var results = await p.exec();
            var uidMap = {};
            tf.forEach(function(f, i) {
                var rows = [];
                try { rows = JSON.parse(results[i][1]) || []; } catch(e) {}
                rows.forEach(function(row, ri) {
                    var dk = getDedupKey(typeKey, row);
                    if (!dk) return;
                    if (!uidMap[dk]) uidMap[dk] = [];
                    uidMap[dk].push({ fileId: f.id, fileName: f.name, rowIdx: ri });
                });
            });
            for (var uid in uidMap) {
                if (uidMap[uid].length > 1) {
                    allDups[uid] = uidMap[uid];
                    var seen = {};
                    uidMap[uid].forEach(function(e) {
                        if (!seen[e.fileId]) { seen[e.fileId] = true; counts[e.fileId]++; }
                    });
                }
            }
        }

        if (fileId) {
            var filtered = {};
            for (var uid in allDups) {
                var affected = allDups[uid].filter(function(e) { return e.fileId === fileId; });
                if (affected.length > 0) filtered[uid] = allDups[uid];
            }
            res.json({ counts: counts, dups: filtered });
        } else {
            res.json({ counts: counts });
        }
    } catch(e) {
        console.error('[CrossDups] error:', e.message);
        res.status(500).json({ error: 'Failed to check cross-file duplicates' });
    }
});

// ── Admin middleware ──
async function requireAdmin(req, res, next) {
    if (!(await isAdmin(req.userId))) {
        res.status(403).json({ error: 'admin access required' });
        return;
    }
    next();
}

async function migrateLogKey(logKey) {
    if (_migratedLogKeys.has(logKey)) return;
    var type = await redis.type(logKey);
    if (type === 'string') {
        var old = await redis.get(logKey);
        if (old) {
            try {
                var parsed = JSON.parse(old);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    var p = redis.pipeline();
                    p.del(logKey);
                    parsed.forEach(function(l) { p.rpush(logKey, JSON.stringify(l)); });
                    await p.exec();
                } else {
                    await redis.del(logKey);
                }
            } catch(e) {
                await redis.del(logKey);
            }
        }
    }
    _migratedLogKeys.add(logKey);
}

async function findAllUserIds() {
    return await redis.smembers(key('userIds'));
}

async function findFileAcrossUsers(fileId) {
    var ids = await findAllUserIds();
    if (ids.length === 0) return null;
    var p = redis.pipeline();
    ids.forEach(function(id) { p.get(key('files:' + id)); });
    var results = await p.exec();
    for (var i = 0; i < results.length; i++) {
        var files = results[i][1];
        if (!files) continue;
        try { files = JSON.parse(files); } catch(e) { continue; }
        if (!Array.isArray(files)) continue;
        for (var j = 0; j < files.length; j++) {
            if (files[j].id === fileId) return { file: files[j], userId: ids[i], files: files, idx: j };
        }
    }
    return null;
}

// ── Admin API ──
app.get('/api/admin/stats', requireAuth, requireAdmin, async function(req, res) {
    try {
        var userIds = await findAllUserIds();
        var totalUsers = userIds.length;
        var totalFiles = 0;
        if (userIds.length > 0) {
            var p = redis.pipeline();
            userIds.forEach(function(id) { p.get(key('files:' + id)); });
            var results = await p.exec();
            results.forEach(function(r) {
                if (r[1]) {
                    try { var files = JSON.parse(r[1]); if (Array.isArray(files)) totalFiles += files.length; } catch(e) {}
                }
            });
        }
        res.json({ totalUsers: totalUsers, totalFiles: totalFiles });
    } catch(e) {
        console.error('[Admin Stats] error:', e.message);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async function(req, res) {
    try {
        var userIds = await findAllUserIds();
        console.log('[Admin Users] userIds:', JSON.stringify(userIds));
        var users = [];
        if (userIds.length > 0) {
            var p = redis.pipeline();
            userIds.forEach(function(id) { p.get(key('user:' + id)); p.get(key('files:' + id)); p.get(key('archive:' + id)); });
            var results = await p.exec();
            for (var i = 0; i < userIds.length; i++) {
                var userData = results[i * 3][1];
                console.log('[Admin Users] id=' + userIds[i] + ' userData=' + (userData ? 'exists' : 'null') + ' filesData=' + (results[i * 3 + 1][1] ? 'exists' : 'null'));
                if (!userData) continue;
                try { var user = JSON.parse(userData); } catch(e) { console.log('[Admin Users] parse error for', userIds[i]); continue; }
                var filesData = results[i * 3 + 1][1];
                var files = filesData ? (function(){ try { return JSON.parse(filesData); } catch(e){ return []; } })() : [];
                var archivedData = results[i * 3 + 2][1];
                var archived = archivedData ? (function(){ try { return JSON.parse(archivedData); } catch(e){ return []; } })() : [];
                user.fileCount = files.length;
                user.archivedCount = archived.length;
                user.photoUrl = user.fileId ? '/api/auth/photo/' + user.id : null;
                users.push(user);
            }
        }
        users.sort(function(a, b) { return (b.lastLogin || 0) - (a.lastLogin || 0); });
        console.log('[Admin Users] returning ' + users.length + ' users');
        res.json(users);
    } catch(e) {
        console.error('[Admin Users] error:', e.message);
        res.status(500).json({ error: 'Failed to get users' });
    }
});

app.get('/api/admin/users/search', requireAuth, requireAdmin, async function(req, res) {
    try {
        var q = (req.query.q || '').toLowerCase().trim();
        var userIds = await findAllUserIds();
        var users = [];
        if (userIds.length > 0) {
            var p = redis.pipeline();
            userIds.forEach(function(id) { p.get(key('user:' + id)); p.get(key('files:' + id)); });
            var results = await p.exec();
            for (var i = 0; i < userIds.length; i++) {
                var userData = results[i * 2][1];
                if (!userData) continue;
                try { var user = JSON.parse(userData); } catch(e) { continue; }
                if (q) {
                    var name = ((user.firstName || '') + ' ' + (user.lastName || '')).toLowerCase();
                    var uname = (user.username || '').toLowerCase();
                    var uid = String(user.id);
                    if (name.indexOf(q) === -1 && uname.indexOf(q) === -1 && uid.indexOf(q) === -1) continue;
                }
                var filesData = results[i * 2 + 1][1];
                var files = filesData ? (function(){ try { return JSON.parse(filesData); } catch(e){ return []; } })() : [];
                user.fileCount = files.length;
                user.photoUrl = user.fileId ? '/api/auth/photo/' + user.id : null;
                users.push(user);
            }
        }
        users.sort(function(a, b) { return (b.lastLogin || 0) - (a.lastLogin || 0); });
        res.json(users);
    } catch(e) {
        console.error('[Admin Search] error:', e.message);
        res.status(500).json({ error: 'Failed to search users' });
    }
});

app.get('/api/admin/user/:userId', requireAuth, requireAdmin, async function(req, res) {
    var user = await getJSON('user:' + req.params.userId);
    if (!user) { res.status(404).json({ error: 'user not found' }); return; }
    var files = await getJSON('files:' + req.params.userId) || [];
    var archived = await getJSON('archive:' + req.params.userId) || [];
    user.photoUrl = user.fileId ? '/api/auth/photo/' + user.id : null;
    user.fileCount = files.length;
    user.archivedCount = archived.length;
    user.files = files;
    res.json(user);
});

app.get('/api/admin/user/:userId/files', requireAuth, requireAdmin, async function(req, res) {
    var files = await getJSON('files:' + req.params.userId) || [];
    res.json(files);
});

app.get('/api/admin/user/:userId/archive', requireAuth, requireAdmin, async function(req, res) {
    var archived = await getJSON('archive:' + req.params.userId) || [];
    res.json(archived);
});

app.post('/api/admin/user/:userId/archive/:fileId/restore', requireAuth, requireAdmin, async function(req, res) {
    var archived = await getJSON('archive:' + req.params.userId) || [];
    var idx = archived.findIndex(function(f) { return f.id === req.params.fileId; });
    if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var file = archived.splice(idx, 1)[0];
    delete file.deletedAt;
    var files = await getJSON('files:' + req.params.userId) || [];
    files.unshift(file);
    await setJSON('archive:' + req.params.userId, archived);
    await setJSON('files:' + req.params.userId, files);
    res.json({ ok: true });
});

app.delete('/api/admin/user/:userId/archive/:fileId', requireAuth, requireAdmin, async function(req, res) {
    var archived = await getJSON('archive:' + req.params.userId) || [];
    var idx = archived.findIndex(function(f) { return f.id === req.params.fileId; });
    if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var file = archived.splice(idx, 1)[0];
    await setJSON('archive:' + req.params.userId, archived);
    redis.pipeline().del('rows:' + file.id, 'undo:' + file.id, 'redo:' + file.id, 'sync:' + file.id, 'logs:' + file.id).exec();
    res.json({ ok: true });
});

app.get('/api/admin/file/:fileId', requireAuth, requireAdmin, async function(req, res) {
    try {
        var found = await findFileAcrossUsers(req.params.fileId);
        if (!found) { res.status(404).json({ error: 'file not found' }); return; }
        res.json(found.file);
    } catch(e) {
        console.error('[Admin Get File] error:', e.message);
        res.status(500).json({ error: 'Failed to get file' });
    }
});

app.put('/api/admin/file/:fileId', requireAuth, requireAdmin, async function(req, res) {
    try {
        var found = await findFileAcrossUsers(req.params.fileId);
        if (!found) { res.status(404).json({ error: 'file not found' }); return; }
        var updates = req.body;
        Object.keys(updates).forEach(function(k) { found.files[found.idx][k] = updates[k]; });
        found.files[found.idx].updatedAt = Date.now();
        await setJSON('files:' + found.userId, found.files);
        res.json(found.files[found.idx]);
    } catch(e) {
        console.error('[Admin Update File] error:', e.message);
        res.status(500).json({ error: 'Failed to update file' });
    }
});

app.delete('/api/admin/file/:fileId', requireAuth, requireAdmin, async function(req, res) {
    try {
        var found = await findFileAcrossUsers(req.params.fileId);
        if (!found) { res.status(404).json({ error: 'file not found' }); return; }
        var file = found.files.splice(found.idx, 1)[0];
        file.deletedAt = Date.now();
        var archived = await getJSON('archive:' + found.userId) || [];
        archived.unshift(file);
        await setJSON('files:' + found.userId, found.files);
        await setJSON('archive:' + found.userId, archived);
        res.json({ ok: true });
    } catch(e) {
        console.error('[Admin Delete File] error:', e.message);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

app.get('/api/admin/file/:fileId/rows', requireAuth, requireAdmin, async function(req, res) {
    var rows = await getJSON('rows:' + req.params.fileId);
    res.json(rows || []);
});

app.put('/api/admin/file/:fileId/persist', requireAuth, requireAdmin, async function(req, res) {
    var body = req.body;
    var promises = [];
    if (body.rows !== undefined) promises.push(setJSON('rows:' + req.params.fileId, body.rows));
    if (body.logs !== undefined) {
        var logKey = key('logs:' + req.params.fileId);
        var p = redis.pipeline();
        p.del(logKey);
        body.logs.forEach(function(l) { p.rpush(logKey, JSON.stringify(l)); });
        promises.push(p.exec());
    }
    if (body.undo !== undefined) promises.push(setJSON('undo:' + req.params.fileId, body.undo));
    if (body.redo !== undefined) promises.push(setJSON('redo:' + req.params.fileId, body.redo));
    if (body.dataCount !== undefined && body.userId) {
        var files = await getJSON('files:' + body.userId);
        if (files) {
            var idx = files.findIndex(function(f) { return f.id === req.params.fileId; });
            if (idx !== -1) {
                files[idx].dataCount = body.dataCount;
                files[idx].updatedAt = Date.now();
                promises.push(setJSON('files:' + body.userId, files));
            }
        }
    }
    try {
        await Promise.all(promises);
    } catch(e) {
        console.error('[Admin Persist] error:', e.message);
        res.status(500).json({ error: 'Failed to persist' });
        return;
    }
    res.json({ ok: true });
});

app.put('/api/admin/file/:fileId/cell', requireAuth, requireAdmin, async function(req, res) {
    var rows = await getJSON('rows:' + req.params.fileId) || [];
    var r = req.body;
    if (r.rowIdx !== undefined && r.colKey !== undefined) {
        while (rows.length <= r.rowIdx) rows.push({});
        rows[r.rowIdx][r.colKey] = r.value;
        await setJSON('rows:' + req.params.fileId, rows);
    }
    res.json({ ok: true });
});

app.post('/api/admin/file/:fileId/log', requireAuth, requireAdmin, async function(req, res) {
    try {
        var logKey = key('logs:' + req.params.fileId);
        await redis.rpush(logKey, JSON.stringify(req.body.log));
        await redis.ltrim(logKey, -500, -1);
        res.json({ ok: true });
    } catch(e) {
        console.error('[Log] Error:', e.message);
        res.status(500).json({ error: 'Failed to append log' });
    }
});

app.get('/api/admin/file/:fileId/logs', requireAuth, requireAdmin, async function(req, res) {
    try {
        var logKey = key('logs:' + req.params.fileId);
        var logs = await redis.lrange(logKey, 0, -1);
        var parsed = [];
        logs.forEach(function(l) {
            try { parsed.push(JSON.parse(l)); } catch(e) {}
        });
        res.json(parsed);
    } catch(e) {
        console.error('[Logs] Error:', e.message);
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

app.delete('/api/admin/user/:userId', requireAuth, requireAdmin, async function(req, res) {
    var user = await getJSON('user:' + req.params.userId);
    if (!user) { res.status(404).json({ error: 'user not found' }); return; }
    var files = await getJSON('files:' + req.params.userId) || [];
    var archived = await getJSON('archive:' + req.params.userId) || [];
    var allFiles = files.concat(archived);
    var delPromises = [];
    allFiles.forEach(function(f) {
        delPromises.push(delKey('rows:' + f.id));
        delPromises.push(delKey('undo:' + f.id));
        delPromises.push(delKey('redo:' + f.id));
        delPromises.push(delKey('sync:' + f.id));
        delPromises.push(delKey('logs:' + f.id));
    });
    delPromises.push(delKey('files:' + req.params.userId));
    delPromises.push(delKey('archive:' + req.params.userId));
    delPromises.push(delKey('user:' + req.params.userId));
    delPromises.push(redis.srem(key('userIds'), String(req.params.userId)));
    await Promise.all(delPromises);
    res.json({ ok: true });
});

app.put('/api/admin/user/:userId', requireAuth, requireAdmin, async function(req, res) {
    var user = await getJSON('user:' + req.params.userId);
    if (!user) { res.status(404).json({ error: 'user not found' }); return; }
    var updates = req.body;
    Object.keys(updates).forEach(function(k) {
        if (k !== 'id') user[k] = updates[k];
    });
    await setJSON('user:' + req.params.userId, user);
    res.json(user);
});

// ── Health check (no auth) ──
app.get('/api/health', function(req, res) {
    res.json({ status: redis.status === 'ready' ? 'ok' : redis.status });
});

// ── IG Cookie API Proxy (auth required) ──
var IG_API = 'https://igautocookiesofficial.site/api';

app.post('/api/ig/jobs', requireAuth, async function(req, res) {
    console.log('[Proxy] IG POST /jobs');
    try {
        var r = await fetch(IG_API + '/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        var data = await r.json();
        console.log('[Proxy] IG POST /jobs → ' + r.status);
        res.status(r.status).json(data);
    } catch(e) { console.error('[Proxy] IG POST error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/ig/jobs/:jobId', requireAuth, async function(req, res) {
    console.log('[Proxy] IG GET /jobs/' + req.params.jobId);
    try {
        var r = await fetch(IG_API + '/jobs/' + req.params.jobId);
        var data = await r.json();
        console.log('[Proxy] IG GET /jobs/' + req.params.jobId + ' → ' + r.status);
        res.status(r.status).json(data);
    } catch(e) { console.error('[Proxy] IG GET error:', e.message); res.status(500).json({ error: e.message }); }
});

// ── FB Account Check Proxy (auth required) ──
var FB_API_CHECK = 'https://check.fb.tools/api/check/facebook';
var FB_API_HITOOLS = 'https://hitools.pro/api/check-live-uid';

app.post('/api/fb/check', requireAuth, async function(req, res) {
    var uids = req.body.uids;
    if (!uids || !uids.length) { res.status(400).json({ error: 'No UIDs provided' }); return; }

    var unique = [...new Set(uids.map(function(u) { return String(u); }))];
    var valid = [], dead = [], uncertain = [];

    // Phase 1: check.fb.tools (primary)
    var checkfbOk = false;
    for (var i = 0; i < unique.length; i += 20) {
        var batch = unique.slice(i, i + 20);
        var batchOk = false;
        for (var attempt = 1; attempt <= 2; attempt++) {
            try {
                var r = await fetch(FB_API_CHECK, {
                    method: 'POST',
                    headers: {
                        'accept': 'application/x-ndjson',
                        'content-type': 'application/json',
                        'cache-control': 'no-cache'
                    },
                    body: JSON.stringify({ inputData: batch, userLang: 'en', checkFriends: false }),
                    signal: AbortSignal.timeout(30000)
                });
                if (!r.ok) { if (attempt < 2) { await new Promise(function(r2) { setTimeout(r2, 2000); }); continue; } break; }
                var text = await r.text();
                var lines = text.trim().split('\n');
                for (var li = 0; li < lines.length; li++) {
                    try {
                        var parsed = JSON.parse(lines[li].substring(lines[li].indexOf('{')));
                        if (parsed.event === 'result') {
                            var uid = String(parsed.data.uid || parsed.data.account);
                            var status = parsed.data.status ? parsed.data.status.name : '';
                            if (status === 'valid') { if (valid.indexOf(uid) === -1) valid.push(uid); }
                            else { if (dead.indexOf(uid) === -1) dead.push(uid); }
                        }
                    } catch(e) {}
                }
                batchOk = true;
                break;
            } catch(e) { if (attempt < 2) await new Promise(function(r2) { setTimeout(r2, 2000); }); }
        }
        if (!batchOk) {
            batch.forEach(function(uid) {
                if (valid.indexOf(uid) === -1 && dead.indexOf(uid) === -1 && uncertain.indexOf(uid) === -1) uncertain.push(uid);
            });
        }
        if (i + 20 < unique.length) await new Promise(function(r2) { setTimeout(r2, 300); });
    }

    // Phase 2: hitools.pro (fallback for unresolved)
    var remaining = unique.filter(function(u) { return valid.indexOf(u) === -1 && dead.indexOf(u) === -1 && uncertain.indexOf(u) === -1; });
    if (remaining.length > 0) {
        for (var i = 0; i < remaining.length; i += 20) {
            var batch = remaining.slice(i, i + 20);
            var batchOk = false;
            for (var attempt = 1; attempt <= 2; attempt++) {
                try {
                    var r = await fetch(FB_API_HITOOLS, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', 'referer': 'https://hitools.pro/check-live-uid', 'origin': 'https://hitools.pro' },
                        body: JSON.stringify({ uids: batch }),
                        signal: AbortSignal.timeout(20000)
                    });
                    if (!r.ok) { if (attempt < 2) { await new Promise(function(r2) { setTimeout(r2, 2000); }); continue; } break; }
                    var text = await r.text();
                    var lines = text.trim().split('\n');
                    for (var li = 0; li < lines.length; li++) {
                        try {
                            var parsed = JSON.parse(lines[li]);
                            if (parsed.uid) {
                                var uid = String(parsed.uid);
                                if (parsed.live) { if (valid.indexOf(uid) === -1) valid.push(uid); }
                                else { if (dead.indexOf(uid) === -1) dead.push(uid); }
                            }
                        } catch(e) {}
                    }
                    batchOk = true;
                    break;
                } catch(e) { if (attempt < 2) await new Promise(function(r2) { setTimeout(r2, 2000); }); }
            }
            if (!batchOk) {
                batch.forEach(function(uid) {
                    if (valid.indexOf(uid) === -1 && dead.indexOf(uid) === -1 && uncertain.indexOf(uid) === -1) uncertain.push(uid);
                });
            }
            if (i + 20 < remaining.length) await new Promise(function(r2) { setTimeout(r2, 11000); });
        }
    }

    for (var i = 0; i < unique.length; i++) {
        var uid = unique[i];
        if (valid.indexOf(uid) === -1 && dead.indexOf(uid) === -1 && uncertain.indexOf(uid) === -1) uncertain.push(uid);
    }

    res.json({ valid: valid, dead: dead, uncertain: uncertain });
});

// ── WA Onboarding Eligibility Check (auth required) ──
app.post('/api/fb/wa-check', requireAuth, async function(req, res) {
    var cookie = req.body.cookie;
    if (!cookie) { res.status(400).json({ error: 'Cookie required' }); return; }
    try {
        var pageRes = await fetch('https://business.facebook.com/latest/inbox/wec', {
            headers: {
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'cookie': cookie,
                'sec-fetch-site': 'none',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(15000)
        });
        var html = await pageRes.text();
        var pageID = extractWaPageId(html, pageRes.url, cookie);
        if (html.includes('checkpointSubmitButton') || html.includes('m_login_email') || /checkpoint|login_attempt|force_login/i.test(html.substring(0, 5000))) {
            res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Session requires 2FA or login challenge' }); return;
        }
        if (html.includes('Insufficient Permission') || html.includes('You do not have the necessary permission')) {
            res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Not eligible for this page' }); return;
        }
        if (!/^\d+$/.test(pageID)) {
            res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Invalid pageID' }); return;
        }
        var dtsgMatch = html.match(/"DTSGInitData"[,\[\]\s]*\{[^}]*"token"\s*:\s*"([^"]+)"/);
        var fb_dtsg = dtsgMatch ? dtsgMatch[1] : null;
        if (!fb_dtsg) { res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Could not extract fb_dtsg' }); return; }
        var cuser = (cookie.match(/c_user=(\d+)/) || [])[1] || '';
        var dprVal = (cookie.match(/dpr=([\d.]+)/) || [])[1] || '3';
        var body = [
            'av=' + pageID,
            '__user=' + cuser,
            'dpr=' + Math.round(parseFloat(dprVal)),
            'fb_dtsg=' + encodeURIComponent(fb_dtsg),
            '__crn=comet.bizweb.BusinessCometBizSuiteInboxWhatsAppRoute',
            'fb_api_caller_class=RelayModern',
            'fb_api_req_friendly_name=WhatsAppOnboardingUnifiedInboxSurfaceQuery',
            'server_timestamps=true',
            'variables=' + encodeURIComponent(JSON.stringify({ pageID: pageID, wabaID: '', hasWabaID: false })),
            'doc_id=27161030553583658',
        ].join('&');
        var gqlRes = await fetch('https://business.facebook.com/api/graphql/', {
            method: 'POST',
            headers: { 'accept': '*/*', 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': 'WhatsAppOnboardingUnifiedInboxSurfaceQuery', 'cookie': cookie },
            body: body,
            signal: AbortSignal.timeout(15000)
        });
        if (gqlRes.status === 429) { res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Rate limited' }); return; }
        if (!gqlRes.ok) { res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'GraphQL returned ' + gqlRes.status }); return; }
        var text = await gqlRes.text();
        if (text.includes('Insufficient Permission') || text.includes('You do not have the necessary permission')) {
            res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Not eligible for this page' }); return;
        }
        var jsonStr = text.trim();
        if (jsonStr.startsWith('for(;;);')) jsonStr = jsonStr.replace(/^for\s*\(;;\)\s*;?\s*/, '');
        var json;
        try { json = JSON.parse(jsonStr); } catch(e) { res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Invalid GraphQL JSON' }); return; }
        var eligibleData = json?.data?.xfb_is_page_eligible_for_wa_link;
        if (eligibleData === undefined || eligibleData === null) { res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Unexpected response structure' }); return; }
        res.json({
            eligible: eligibleData?.is_eligible === true,
            banReason: eligibleData?.ban_reason || null,
            linkedNumber: eligibleData?.page_whatsapp_number || null,
            error: null
        });
    } catch(e) {
        if (e.name === 'AbortError' || e.name === 'TimeoutError' || (e.message && (e.message.includes('fetch') || e.message.includes('network')))) {
            res.json({ eligible: false, banReason: null, linkedNumber: null, error: 'Service unavailable' });
        } else {
            res.json({ eligible: false, banReason: null, linkedNumber: null, error: e.message });
        }
    }
});

function extractWaPageId(html, finalUrl, cookie) {
    var m = finalUrl.match(/[?&]asset_id[=_](\d{14,17})/); if (m) return m[1];
    m = finalUrl.match(/[?&]page_id[=_](\d{14,17})/); if (m) return m[1];
    m = finalUrl.match(/\/pages\/(\d{14,17})\//); if (m) return m[1];
    var patterns = [
        /"pageID"\s*:\s*"(\d{14,17})"/, /"page_id"\s*:\s*(\d{14,17})/,
        /"localScopeID"\s*:\s*"(\d{14,17})"/, /"assetID"\s*:\s*"(\d{14,17})"/,
        /"selectedPageId"\s*:\s*"(\d{14,17})"/, /"ownerId"\s*:\s*"(\d{14,17})"/,
        /"business_id"\s*:\s*(\d{14,17})/, /"actorID"\s*:\s*"(\d{14,17})"/,
        /"id"\s*:\s*"(\d{15,17})"[^}]{0,80}(?:page|business|Page)/i
    ];
    for (var i = 0; i < patterns.length; i++) { m = html.match(patterns[i]); if (m) return m[1]; }
    var cuser = (cookie.match(/c_user=(\d+)/) || [])[1];
    if (cuser) return cuser;
    return null;
}

// ── SkySys Push API Proxy (auth required) ──
var SKY_URL = 'https://skysysx.net';

app.post('/api/sky/push', requireAuth, async function(req, res) {
    console.log('[Proxy] Sky POST /push');
    try {
        var r = await fetch(SKY_URL + '/e/boss', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: req.body
        });
        var data = await r.json();
        console.log('[Proxy] Sky POST /push → ' + r.status);
        res.status(r.status).json(data);
    } catch(e) { console.error('[Proxy] Sky POST error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/sky/status/:jobId', requireAuth, async function(req, res) {
    console.log('[Proxy] Sky GET /status/' + req.params.jobId);
    try {
        var r = await fetch(SKY_URL + '/api/status/' + req.params.jobId);
        var data = await r.json();
        console.log('[Proxy] Sky GET /status/' + req.params.jobId + ' → ' + r.status);
        res.status(r.status).json(data);
    } catch(e) { console.error('[Proxy] Sky GET error:', e.message); res.status(500).json({ error: e.message }); }
});

// ── Start Telegram bot ──
var botUsername = '';

console.log('[Bot] Config: token=' + (BOT_TOKEN ? BOT_TOKEN.slice(0, 10) + '...' : 'MISSING') + ' app_url=' + APP_URL + ' port=' + (process.env.PORT || 3000));
console.log('[Bot] Node version: ' + process.version);

if (BOT_TOKEN) {
    // Bot info endpoint (for client)
    app.get('/api/bot/info', function(req, res) {
        res.json({ username: botUsername });
    });

    async function handleBotUpdate(update) {
        console.log('[Bot] update id=' + update.update_id + ' from=' + (update.message ? update.message.chat.id : update.callback_query ? update.callback_query.message.chat.id : '?'));
        if (update.message && update.message.text) {
            var msg = update.message;
            if (msg.text === '/start' || msg.text.startsWith('/start ')) {
                var payload = (msg.text.split(' ')[1] || '').trim();
                if (payload.indexOf('login_') === 0) {
                    var did = payload.slice(6);
                    if (/^[A-Za-z0-9-]{8,64}$/.test(did)) {
                        await setJSONex('didchat:' + msg.chat.id, { did: did }, 900000);
                        console.log('[Bot] device login requested chatId=' + msg.chat.id + ' did=' + did.slice(0, 8) + '...');
                    }
                }
                await tg('sendMessage', {
                    chat_id: msg.chat.id,
                    text: 'Welcome to Sheet Submit. Tap the button below to log in:',
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Login', callback_data: 'login' }]]
                    }
                });
            } else if (msg.text === '/myid') {
                await tg('sendMessage', { chat_id: msg.chat.id, text: 'Your Telegram ID: ' + msg.chat.id });
            }
        }
        if (update.callback_query) {
            var cb = update.callback_query;
            if (cb.data === 'login') {
                var token = generateToken();
                var url = APP_URL + '/api/auth/telegram?token=' + token;
                var loginReq = { chatId: cb.message.chat.id };
                var didChat = await getJSON('didchat:' + cb.message.chat.id);
                if (didChat && didChat.did) {
                    loginReq.did = didChat.did;
                    url += '&device=' + didChat.did;
                    await delKey('didchat:' + cb.message.chat.id);
                }
                await setJSONex('login:' + token, loginReq, 900000);
                await tg('editMessageText', {
                    chat_id: cb.message.chat.id,
                    message_id: cb.message.message_id,
                    text: 'Login link ready:',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Open URL', url: url }],
                            [{ text: 'Copy URL', copy_text: { text: url } }]
                        ]
                    }
                });
                await tg('answerCallbackQuery', { callback_query_id: cb.id });
            }
        }
    }

    // Webhook endpoint for Telegram updates
    app.post('/webhook/tg', function(req, res) {
        res.sendStatus(200);
        handleBotUpdate(req.body);
    });

    // Use webhook on Railway (public URL), fallback to polling locally
    var usingWebhook = false;

    async function startBot() {
        try {
            var info = await tg('getMe');
            if (!info.ok) throw new Error('getMe failed');
            botUsername = info.result.username;
            console.log('[Bot] @' + botUsername + ' id=' + info.result.id);
            await setJSON('bot:info', { username: botUsername });

            var hasPublicUrl = !!(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.APP_URL);
            if (hasPublicUrl) {
                var webhookUrl = APP_URL + '/webhook/tg';
                var result = await tg('setWebhook', { url: webhookUrl, allowed_updates: ['message', 'callback_query'] });
                if (result.ok) {
                    usingWebhook = true;
                    console.log('[Bot] Webhook set to ' + webhookUrl);
                } else {
                    console.log('[Bot] Webhook failed, falling back to polling: ' + (result.description || ''));
                }
            }

            if (!usingWebhook) {
                await tg('deleteWebhook');
                console.log('[Bot] No public URL, using long-polling');
                var pollingOffset = 0;
                async function poll() {
                    try {
                        var data = await tg('getUpdates', { offset: pollingOffset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
                        if (data.ok && data.result) {
                            if (data.result.length > 0) console.log('[Bot] received ' + data.result.length + ' update(s)');
                            for (var update of data.result) {
                                pollingOffset = update.update_id + 1;
                                await handleBotUpdate(update);
                            }
                        }
                    } catch(e) { console.error('[Bot] Poll err:', e.message); }
                    setTimeout(poll, 2000);
                }
                poll();
            }
        } catch(e) {
            console.error('[Bot] init error:', e.message);
            setTimeout(startBot, 10000);
        }
    }

    startBot();
}

// ── Serve static files (after API routes) ──
app.use(express.static(ROOT));

// ── SPA fallback (last) ──
app.get('*', function(req, res) {
    res.sendFile(path.join(ROOT, 'index.html'));
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, async function() {
    console.log('Server listening on http://localhost:' + PORT);
    try {
        var backup = require('./backup.js');
        await backup.restoreFromBackup(redis);
        backup.startBackupLoop(redis);
    } catch (e) {
        console.error('[Backup] Init error: ' + e.message);
    }
});
