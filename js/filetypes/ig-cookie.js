(function() {
var __ss = window.__ss;

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
            if (masterPass) {
                state.rows[rowIdx].password = masterPass;
            }
        }
    },

    // Double-click on dot column: generate TOTP and copy
    onDotDoubleTap: async function(row) {
        if (!row.twofa) return null;
        var adapter = __ss.getAdapter('ig-cookie');
        if (!adapter) return null;
        var code = await adapter.generateTOTP(row.twofa);
        if (code) {
            await navigator.clipboard.writeText(code);
            return { action: 'totp_copied', code: code };
        }
        return null;
    },

    // Long-press on dot column: return row log
    onDotHold: function(row, logs) {
        var rowLogs = logs.filter(function(l) { return l.username === row.username; });
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
