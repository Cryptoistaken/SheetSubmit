(function() {
var __ss = window.__ss;
var dom = __ss.dom;

// Only exists inside the Android WebView (bridge registered by the app).
// NOTE: gate on window.Android only — nativeClipboardReady is injected later
// (onPageFinished), after deferred scripts already ran at DOMContentLoaded.
var APP = !!window.Android;

var QS = null;
try { QS = new URLSearchParams(window.location.search); } catch(e) {}
var BUBBLE_MODE = APP && QS !== null && QS.get('bubble') === '1' && QS.get('file');

// ── Gear menu row (Android only) ──
var row = document.getElementById('bubbleMenuRow');
var toggle = document.getElementById('bubbleToggle');

if (APP && row && toggle) {
    row.style.display = '';
    try { toggle.checked = !!window.Android.isBubbleEnabled(); } catch(e) {}

    toggle.addEventListener('change', function() {
        if (toggle.checked) {
            openPicker();
        } else {
            try { window.Android.disableBubble(); } catch(e) {}
            __ss.showToast('Floating bubble off');
        }
    });
} else if (row) {
    window.addEventListener('load', function() {
        if (window.Android) {
            row.style.display = '';
            APP = true;
        }
    });
}

function enableBubble(id, name) {
    try { window.Android.enableBubble(id); } catch(e) {}
    if (toggle) toggle.checked = true;
    __ss.showToast('Floating bubble on — ' + name);
}

function closePicker(ov) {
    ov.classList.remove('open');
    setTimeout(function() {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        if (toggle && toggle.checked) {
            try {
                if (!window.Android.isBubbleEnabled()) {
                    toggle.checked = false;
                }
            } catch(e) {}
        }
    }, 150);
}

function openPicker() {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML =
        '<div class="modal-box">' +
        '<div class="modal-title" style="margin-bottom:6px">Floating bubble</div>' +
        '<div style="font-size:13px;color:var(--text2);margin-bottom:10px;line-height:1.5">Choose an FB Cookie file to show in the mini window</div>' +
        '<div class="bubble-picker" id="bubblePickerList"><div class="bubble-picker-empty">Loading&hellip;</div></div>' +
        '<div class="home-fab-sep"></div>' +
        '<button class="home-fab-item" id="bubbleCreateBtn">' +
        '<span class="home-fab-ic t-fb">+</span>' +
        '<span><span class="home-fab-name">Create new FB Cookie file</span><span class="home-fab-desc">Make a fresh file for the bubble</span></span>' +
        '</button>' +
        '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function() { ov.classList.add('open'); });

    ov.addEventListener('click', function(e) {
        if (e.target === ov) closePicker(ov);
    });

    var list = ov.querySelector('#bubblePickerList');

    __ss.api.getFiles().then(function(files) {
        var fb = (files || []).filter(function(f) { return f.type === 'fb_cookie'; });
        if (!fb.length) {
            list.innerHTML = '<div class="bubble-picker-empty">No FB Cookie files yet — create one below</div>';
            return;
        }
        list.innerHTML = '';
        fb.forEach(function(f) {
            var btn = document.createElement('button');
            btn.className = 'home-fab-item';
            btn.innerHTML =
                '<span class="home-fab-ic t-fb">FB</span>' +
                '<span><span class="home-fab-name">' + __ss.esc(f.name) + '</span>' +
                '<span class="home-fab-desc">' + __ss.esc(new Date(f.updatedAt || Date.now()).toLocaleString()) + '</span></span>';
            btn.addEventListener('click', function() {
                closePicker(ov);
                enableBubble(f.id, f.name);
            });
            list.appendChild(btn);
        });
    }).catch(function() {
        list.innerHTML = '<div class="bubble-picker-empty">Could not load files</div>';
    });

    ov.querySelector('#bubbleCreateBtn').addEventListener('click', function() {
        closePicker(ov);
        __ss.createFile('fb_cookie').then(function() {
            __ss.api.getFiles().then(function(files) {
                var newest = (files || [])[0];
                if (newest) enableBubble(newest.id, newest.name);
            }).catch(function() {});
        });
    });
}

// ── Mini-window mode (?bubble=1&file=<id>) ──
if (BUBBLE_MODE) {
    document.body.classList.add('bubble-mode');
    var fileId = QS.get('file');
    var tries = 0;

    function boot() {
        if (!__ss.currentUser) {
            if (++tries < 40) setTimeout(boot, 300);
            return;
        }
        __ss.openFile(fileId).then(function() {
            if (__ss.state.currentFileType !== 'fb_cookie') {
                __ss.showToast('Bubble file must be FB Cookie type — please re-enable bubble');
                return;
            }
            __ss.bubbleRowLimit = 100;
            getActiveRow();
            automateClipboard();
            window.setInterval(function() {
                if (__ss.refreshSheet) __ss.refreshSheet();
            }, 6000);
            setupBubbleDotHandler();
        }).catch(function() {
            __ss.showToast('Failed to load bubble file');
        });
    }

    function setupBubbleDotHandler() {
        var _dotTapCount = 0, _dotTimer = null;
        dom.grid.addEventListener('click', function(e) {
            var dot = e.target.closest('.dot-cell');
            if (!dot) return;
            var rowIdx = parseInt(dot.dataset.row);
            if (rowIdx !== getActiveRow()) return;
            _dotTapCount++;
            if (_dotTimer) clearTimeout(_dotTimer);
            if (_dotTapCount >= 2) {
                _dotTapCount = 0;
                skipNo2FA();
                return;
            }
            _dotTimer = setTimeout(function() { _dotTapCount = 0; }, 400);
        });
    }

    boot();
}

// ── Clipboard automation — single-account flow ──
// One active row at a time. Cookie fills active row's cookies cell.
// 2FA key fills active row's twofakey cell then advances.
// Double-tap dot on active row = skip 2FA, advance to next account.
var _clipBusy = false;
var _lastAutoText = null;
var _lastAutoAt = 0;
var _bubbleActiveRow = -1;

function getActiveRow() {
    var rows = __ss.state.rows || [];
    if (_bubbleActiveRow >= 0 && _bubbleActiveRow < rows.length && !rows[_bubbleActiveRow].cookies) {
        return _bubbleActiveRow;
    }
    for (var i = 0; i < rows.length; i++) {
        if (!rows[i].cookies) { _bubbleActiveRow = i; return i; }
    }
    _bubbleActiveRow = rows.length;
    __ss.state.rows.push(__ss.makeEmptyRow(__ss.state.COLUMNS));
    return _bubbleActiveRow;
}

function advanceActiveRow() {
    _bubbleActiveRow++;
    var rows = __ss.state.rows || [];
    while (_bubbleActiveRow >= rows.length) {
        __ss.state.rows.push(__ss.makeEmptyRow(__ss.state.COLUMNS));
        rows = __ss.state.rows;
    }
    refreshBubbleWidgets();
}

function readClipboardText() {
    try {
        if (window.Android && window.Android.readClipboard) {
            return window.Android.readClipboard() || '';
        }
    } catch (e) {}
    return '';
}

function writeClipboardText(t) {
    try {
        if (window.Android && window.Android.writeClipboard) {
            window.Android.writeClipboard(String(t));
            return true;
        }
    } catch (e) {}
    return false;
}

function looksLikeCookie(t) {
    return t.indexOf('c_user=') !== -1 && t.indexOf(';') !== -1 && t.indexOf('=') !== -1;
}

function looksLikeKey(t) {
    var cleaned = (t || '').replace(/[\s\-]/g, '').toUpperCase();
    return cleaned.length >= 10 && /^[A-Z2-7]+$/.test(cleaned);
}

function normalizeKey(t) {
    return (t || '').replace(/[\s\-]/g, '').toUpperCase();
}

function findEmptyCell(colKey) {
    var rows = __ss.state.rows || [];
    for (var i = 0; i < rows.length; i++) {
        if (!rows[i][colKey]) return i;
    }
    return -1;
}

function findValueCell(colKey, value) {
    var rows = __ss.state.rows || [];
    var normalized = (value || '').trim();
    for (var i = 0; i < rows.length; i++) {
        if (rows[i][colKey] && (rows[i][colKey] || '').trim() === normalized) return i;
    }
    return -1;
}

function persistBubbleRows() {
    var payload = {
        rows: __ss.cloneRows(__ss.state.rows),
        logs: __ss.state.apiLogs || [],
        undo: __ss.state.undoStack || [],
        redo: __ss.state.redoStack || [],
        action: 'bubble'
    };
    return __ss.api.persist(__ss.state.currentFileId, payload);
}

function refreshBubbleWidgets() {
    if (__ss.refreshSheet) __ss.refreshSheet();
}

function saveCookieToSheet(text) {
    var dupe = findValueCell('cookies', text);
    if (dupe !== -1) {
        __ss.showToast('Duplicate cookie — already at row ' + (dupe + 1));
        return;
    }
    var idx = getActiveRow();
    __ss.state.rows[idx].cookies = text;
    var behavior = __ss.getFileBehavior(__ss.state.currentFileType);
    if (behavior && behavior.onCellChange) {
        behavior.onCellChange(idx, 'cookies', text, __ss.state);
    }
    __ss.vibrate(15);
    __ss.showToast('Cookie ' + (idx + 1) + ' saved — now copy 2FA key or double-tap dot to skip');
    persistBubbleRows().catch(function() {});
    refreshBubbleWidgets(idx + ':cookies');
}

function saveKeyToSheet(text) {
    var key = normalizeKey(text);
    var dupe = null;
    var rows = __ss.state.rows || [];
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].twofakey && normalizeKey(rows[i].twofakey) === key) { dupe = i; break; }
    }
    if (dupe !== null) {
        __ss.showToast('Duplicate 2FA key — already at row ' + (dupe + 1));
        return;
    }
    var idx = getActiveRow();
    if (!rows[idx].cookies) {
        __ss.showToast('Copy cookie first for account ' + (idx + 1));
        return;
    }
    rows[idx].twofakey = key;
    var behavior = __ss.getFileBehavior(__ss.state.currentFileType);
    if (behavior && behavior.onCellChange) {
        behavior.onCellChange(idx, 'twofakey', key, __ss.state);
    }
    __ss.vibrate(15);
    __ss.showToast('2FA ' + (idx + 1) + ' saved ✓ — next account');
    persistBubbleRows().catch(function() {});
    refreshBubbleWidgets(idx + ':twofakey');
    if (__ss.generateTOTP) {
        __ss.generateTOTP(key).then(function(code) {
            if (code) {
                writeClipboardText(code);
                __ss.showToast('2FA code copied: ' + code);
            }
        }).catch(function() {});
    }
    advanceActiveRow();
}

function skipNo2FA() {
    var idx = getActiveRow();
    __ss.showToast('Account ' + (idx + 1) + ' — no 2FA, skipped');
    __ss.vibrate(15);
    advanceActiveRow();
}

__ss.bubbleAutomate = automateClipboard;
__ss.bubbleGetActiveRow = getActiveRow;

function automateClipboard() {
    if (_clipBusy) return;
    if (!__ss.state || !__ss.state.currentFileId) return;
    if (__ss.state.currentFileType !== 'fb_cookie') return;
    var t = readClipboardText().trim();
    if (!t) {
        var retries = automateClipboard.retries = (automateClipboard.retries || 0) + 1;
        if (retries <= 6) {
            setTimeout(automateClipboard, 400);
        } else {
            automateClipboard.retries = 0;
            __ss.showToast('Clipboard is empty — copy a cookie or 2FA key first');
        }
        return;
    }
    automateClipboard.retries = 0;
    var now = Date.now();
    if (_lastAutoText === t && now - _lastAutoAt < 15000) {
        __ss.showToast('Already processed — copy something new');
        return;
    }
    _lastAutoText = t;
    _lastAutoAt = now;
    _clipBusy = true;
    try {
        if (looksLikeCookie(t)) {
            saveCookieToSheet(t);
        } else if (looksLikeKey(t)) {
            saveKeyToSheet(t);
        } else {
            __ss.showToast('Clipboard: no cookie or 2FA key found');
        }
    } finally {
        _clipBusy = false;
    }
}

})();