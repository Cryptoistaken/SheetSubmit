(function() {
var __ss = window.__ss;
var _totpCache = new Map();

// ── TOTP (same algorithm as IG) ──
__ss.generateTOTP = function(secret) {
    return _generateTOTP(secret);
};

function _generateTOTP(secret) {
    if (!secret) return '';
    secret = secret.replace(/\s/g, '').toUpperCase();
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var bits = '';
    for (var i = 0; i < secret.length; i++) {
        var val = alphabet.indexOf(secret[i]);
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    var bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (var i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.substr(i * 8, 8), 2);
    }
    return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
        .then(function(key) {
            var epoch = Math.floor(Date.now() / 1000);
            var time = Math.floor(epoch / 30);
            var timeBytes = new ArrayBuffer(8);
            new DataView(timeBytes).setUint32(4, time, false);
            return crypto.subtle.sign('HMAC', key, new Uint8Array(timeBytes));
        })
        .then(function(hash) {
            var h = new Uint8Array(hash);
            var offset = h[h.length - 1] & 0x0f;
            var code = ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff);
            return (code % 1000000).toString().padStart(6, '0');
        });
}

// ── Extract c_user from cookies string ──
function _extractCUser(cookies) {
    if (!cookies) return null;
    var m = cookies.match(/c_user=(\d+)/);
    return m ? m[1] : null;
}

// ── Column validation ──
function _validateCell(colKey, value) {
    if (!value) return { valid: true };
    if (colKey === 'cookies') {
        if (!value.match(/c_user=\d+/)) return { valid: false, msg: 'Cookies must contain c_user=ID' };
        return { valid: true };
    }
    if (colKey === 'twofakey') {
        var cleaned = value.replace(/[\s\-]/g, '').toUpperCase();
        if (cleaned.length < 10) return { valid: false, msg: '2FA key too short' };
        if (!cleaned.match(/^[A-Z2-7]+$/)) return { valid: false, msg: '2FA key must be base32 (A-Z, 2-7)' };
        return { valid: true };
    }
    if (colKey === 'uid') {
        if (!value.match(/^\d+$/)) return { valid: false, msg: 'UID must be digits only' };
        return { valid: true };
    }
    return { valid: true };
}

__ss.registerFileBehavior('fb_cookie', {

    onCellChange: function(rowIdx, colKey, value, state) {
        var validation = _validateCell(colKey, value);
        var cellKey = rowIdx + ':' + colKey;
        if (!validation.valid) {
            state.invalidCells.add(cellKey);
            __ss.showToast('Invalid: ' + validation.msg);
        } else {
            state.invalidCells.delete(cellKey);
        }

        var row = state.rows[rowIdx];

        if (colKey === 'cookies') {
            var uid = _extractCUser(value);
            if (uid) {
                if (!row.uid) {
                    row.uid = uid;
                }
            } else {
                row.wa_status = '';
                row.wa_ban_reason = null;
            }
        }

        // Warn if uid manually changed and doesn't match cookies
        if (colKey === 'uid' && value && row.cookies) {
            var extracted = _extractCUser(row.cookies);
            if (extracted && extracted !== value.trim()) {
                __ss.showToast('UID doesn\'t match c_user in cookies');
            }
        }
    },

    onDotDoubleTap: async function(row) {
        if (!row.twofakey) return null;
        var step = Math.floor(Date.now() / 30000);
        var cacheKey = row.twofakey + ':' + step;
        var cached = _totpCache.get(cacheKey);
        if (cached) {
            await navigator.clipboard.writeText(cached);
            return { action: 'totp_copied', code: cached };
        }
        var code = await _generateTOTP(row.twofakey);
        if (code) {
            _totpCache.set(cacheKey, code);
            if (_totpCache.size > 100) {
                var firstKey = _totpCache.keys().next().value;
                _totpCache.delete(firstKey);
            }
            await navigator.clipboard.writeText(code);
            return { action: 'totp_copied', code: code };
        }
        return null;
    },

    onDotHold: function(row, logs) {
        var _logMap = {};
        var key = row.uid || row.cookies;
        logs.forEach(function(l) { if (l.username) _logMap[l.username] = l; });
        var rowLogs = _logMap[key] ? [_logMap[key]] : [];
        return { action: 'show_logs', logs: rowLogs, label: row.uid || row.cookies };
    },

    checkAccounts: async function(rows, state) {
        var uidRows = [];
        rows.forEach(function(row, idx) {
            var uid = _extractCUser(row.cookies) || row.uid;
            if (uid) {
                if (!row.uid) row.uid = uid;
                uidRows.push({ idx: idx, uid: uid, row: row });
            }
        });
        if (!uidRows.length) { throw new Error('No UIDs found'); }

        var uids = uidRows.map(function(r) { return r.uid; });
        var res = await fetch('/api/fb/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uids: uids })
        });
        if (!res.ok) { var err = await res.text(); throw new Error(err); }
        var data = await res.json();

        uidRows.forEach(function(r) {
            var uid = r.uid;
            if (data.valid.indexOf(uid) !== -1) {
                r.row.status = 'good';
                if (state) {
                    state.apiLogs.push({ username: uid, status: 'done', calls: [{ type: 'check', request: 'UID ' + uid, response: 'valid' }] });
                }
            } else if (data.dead.indexOf(uid) !== -1) {
                r.row.status = 'bad';
                if (state) {
                    state.apiLogs.push({ username: uid, status: 'done', calls: [{ type: 'check', request: 'UID ' + uid, response: 'dead' }] });
                }
            } else {
                r.row.status = 'pending';
                if (state) {
                    state.apiLogs.push({ username: uid, status: 'done', calls: [{ type: 'check', request: 'UID ' + uid, response: 'uncertain' }] });
                }
            }
        });

        return { total: uidRows.length, valid: data.valid.length, dead: data.dead.length, uncertain: data.uncertain.length };
    }
});

})();
