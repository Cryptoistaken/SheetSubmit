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
var redisOpts = {};
if (redisUrl.startsWith('rediss://') || redisUrl.includes('upstash.io')) {
    redisOpts.tls = {};
}
var redis = new Redis(redisUrl, redisOpts);

redis.on('error', function(err) {
    console.error('Redis connection error:', err.message);
});

redis.on('connect', function() {
    console.log('Connected to Redis');
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
    var session = await getJSON('session:' + sessionId);
    if (!session) { res.status(401).json({ error: 'Session expired' }); return; }
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

    var sessionId = generateToken();
    await setJSONex('session:' + sessionId, { userId: userInfo.id }, 2592000000);
    await delKey('login:' + token);

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
    if (sessionId) await delKey('session:' + sessionId);
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
    }
    console.log('[Auth] me: user=' + (user ? user.username || user.firstName || user.id : 'null'));
    res.json(user || null);
});

// ── Ownership check middleware ──
async function requireFileAccess(req, res, next) {
    var result = await findUserFile(req.userId, req.params.id);
    if (!result.file) { res.status(404).json({ error: 'file not found' }); return; }
    req.file = result.file;
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
    var result = await findUserFile(req.userId, req.params.id);
    if (result.idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var updates = req.body;
    Object.keys(updates).forEach(function(k) { result.files[result.idx][k] = updates[k]; });
    result.files[result.idx].updatedAt = Date.now();
    await setJSON('files:' + req.userId, result.files);
    res.json(result.files[result.idx]);
});

app.delete('/api/files/:id', requireAuth, requireFileAccess, async function(req, res) {
    var result = await findUserFile(req.userId, req.params.id);
    if (result.idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var file = result.files.splice(result.idx, 1)[0];
    file.deletedAt = Date.now();
    var archived = await getJSON('archive:' + req.userId) || [];
    archived.unshift(file);
    await setJSON('files:' + req.userId, result.files);
    await setJSON('archive:' + req.userId, archived);
    res.json({ ok: true });
});

// ── API: Batch persist (auth required) ──
app.put('/api/files/:id/persist', requireAuth, requireFileAccess, async function(req, res) {
    var body = req.body;
    var promises = [];
    if (body.rows !== undefined) promises.push(setJSON('rows:' + req.params.id, body.rows));
    if (body.logs !== undefined) promises.push(setJSON('logs:' + req.params.id, body.logs));
    if (body.undo !== undefined) promises.push(setJSON('undo:' + req.params.id, body.undo));
    if (body.redo !== undefined) promises.push(setJSON('redo:' + req.params.id, body.redo));
    if (body.dataCount !== undefined) {
        var result = await findUserFile(req.userId, req.params.id);
        if (result.idx !== -1) {
            result.files[result.idx].dataCount = body.dataCount;
            result.files[result.idx].updatedAt = Date.now();
            promises.push(setJSON('files:' + req.userId, result.files));
        }
    }
    await Promise.all(promises);
    res.json({ ok: true });
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
    await delKey('rows:' + req.params.id);
    await delKey('undo:' + req.params.id);
    await delKey('redo:' + req.params.id);
    await delKey('sync:' + req.params.id);
    await delKey('logs:' + req.params.id);
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

// ── API: Logs (auth required) ──
app.get('/api/files/:id/logs', requireAuth, requireFileAccess, async function(req, res) {
    var logs = await getJSON('logs:' + req.params.id);
    res.json(logs || []);
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
                await setJSONex('login:' + token, { chatId: cb.message.chat.id }, 900000);
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
app.listen(PORT, function() {
    console.log('Server listening on http://localhost:' + PORT);
});
