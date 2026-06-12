require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var express = require('express');
var path = require('path');
var Redis = require('ioredis');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');

var app = express();
app.use(express.json({ limit: '10mb' }));

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

async function delKey(k) {
    try { await redis.del(key(k)); return true; }
    catch { return false; }
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
    var res = await fetch(TG_API + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
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

    var loginData = await getJSON('login:' + token);
    if (!loginData) { res.status(400).send('Invalid or expired token'); return; }
    if (Date.now() - loginData.createdAt > 300000) {
        await delKey('login:' + token);
        res.status(400).send('Token expired'); return;
    }

    var userInfo = null;
    try {
        var chatRes = await tg('getChat', { chat_id: loginData.chatId });
        if (chatRes.ok) {
            userInfo = {
                id: loginData.chatId,
                firstName: chatRes.result.first_name || '',
                lastName: chatRes.result.last_name || '',
                username: chatRes.result.username || '',
                photoUrl: null
            };
            try {
                var photosRes = await tg('getUserProfilePhotos', { user_id: loginData.chatId, limit: 1 });
                if (photosRes.ok && photosRes.result.photos.length > 0) {
                    var fileId = photosRes.result.photos[0][photosRes.result.photos[0].length - 1].file_id;
                    var fileRes = await tg('getFile', { file_id: fileId });
                    if (fileRes.ok) {
                        userInfo.photoUrl = 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + fileRes.result.file_path;
                    }
                }
            } catch {}
        }
    } catch {}

    if (!userInfo) { res.status(500).send('Failed to get user info'); return; }

    await setJSON('user:' + userInfo.id, {
        id: userInfo.id,
        firstName: userInfo.firstName,
        lastName: userInfo.lastName,
        username: userInfo.username,
        photoUrl: userInfo.photoUrl,
        lastLogin: Date.now()
    });

    var sessionId = generateToken();
    await setJSON('session:' + sessionId, { userId: userInfo.id, createdAt: Date.now() });
    await delKey('login:' + token);

    res.setHeader('Set-Cookie', 'session=' + sessionId + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
    res.redirect('/');
});

app.get('/api/auth/logout', async function(req, res) {
    var sessionId = getSessionId(req);
    if (sessionId) await delKey('session:' + sessionId);
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
});

app.get('/api/auth/me', async function(req, res) {
    var sessionId = getSessionId(req);
    if (!sessionId) { res.json(null); return; }
    var session = await getJSON('session:' + sessionId);
    if (!session) { res.json(null); return; }
    var user = await getJSON('user:' + session.userId);
    res.json(user || null);
});

// ── API: Files (auth required) ──
app.get('/api/files', requireAuth, async function(req, res) {
    var files = await getJSON('files:' + req.userId) || [];
    res.json(files);
});

app.post('/api/files', requireAuth, async function(req, res) {
    var files = await getJSON('files:' + req.userId) || [];
    var file = req.body;
    file.userId = req.userId;
    file.createdAt = Date.now();
    file.updatedAt = Date.now();
    files.unshift(file);
    await setJSON('files:' + req.userId, files);
    res.json(file);
});

app.put('/api/files/:id', requireAuth, async function(req, res) {
    var files = await getJSON('files:' + req.userId) || [];
    var idx = files.findIndex(function(f) { return f.id === req.params.id; });
    if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var updates = req.body;
    Object.keys(updates).forEach(function(k) { files[idx][k] = updates[k]; });
    files[idx].updatedAt = Date.now();
    await setJSON('files:' + req.userId, files);
    res.json(files[idx]);
});

app.delete('/api/files/:id', requireAuth, async function(req, res) {
    var files = await getJSON('files:' + req.userId) || [];
    var idx = files.findIndex(function(f) { return f.id === req.params.id; });
    if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var file = files.splice(idx, 1)[0];
    file.deletedAt = Date.now();
    var archived = await getJSON('archive:' + req.userId) || [];
    archived.unshift(file);
    await setJSON('files:' + req.userId, files);
    await setJSON('archive:' + req.userId, archived);
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
    var files = await getJSON('files:' + req.userId) || [];
    files.unshift(file);
    await setJSON('archive:' + req.userId, archived);
    await setJSON('files:' + req.userId, files);
    res.json({ ok: true });
});

app.delete('/api/archive/:id', requireAuth, async function(req, res) {
    var archived = await getJSON('archive:' + req.userId) || [];
    archived = archived.filter(function(f) { return f.id !== req.params.id; });
    await setJSON('archive:' + req.userId, archived);
    await delKey('rows:' + req.params.id);
    await delKey('undo:' + req.params.id);
    await delKey('redo:' + req.params.id);
    res.json({ ok: true });
});

// ── API: Rows (auth required) ──
app.get('/api/files/:id/rows', requireAuth, async function(req, res) {
    var rows = await getJSON('rows:' + req.params.id);
    res.json(rows || []);
});

app.put('/api/files/:id/rows', requireAuth, async function(req, res) {
    await setJSON('rows:' + req.params.id, req.body);
    res.json({ ok: true });
});

// ── API: Undo/Redo stacks (auth required) ──
app.get('/api/files/:id/stack/:name', requireAuth, async function(req, res) {
    var stack = await getJSON(req.params.name + ':' + req.params.id);
    res.json(stack || []);
});

app.put('/api/files/:id/stack/:name', requireAuth, async function(req, res) {
    await setJSON(req.params.name + ':' + req.params.id, req.body);
    res.json({ ok: true });
});

// ── API: Sync state (auth required) ──
app.get('/api/files/:id/sync', requireAuth, async function(req, res) {
    var sync = await getJSON('sync:' + req.params.id);
    res.json(sync || { enabled: false });
});

app.put('/api/files/:id/sync', requireAuth, async function(req, res) {
    await setJSON('sync:' + req.params.id, req.body);
    res.json({ ok: true });
});

// ── API: Logs (auth required) ──
app.get('/api/files/:id/logs', requireAuth, async function(req, res) {
    var logs = await getJSON('logs:' + req.params.id);
    res.json(logs || []);
});

app.post('/api/files/:id/logs', requireAuth, async function(req, res) {
    var logs = await getJSON('logs:' + req.params.id) || [];
    logs.unshift(req.body);
    if (logs.length > 200) logs.length = 200;
    await setJSON('logs:' + req.params.id, logs);
    res.json({ ok: true });
});

// ── Health check (no auth) ──
app.get('/api/health', function(req, res) {
    res.json({ status: redis.status === 'ready' ? 'ok' : redis.status });
});

// ── IG Cookie API Proxy (auth required) ──
var IG_API = 'https://igautocookiesofficial.site/api';

app.post('/api/ig/jobs', requireAuth, async function(req, res) {
    try {
        var r = await fetch(IG_API + '/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        var data = await r.json();
        res.status(r.status).json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ig/jobs/:jobId', requireAuth, async function(req, res) {
    try {
        var r = await fetch(IG_API + '/jobs/' + req.params.jobId);
        var data = await r.json();
        res.status(r.status).json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SkySys Push API Proxy (auth required) ──
var SKY_URL = 'https://skysysx.net';

app.post('/api/sky/push', requireAuth, async function(req, res) {
    try {
        var r = await fetch(SKY_URL + '/e/boss', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: req.body
        });
        var data = await r.json();
        res.status(r.status).json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sky/status/:jobId', requireAuth, async function(req, res) {
    try {
        var r = await fetch(SKY_URL + '/api/status/' + req.params.jobId);
        var data = await r.json();
        res.status(r.status).json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Start Telegram bot ──
var botUsername = '';

if (BOT_TOKEN) {
    // Bot info endpoint (for client)
    app.get('/api/bot/info', function(req, res) {
        res.json({ username: botUsername });
    });

    async function handleBotUpdate(update) {
        if (update.message && update.message.text) {
            var msg = update.message;
            if (msg.text === '/start') {
                var token = generateToken();
                await setJSON('login:' + token, { chatId: msg.chat.id, createdAt: Date.now() });
                var loginUrl = APP_URL + '/api/auth/telegram?token=' + token;
                await tg('sendMessage', {
                    chat_id: msg.chat.id,
                    text: 'Click the button below to login to Sheet Submit:',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Login to Sheet Submit', url: loginUrl }],
                            [{ text: 'Copy Login Link', callback_data: 'copy:' + token }]
                        ]
                    }
                });
            } else if (msg.text === '/myid') {
                await tg('sendMessage', { chat_id: msg.chat.id, text: 'Your Telegram ID: ' + msg.chat.id });
            }
        }
        if (update.callback_query) {
            var cb = update.callback_query;
            if (cb.data && cb.data.startsWith('copy:')) {
                var token = cb.data.replace('copy:', '');
                var url = APP_URL + '/api/auth/telegram?token=' + token;
                await tg('sendMessage', { chat_id: cb.message.chat.id, text: 'Copy this link:\n' + url });
                await tg('answerCallbackQuery', { callback_query_id: cb.id });
            }
        }
    }

    // Use long-polling (more reliable than webhook on cloud platforms)
    async function startBot() {
        try {
            var info = await tg('getMe');
            if (!info.ok) throw new Error('getMe failed');
            botUsername = info.result.username;
            console.log('Bot: @' + botUsername);
            await setJSON('bot:info', { username: botUsername });

            await tg('deleteWebhook');
            console.log('Starting long-polling');

            var pollingOffset = 0;
            async function poll() {
                try {
                    var data = await tg('getUpdates', { offset: pollingOffset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
                    if (data.ok && data.result) {
                        for (var update of data.result) {
                            pollingOffset = update.update_id + 1;
                            await handleBotUpdate(update);
                        }
                    }
                } catch(e) { console.error('Poll error:', e.message); }
                setTimeout(poll, 1000);
            }
            poll();
        } catch(e) {
            console.error('Bot init error:', e.message);
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
