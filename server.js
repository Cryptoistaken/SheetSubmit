require('dotenv').config();
var express = require('express');
var path = require('path');
var Redis = require('ioredis');

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
    try {
        await redis.set(key(k), JSON.stringify(val));
        return true;
    } catch { return false; }
}

async function delKey(k) {
    try {
        await redis.del(key(k));
        return true;
    } catch { return false; }
}

// ── API: Files ──
app.get('/api/files', async function(req, res) {
    var files = await getJSON('files');
    res.json(files || []);
});

app.post('/api/files', async function(req, res) {
    var files = await getJSON('files') || [];
    var file = req.body;
    file.createdAt = Date.now();
    file.updatedAt = Date.now();
    files.unshift(file);
    await setJSON('files', files);
    res.json(file);
});

app.put('/api/files/:id', async function(req, res) {
    var files = await getJSON('files') || [];
    var idx = files.findIndex(function(f) { return f.id === req.params.id; });
    if (idx === -1) { res.status(404).json({ error: 'not found' }); return; }
    var updates = req.body;
    Object.keys(updates).forEach(function(k) { files[idx][k] = updates[k]; });
    files[idx].updatedAt = Date.now();
    await setJSON('files', files);
    res.json(files[idx]);
});

app.delete('/api/files/:id', async function(req, res) {
    var files = await getJSON('files') || [];
    files = files.filter(function(f) { return f.id !== req.params.id; });
    await setJSON('files', files);
    await delKey('rows:' + req.params.id);
    await delKey('undo:' + req.params.id);
    await delKey('redo:' + req.params.id);
    res.json({ ok: true });
});

// ── API: Rows ──
app.get('/api/files/:id/rows', async function(req, res) {
    var rows = await getJSON('rows:' + req.params.id);
    res.json(rows || []);
});

app.put('/api/files/:id/rows', async function(req, res) {
    await setJSON('rows:' + req.params.id, req.body);
    res.json({ ok: true });
});

// ── API: Undo/Redo stacks ──
app.get('/api/files/:id/stack/:name', async function(req, res) {
    var stack = await getJSON(req.params.name + ':' + req.params.id);
    res.json(stack || []);
});

app.put('/api/files/:id/stack/:name', async function(req, res) {
    await setJSON(req.params.name + ':' + req.params.id, req.body);
    res.json({ ok: true });
});

// ── Health check ──
app.get('/api/health', function(req, res) {
    res.json({ status: redis.status === 'ready' ? 'ok' : redis.status });
});

// ── Serve static files ──
app.use(express.static(__dirname));

// ── SPA fallback ──
app.get('*', function(req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('Server listening on http://localhost:' + PORT);
});
