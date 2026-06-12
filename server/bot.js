(function() {
var __ss = window.__ss = window.__ss || {};
var express = require('express');
var crypto = require('crypto');

module.exports = function(app, redis) {

    var BOT_TOKEN = process.env.TG_BOT_TOKEN;
    var APP_URL = process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000);
    var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

    // ── Helpers ──
    function key(k) { return 'ss:' + k; }

    async function getJSON(k) {
        try {
            var raw = await redis.get(key(k));
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    async function setJSON(k, val) {
        try { await redis.set(key(k), JSON.stringify(val)); } catch {}
    }

    async function delKey(k) {
        try { await redis.del(key(k)); } catch {}
    }

    function generateToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    // ── Telegram Bot API helper ──
    async function tg(method, body) {
        var res = await fetch(TG_API + '/' + method, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return res.json();
    }

    // ── Poll Telegram for updates (long polling) ──
    var pollingOffset = 0;

    async function pollUpdates() {
        try {
            var data = await tg('getUpdates', {
                offset: pollingOffset,
                timeout: 30,
                allowed_updates: ['message']
            });
            if (data.ok && data.result) {
                for (var update of data.result) {
                    pollingOffset = update.update_id + 1;
                    await handleUpdate(update);
                }
            }
        } catch(e) {
            console.error('Poll error:', e.message);
        }
        setTimeout(pollUpdates, 1000);
    }

    async function handleUpdate(update) {
        var msg = update.message;
        if (!msg || !msg.text) return;

        if (msg.text === '/start') {
            var token = generateToken();
            var loginUrl = APP_URL + '/api/auth/telegram?token=' + token;
            var shortUrl = loginUrl;

            await setJSON('login:' + token, {
                chatId: msg.chat.id,
                createdAt: Date.now()
            });

            await tg('sendMessage', {
                chat_id: msg.chat.id,
                text: '🔐 Click the button below to login to Sheet Submit:',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Login to Sheet Submit', url: shortUrl }
                        ],
                        [
                            { text: '📋 Copy Login Link', callback_data: 'copy_link:' + token }
                        ]
                    ]
                }
            });
        }

        if (msg.text === '/myid') {
            await tg('sendMessage', {
                chat_id: msg.chat.id,
                text: 'Your Telegram ID: ' + msg.chat.id
            });
        }
    }

    // ── Handle callback queries (copy link button) ──
    async function pollCallbacks() {
        try {
            var data = await tg('getUpdates', {
                offset: pollingOffset,
                timeout: 30,
                allowed_updates: ['callback_query']
            });
            if (data.ok && data.result) {
                for (var update of data.result) {
                    pollingOffset = update.update_id + 1;
                    if (update.callback_query) {
                        var cb = update.callback_query;
                        if (cb.data && cb.data.startsWith('copy_link:')) {
                            var token = cb.data.replace('copy_link:', '');
                            var loginUrl = APP_URL + '/api/auth/telegram?token=' + token;
                            await tg('sendMessage', {
                                chat_id: cb.message.chat.id,
                                text: '📋 Copy this link and open it in your browser:\n\n' + loginUrl,
                                parse_mode: 'HTML'
                            });
                            await tg('answerCallbackQuery', { callback_query_id: cb.id });
                        }
                    }
                }
            }
        } catch(e) {}
        setTimeout(pollCallbacks, 1000);
    }

    // Start polling
    if (BOT_TOKEN) {
        tg('getMe').then(function(botInfo) {
            console.log('Bot started: @' + botInfo.result.username);
            pollUpdates();
        }).catch(function(e) {
            console.error('Bot start failed:', e.message);
        });
    }

    // ── Auth routes ──

    // Telegram login callback
    app.get('/api/auth/telegram', async function(req, res) {
        var token = req.query.token;
        if (!token) { res.status(400).send('Missing token'); return; }

        var loginData = await getJSON('login:' + token);
        if (!loginData) { res.status(400).send('Invalid or expired token'); return; }
        if (Date.now() - loginData.createdAt > 300000) {
            await delKey('login:' + token);
            res.status(400).send('Token expired'); return;
        }

        // Get user info from Telegram
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
                // Try to get profile photo
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

        // Save user profile
        await setJSON('user:' + userInfo.id, {
            id: userInfo.id,
            firstName: userInfo.firstName,
            lastName: userInfo.lastName,
            username: userInfo.username,
            photoUrl: userInfo.photoUrl,
            lastLogin: Date.now()
        });

        // Create session
        var sessionId = generateToken();
        await setJSON('session:' + sessionId, {
            userId: userInfo.id,
            createdAt: Date.now()
        });

        // Delete used login token
        await delKey('login:' + token);

        // Set cookie and redirect
        res.setHeader('Set-Cookie', 'session=' + sessionId + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
        res.redirect('/');
    });

    // Logout
    app.get('/api/auth/logout', async function(req, res) {
        var session = getSession(req);
        if (session) {
            var cookies = req.headers.cookie || '';
            var match = cookies.match(/session=([^;]+)/);
            if (match) await delKey('session:' + match[1]);
        }
        res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
        res.json({ ok: true });
    });

    // Get current user
    app.get('/api/auth/me', async function(req, res) {
        var session = getSession(req);
        if (!session) { res.json(null); return; }
        var user = await getJSON('user:' + session.userId);
        res.json(user || null);
    });

    // ── Session helper ──
    function getSession(req) {
        var cookies = req.headers.cookie || '';
        var match = cookies.match(/session=([^;]+)/);
        return match ? match[1] : null;
    }

    async function requireAuth(req, res, next) {
        var sessionId = getSession(req);
        if (!sessionId) { res.status(401).json({ error: 'Not authenticated' }); return; }
        var session = await getJSON('session:' + sessionId);
        if (!session) { res.status(401).json({ error: 'Session expired' }); return; }
        req.userId = session.userId;
        next();
    }

    // Export for use in other routes
    app.locals.requireAuth = requireAuth;
    app.locals.getSession = getSession;

    return { requireAuth: requireAuth, getSession: getSession };
};

})();
