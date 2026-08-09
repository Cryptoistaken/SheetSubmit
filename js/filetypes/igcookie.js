(function() {
var __ss = window.__ss;

var _totpCache = new Map();
var _logMap = null;

__ss.registerFileBehavior('ig_cookie', {

    // Called when a row is about to be committed via quick edit bar
    // Auto-fill password from first row's password
    onBeforeCommit: function(rowIdx, colKey, value, state) {
        if (colKey === 'username' && value && state.rows.length > 0) {
            var masterPass = state.rows[0].password || '';
            if (masterPass && !row[0]) {
                // password cell is empty, don't auto-fill row-level
            }
        }
        return value;
    },

    // Auto-fill password when username is pasted/set
    onCellChange: function(rowIdx, colKey, value, state) {
        if (colKey === 'username' && value) {
            var masterPass = state.rows[0] ? (state.rows[0].password || '') : '';
            if (masterPass && !state.rows[rowIdx].password) {
                state.rows[rowIdx].password = masterPass;
            }
        }
    },

    // Double-click on dot column: generate TOTP and copy
    onDotDoubleTap: async function(row) {
        if (!row.twofa) return null;
        var adapter = __ss.getAdapter('ig-cookie');
        if (!adapter) return null;
        var step = Math.floor(Date.now() / 30000);
        var cacheKey = row.twofa + ':' + step;
        var cached = _totpCache.get(cacheKey);
        if (cached) {
            await navigator.clipboard.writeText(cached);
            return { action: 'totp_copied', code: cached };
        }
        var code = await adapter.generateTOTP(row.twofa);
        if (code) {
            _totpCache.set(cacheKey, code);
            // Limit cache size
            if (_totpCache.size > 100) {
                var firstKey = _totpCache.keys().next().value;
                _totpCache.delete(firstKey);
            }
            await navigator.clipboard.writeText(code);
            return { action: 'totp_copied', code: code };
        }
        return null;
    },

    // Long-press on dot column: return row log
    onDotHold: function(row, logs) {
        if (!_logMap || _logMap._logs !== logs) {
            _logMap = { _logs: logs };
            logs.forEach(function(l) { if (l.username) _logMap[l.username] = l; });
        }
        var rowLogs = _logMap[row.username] ? [_logMap[row.username]] : [];
        return { action: 'show_logs', logs: rowLogs };
    },

    // Sync: process a single row
    syncRow: async function(row, state) {
        var adapter = __ss.getAdapter('ig-cookie');
        if (!adapter) throw new Error('IG Cookie adapter not loaded');
        var masterPass = state.rows[0] ? (state.rows[0].password || '') : '';
        var password = row.password || masterPass;
        if (!row.username || !password || !row.twofa) {
            throw new Error('Missing username, password, or 2fa key');
        }
        return await adapter.syncRow(row, password);
    }
});

})();
