'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FB_PATH = path.join(ROOT, 'js', 'filetypes', 'fbcookie.js');
const IG_PATH = path.join(ROOT, 'js', 'filetypes', 'igcookie.js');

const FB_SRC = fs.readFileSync(FB_PATH, 'utf8');
const IG_SRC = fs.readFileSync(IG_PATH, 'utf8');

// ── helpers ─────────────────────────────────────────────────────────────

// Return src from `marker` through the end of the first balanced brace block.
function extractBalanced(src, marker) {
    const start = src.indexOf(marker);
    assert.ok(start !== -1, 'marker not found: ' + marker);
    const open = src.indexOf('{', start);
    assert.ok(open !== -1, 'no opening brace after marker: ' + marker);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces after marker: ' + marker);
}

// ── HARD GATE ──────────────────────────────────────────────────────────

test('HARD GATE: node --check passes for both filetype files', () => {
    for (const file of [FB_PATH, IG_PATH]) {
        assert.doesNotThrow(
            () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
            file + ' must pass node --check'
        );
    }
});

// ── fbcookie.js ─────────────────────────────────────────────────────────
// Source under test (onCellChange cookies branch):
//   var uid = _extractCUser(value);
//   if (uid) {
//       if (!row.uid) { row.uid = uid; }
//   } else {
//       row.wa_status = '';
//       row.wa_ban_reason = null;
//   }

test('fbcookie: clearing cookies clears wa_status AND wa_ban_reason together', () => {
    const onCellChange = extractBalanced(FB_SRC, 'onCellChange: function(rowIdx, colKey, value, state)');
    const cookiesBranch = extractBalanced(onCellChange, "if (colKey === 'cookies')");

    // The else branch (value has no c_user) must clear BOTH fields in the same block
    // — never leave a stale ban reason behind.
    assert.match(
        cookiesBranch,
        /\}\s*else\s*\{[\s\S]*?row\.wa_status\s*=\s*'';[\s\S]*?row\.wa_ban_reason\s*=\s*(?:null|undefined);[\s\S]*?\}/,
        'else branch must set wa_status to "" AND wa_ban_reason to null in the same block'
    );

    // wa_ban_reason may only ever be assigned null in this file (never a stale value).
    const banAssignments = (FB_SRC.match(/row\.wa_ban_reason\s*=/g) || []).length;
    const banNulls = (FB_SRC.match(/row\.wa_ban_reason\s*=\s*null;/g) || []).length;
    assert.ok(banAssignments >= 1, 'expected at least one wa_ban_reason reset');
    assert.strictEqual(banAssignments, banNulls, 'every wa_ban_reason assignment must be to null');

    // The reset lines must be adjacent siblings in the same else block.
    const resetLines = (cookiesBranch.match(/row\.wa_(?:status|ban_reason)\s*=/g) || []);
    assert.strictEqual(resetLines.length, 2, 'exactly one wa_status + one wa_ban_reason reset expected');
});

test('fbcookie: uid is set ONLY when currently empty (no unconditional overwrite)', () => {
    const onCellChange = extractBalanced(FB_SRC, 'onCellChange: function(rowIdx, colKey, value, state)');
    const cookiesBranch = extractBalanced(onCellChange, "if (colKey === 'cookies')");
    const ifUidBlock = extractBalanced(cookiesBranch, 'if (uid)');

    // The assignment must be nested inside `if (!row.uid)`.
    assert.match(
        ifUidBlock,
        /if\s*\(\s*!row\.uid\s*\)\s*\{[\s\S]*?row\.uid\s*=\s*uid;[\s\S]*?\}/,
        'row.uid = uid must be guarded by if (!row.uid)'
    );

    // checkAccounts must use the same guarded single-line pattern.
    const checkAccounts = extractBalanced(FB_SRC, 'checkAccounts: async function');
    assert.match(
        checkAccounts,
        /if\s*\(\s*!row\.uid\s*\)\s*row\.uid\s*=\s*uid;/,
        'checkAccounts must also guard its uid assignment'
    );

    // No "UID overwritten" toast may exist anywhere in the file.
    assert.doesNotMatch(FB_SRC, /overwrit/i, 'no "overwritten" toast string may exist');

    // The present-UID branch must not reset wa fields.
    assert.doesNotMatch(ifUidBlock, /wa_status|wa_ban_reason/, 'present-UID branch must not reset wa fields');
});

test('fbcookie: reset only proceeds when c_user is genuinely missing', () => {
    const onCellChange = extractBalanced(FB_SRC, 'onCellChange: function(rowIdx, colKey, value, state)');
    const cookiesBranch = extractBalanced(onCellChange, "if (colKey === 'cookies')");
    const ifUidBlock = extractBalanced(cookiesBranch, 'if (uid)');

    // The reset must be in the `else` of the c_user extraction check.
    assert.match(
        cookiesBranch,
        /if\s*\(\s*uid\s*\)[\s\S]*?\}\s*else\s*\{[\s\S]*?row\.wa_status\s*=\s*'';[\s\S]*?row\.wa_ban_reason\s*=\s*null;[\s\S]*?\}/,
        'wa reset must live in the else branch of the c_user presence check'
    );

    // The reset must NOT run when a c_user IS present.
    assert.doesNotMatch(ifUidBlock, /wa_status|wa_ban_reason/, 'wa reset must NOT run when c_user is present');
});

test('fbcookie: branch logic simulation (source extracted and executed)', () => {
    const onCellChange = extractBalanced(FB_SRC, 'onCellChange: function(rowIdx, colKey, value, state)');
    const cookiesBranch = extractBalanced(onCellChange, "if (colKey === 'cookies')");
    const simulate = new Function('_extractCUser', 'row', 'value', [
        'var colKey = "cookies";',
        cookiesBranch,
        'return row;',
    ].join('\n'));

    const extract = (c) => (c && c.match(/c_user=(\d+)/)) ? c.match(/c_user=(\d+)/)[1] : null;

    // 1) empty uid + cookies with c_user → uid extracted
    const r1 = simulate(extract, {}, 'c_user=12345; xs=abc');
    assert.strictEqual(r1.uid, '12345', 'uid should be extracted when empty');

    // 2) existing uid + cookies with DIFFERENT c_user → uid preserved
    const r2 = simulate(extract, { uid: '111' }, 'c_user=99999; xs=abc');
    assert.strictEqual(r2.uid, '111', 'a present uid must never be overwritten');

    // 3) cookies cleared (reset path) → wa cleared, uid untouched
    const r3 = simulate(extract, { uid: '111', wa_status: 'eligible', wa_ban_reason: 'fb blocked' }, '');
    assert.strictEqual(r3.wa_status, '', 'wa_status must clear');
    assert.strictEqual(r3.wa_ban_reason, null, 'wa_ban_reason must null out');
    assert.strictEqual(r3.uid, '111', 'uid must be untouched by a reset');

    // 4) cookies replaced without c_user → same reset, uid untouched
    const r4 = simulate(extract, { uid: '111', wa_status: 'eligible' }, 'datr=xyz');
    assert.strictEqual(r4.wa_status, '', 'wa_status must clear when c_user missing');
    assert.strictEqual(r4.wa_ban_reason, null, 'wa_ban_reason must null out when c_user missing');
    assert.strictEqual(r4.uid, '111', 'uid must be untouched');

    // 5) cookies with matching c_user + existing uid → wa status NOT reset
    const r5 = simulate(extract, { uid: '111', wa_status: 'eligible', wa_ban_reason: 'x' }, 'c_user=111; xs=a');
    assert.strictEqual(r5.wa_status, 'eligible', 'wa status must survive when c_user present');
    assert.strictEqual(r5.wa_ban_reason, 'x', 'ban reason must survive when c_user present');
});

// ── igcookie.js ─────────────────────────────────────────────────────────
// Source under test (onCellChange):
//   if (colKey === 'username' && value) {
//       var masterPass = state.rows[0] ? (state.rows[0].password || '') : '';
//       if (masterPass && !state.rows[rowIdx].password) {
//           state.rows[rowIdx].password = masterPass;
//       }
//   }

test('igcookie: autofill only writes password when the row password is empty', () => {
    const onCellChange = extractBalanced(IG_SRC, 'onCellChange: function(rowIdx, colKey, value, state)');
    const usernameBlock = extractBalanced(onCellChange, "if (colKey === 'username' && value)");

    // The write must be guarded by `masterPass && !state.rows[rowIdx].password`.
    assert.match(
        usernameBlock,
        /if\s*\(\s*masterPass\s*&&\s*!state\.rows\[rowIdx\]\.password\s*\)\s*\{[\s\S]*?state\.rows\[rowIdx\]\.password\s*=\s*masterPass;[\s\S]*?\}/,
        'password write must be guarded by !state.rows[rowIdx].password'
    );

    // The assignment must appear exactly once — no unguarded overwrite path.
    const assignmentCount = (usernameBlock.match(/state\.rows\[rowIdx\]\.password\s*=\s*masterPass;/g) || []).length;
    assert.strictEqual(assignmentCount, 1, 'password autofill assignment must appear exactly once');
});

test('igcookie: autofill logic simulation (source extracted and executed)', () => {
    const onCellChange = extractBalanced(IG_SRC, 'onCellChange: function(rowIdx, colKey, value, state)');
    const usernameBlock = extractBalanced(onCellChange, "if (colKey === 'username' && value)");
    const simulate = new Function('state', 'rowIdx', 'colKey', 'value', [
        'var masterPass = state.rows[0] ? (state.rows[0].password || "") : "";',
        usernameBlock,
        'return state.rows[rowIdx];',
    ].join('\n'));

    // 1) target password empty → auto-filled from master row
    const s1 = { rows: [{ username: 'master', password: 'secret' }, { username: '', password: '' }] };
    const r1 = simulate(s1, 1, 'username', 'newuser');
    assert.strictEqual(r1.password, 'secret', 'empty password should be auto-filled');

    // 2) target password present → preserved, never overwritten
    const s2 = { rows: [{ username: 'master', password: 'secret' }, { username: '', password: 'keepme' }] };
    const r2 = simulate(s2, 1, 'username', 'newuser');
    assert.strictEqual(r2.password, 'keepme', 'existing password must never be overwritten');

    // 3) no master password → nothing written
    const s3 = { rows: [{ username: 'master', password: '' }, { username: '', password: '' }] };
    const r3 = simulate(s3, 1, 'username', 'newuser');
    assert.strictEqual(r3.password, '', 'no autofill when master password missing');
});