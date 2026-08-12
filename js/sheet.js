(function() {
var __ss = window.__ss;
var dom = __ss.dom;
var api = __ss.api;
var state = __ss.state;

var _topbarLogo = document.querySelector('.topbar-logo');
var _cellMap = new Map();
var _dotMap = new Map();

// ── Open / Close ──
__ss.openFile = async function(id) {
    state.isAdminFile = false;
    state.adminFileOwnerId = null;
    var results = await Promise.all([api.getFile(id), api.getRows(id), api.getLogs(id), api.getUndo(id)]);
    var f = results[0];
    if (!f || !f.id) return;
    state.currentFileId = id;
    state.currentFileType = f.type || 'ig_cookie';
    state.COLUMNS = __ss.getTypeDef(state.currentFileType).columns;
    state.visibleColumns = new Set(state.COLUMNS.map(function(c) { return c.key; }));
    var savedCols = localStorage.getItem('ss_cols_' + id);
    if (savedCols) {
        try { state.visibleColumns = new Set(JSON.parse(savedCols)); } catch(e) {}
    }
    state.rows = results[1] || [];
    while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
    var undoData = results[3] || {};
    state.undoStack = undoData.undo || [];
    state.redoStack = undoData.redo || [];
    state.selectedCell = null;
    state.isDirty = false;
    state.syncRunning = false;
    state.invalidCells = new Set();
    state.apiLogs = results[2] || [];
    state.crossDups = {};
    state.crossDupRows = new Set();
    try { var cd = await api.getCrossDups(id); state.crossDups = cd.dups || {}; } catch(e) {}
    var behavior = __ss.getFileBehavior(state.currentFileType);
    if (dom.syncBtnGroup) dom.syncBtnGroup.style.display = (behavior && behavior.syncRow) ? 'inline-flex' : 'none';
    if (dom.checkBtnGroup) dom.checkBtnGroup.style.display = (behavior && behavior.checkAccounts) ? 'inline-flex' : 'none';
    populateColumnToggles();

    dom.homeView.style.display = 'none';
    dom.sheetView.classList.add('active');
    dom.homeFab.classList.add('hidden');
    dom.sheetBtns.style.display = 'flex';
    dom.backBtn.classList.add('visible');
    var displayName = f.name.length > 10 ? f.name.substring(0, 10) + '...' : f.name;
    dom.sheetTitleBtn.textContent = displayName;
    dom.sheetTitleBtn._fullName = f.name;
    dom.sheetTitleBtn.classList.add('visible');
    dom.homeTopTitle.style.display = 'none';
    dom.connStatus.style.display = 'none';

    if (dom.gearBtn) dom.gearBtn.style.display = 'none';
    if (_topbarLogo) _topbarLogo.style.display = 'none';

    updateSyncState();
    try { history.pushState({fileId: id}, '', 'file/' + id); } catch(e) {}
    updateUndoRedo();
    renderSheet();
    findDuplicates();
    renderSheet();
    setupGridDelegation();
};

__ss.openFileAdmin = async function(id) {
    var results = await Promise.all([api.adminFile(id), api.adminFileRows(id), api.adminFileLogs(id), api.adminUndo(id)]);
    var f = results[0];
    if (!f || !f.id) return;
    state.currentFileId = id;
    state.currentFileType = f.type || 'ig_cookie';
    state.COLUMNS = __ss.getTypeDef(state.currentFileType).columns;
    state.visibleColumns = new Set(state.COLUMNS.map(function(c) { return c.key; }));
    var savedCols = localStorage.getItem('ss_cols_' + id);
    if (savedCols) {
        try { state.visibleColumns = new Set(JSON.parse(savedCols)); } catch(e) {}
    }
    state.rows = results[1] || [];
    while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
    var undoData = results[3] || {};
    state.undoStack = undoData.undo || [];
    state.redoStack = undoData.redo || [];
    state.selectedCell = null;
    state.isDirty = false;
    state.syncRunning = false;
    state.invalidCells = new Set();
    state.apiLogs = results[2] || [];
    state.crossDups = {};
    state.crossDupRows = new Set();

    var behavior = __ss.getFileBehavior(state.currentFileType);
    if (dom.syncBtnGroup) dom.syncBtnGroup.style.display = (behavior && behavior.syncRow) ? 'inline-flex' : 'none';
    if (dom.checkBtnGroup) dom.checkBtnGroup.style.display = (behavior && behavior.checkAccounts) ? 'inline-flex' : 'none';
    populateColumnToggles();

    dom.homeView.style.display = 'none';
    dom.sheetView.classList.add('active');
    dom.homeFab.classList.add('hidden');
    dom.sheetBtns.style.display = 'flex';
    dom.backBtn.classList.add('visible');
    var displayName = f.name.length > 10 ? f.name.substring(0, 10) + '...' : f.name;
    dom.sheetTitleBtn.textContent = displayName;
    dom.sheetTitleBtn._fullName = f.name;
    dom.sheetTitleBtn.classList.add('visible');
    dom.homeTopTitle.style.display = 'none';
    dom.connStatus.style.display = 'none';

    if (dom.gearBtn) dom.gearBtn.style.display = 'none';
    if (_topbarLogo) _topbarLogo.style.display = 'none';

    updateSyncState();
    try { history.pushState({fileId: id}, '', 'file/' + id); } catch(e) {}
    updateUndoRedo();
    renderSheet();
    findDuplicates();
    renderSheet();
    setupGridDelegation();
};

__ss.closeSheet = async function() {
    if (state.selectionMode) exitSelectionMode();
    if (state.isDirty) await _persistImmediate();
    var adminOwnerId = state.adminFileOwnerId;
    var wasAdmin = state.isAdminFile;
    state.currentFileId = null;
    state.currentFileType = null;
    state.COLUMNS = [];
    state.rows = [];
    state.undoStack = [];
    state.redoStack = [];
    state.selectedCell = null;
    state.isAdminFile = false;
    state.adminFileOwnerId = null;
    if (dom.syncBtnGroup) dom.syncBtnGroup.style.display = 'none';
    if (dom.checkBtnGroup) dom.checkBtnGroup.style.display = 'none';
    if (dom.checkDropdown) dom.checkDropdown.classList.remove('open');
    state.visibleColumns = null;
    __ss.clearCellHighlight();
    dom.qebBar.classList.remove('open');

    dom.homeView.style.display = 'flex';
    dom.sheetView.classList.remove('active');
    dom.homeFab.classList.remove('hidden');
    dom.sheetBtns.style.display = 'none';
    dom.backBtn.classList.remove('visible');
    dom.sheetTitleBtn.classList.remove('visible');
    dom.homeTopTitle.style.display = 'inline';
    dom.connStatus.style.display = '';

    if (dom.gearBtn) dom.gearBtn.style.display = '';
    if (_topbarLogo) _topbarLogo.style.display = '';

    try {
        if (window.location.pathname !== '/') {
            history.pushState(null, '', '/');
        }
    } catch(e) {}

    if (wasAdmin && adminOwnerId) {
        var adminTab = document.querySelector('[data-htab="admin"]');
        if (adminTab && !adminTab.classList.contains('active')) adminTab.click();
        setTimeout(function() { __ss.showAdminUserDetail(adminOwnerId); }, 50);
    } else {
        __ss.renderHome();
    }
};

dom.backBtn.addEventListener('click', __ss.closeSheet);

// ── Persist (trim trailing empties, keep 50-row buffer) ──
function apiUpdateCell(fileId, data) {
    if (state.isAdminFile) return api.adminUpdateCell(fileId, data);
    return api.updateCell(fileId, data);
}
function apiAppendLog(fileId, data) {
    if (state.isAdminFile) return api.adminAppendLog(fileId, data);
    return api.appendLog(fileId, data);
}

var _persistTimer = null;

async function _persistImmediate(action) {
    if (!state.currentFileId) return;
    var td = __ss.getTypeDef(state.currentFileType);
    var lastData = -1;
    var dataCount = 0;
    state.rows.forEach(function(row, idx) {
        var hasData = td.columns.some(function(c) { return row[c.key]; });
        if (hasData) { dataCount++; lastData = idx; }
    });
    var keepCount = Math.min(state.rows.length, Math.max(lastData + 51, 100));
    var trimmed = state.rows.slice(0, keepCount);
    var payload = {
        rows: trimmed,
        logs: state.apiLogs,
        undo: state.undoStack,
        redo: state.redoStack,
        dataCount: dataCount
    };
    if (action) payload.action = action;
    if (state.isAdminFile) {
        payload.userId = state.adminFileOwnerId;
        await api.adminPersist(state.currentFileId, payload);
    } else {
        await api.persist(state.currentFileId, payload);
    }
    state.isDirty = false;
}

function persist(action) {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(function() {
        _persistTimer = null;
        _persistImmediate(action);
    }, 300);
}

window.addEventListener('beforeunload', function() {
    if (state.currentFileId && state.isDirty) {
        clearTimeout(_persistTimer);
        _persistTimer = null;
        _persistImmediate();
    }
});

// ── Sync split button states ──
function updateSyncState() {
    if (!dom.syncBtnGroup) return;
    dom.syncBtnGroup.dataset.sync = state.syncRunning ? 'syncing' : '';
}

async function runSync() {
    var behavior = __ss.getFileBehavior(state.currentFileType);
    if (!behavior || !behavior.syncRow) { __ss.showToast('No sync handler for this file type'); return; }
    state.syncRunning = true;
    updateSyncState();
    var total = 0;
    state.rows.forEach(function(row) {
        if (row.username && row.twofa) total++;
    });
    if (!total) { __ss.showToast('No rows to sync'); state.syncRunning = false; updateSyncState(); return; }
    var done = 0;
    for (var i = 0; i < state.rows.length; i++) {
        var row = state.rows[i];
        if (!row.username || !row.twofa) continue;
        row.status = 'pending';
        updateDotStatus(i, 'pending');
        try {
            var result = await behavior.syncRow(row, state);
            state.apiLogs.push(result);
            row.status = result.status === 'done' ? 'good' : 'bad';
            updateDotStatus(i, row.status);
        } catch(e) {
            var errLog = { username: row.username, steps: [{ type: 'error', message: e.message, time: Date.now() }], status: 'failed' };
            state.apiLogs.push(errLog);
            row.status = 'bad';
            updateDotStatus(i, 'bad');
        }
        done++;
        __ss.showToast('Synced ' + done + '/' + total);
    }
    state.syncRunning = false;
    updateSyncState();
    persist('sync');
    __ss.showToast('Sync complete — ' + done + '/' + total);
}

if (dom.syncBtn) {
    dom.syncBtn.addEventListener('click', function() {
        if (state.syncRunning) return;
        runSync();
    });
}

// ── Check split button ──
async function runCheck() {
    if (state.checkRunning) return;
    if (state.hasDuplicates) { __ss.showToast('Resolve duplicate values first'); return; }
    if (state.invalidCells && state.invalidCells.size > 0) { __ss.showToast('Fix invalid cell values first'); return; }
    var behavior = __ss.getFileBehavior(state.currentFileType);
    if (!behavior || !behavior.checkAccounts) return;
    var preCheckRows = state.rows.map(function(r) { return Object.assign({}, r); });
    // Clear status for empty rows before check
    state.rows.forEach(function(row) {
        var isEmpty = state.COLUMNS.every(function(c) { return !row[c.key]; });
        if (isEmpty) row.status = '';
    });
    state.checkRunning = true;
    if (dom.checkBtnGroup) dom.checkBtnGroup.dataset.check = 'checking';
    dom.checkBtn.innerHTML = 'Checking...';
    try {
        var result = await behavior.checkAccounts(state.rows, state);
        state.isDirty = true;
        updateSyncState();
        state.rows.forEach(function(row, i) { updateDotStatus(i, row.status || ''); });
        // Silent WA onboarding check for fb_cookie alive rows
        if (state.currentFileType === 'fb_cookie' && waCheckOn) {
            console.log('[WA] triggering wa check');
            runWaChecks();
        }
        persist('check');
        state.undoStack.push({ type: 'rows', prevRows: preCheckRows });
        if (state.undoStack.length > 100) state.undoStack.shift();
        state.redoStack = [];
        updateUndoRedo();
        findDuplicates();
        updateDuplicateState();
        __ss.showToast('Check done — ' + result.valid + ' valid, ' + result.dead + ' dead, ' + result.uncertain + ' uncertain');
    } catch(e) {
        __ss.showToast('Check failed: ' + e.message);
    }
    state.checkRunning = false;
    if (dom.checkBtnGroup) dom.checkBtnGroup.dataset.check = '';
    dom.checkBtn.innerHTML = 'Check';
}

async function runWaChecks() {
    console.log('[WA] runWaChecks entered, fileType:', state.currentFileType);
    var waRows = [];
    state.rows.forEach(function(row, idx) {
        var match = row.status === 'good' && row.wa_status !== 'eligible' && row.cookies && row.cookies.match(/c_user=\d+/);
        if (match) {
            waRows.push({ idx: idx, row: row });
        }
    });
    console.log('[WA] matched rows:', waRows.length);
    if (!waRows.length) return;
    var cache = {};
    try {
        var uidArr = [];
        waRows.forEach(function(w) {
            var uid = w.row.uid;
            if (!uid && w.row.cookies) {
                var m = w.row.cookies.match(/c_user=(\d+)/);
                if (m) uid = m[1];
            }
            if (uid) uidArr.push(uid);
        });
        if (uidArr.length && typeof api.getWaCache === 'function') {
            var res = await api.getWaCache(uidArr);
            cache = (res && res.cache) || {};
        }
    } catch(e) { cache = {}; }
    var cachedApply = false;
    waRows = waRows.filter(function(w) {
        var uid = w.row.uid;
        if (!uid && w.row.cookies) {
            var m = w.row.cookies.match(/c_user=(\d+)/);
            if (m) uid = m[1];
        }
        var hit = uid ? cache[uid] : null;
        if (!hit || !hit.status) return true;
        if (hit.status === 'eligible') {
            w.row.wa_status = 'eligible';
            w.row.wa_ban_reason = hit.banReason || null;
            cachedApply = true;
            updateDotStatus(w.idx, w.row.status || '');
            return false;
        }
        if (hit.status === 'ineligible') {
            w.row.wa_status = 'ineligible';
            w.row.wa_ban_reason = hit.banReason || null;
            cachedApply = true;
            updateDotStatus(w.idx, w.row.status || '');
            return false;
        }
        return true;
    });
    if (!waRows.length) {
        if (cachedApply) { state.isDirty = true; persist(); }
        return;
    }
    var concurrency = 3, pos = 0;
    function nextBatch() {
        if (pos >= waRows.length) return Promise.resolve();
        var batch = [];
        for (var limit = concurrency; limit > 0 && pos < waRows.length; limit--) batch.push(pos++);
        return Promise.all(batch.map(function(i) {
            var w = waRows[i];
            console.log('[WA] firing check for idx', w.idx);
            return api.waCheck(w.row.cookies).then(function(wa) {
                if (wa && wa.eligible === true) {
                    w.row.wa_status = 'eligible';
                } else {
                    w.row.wa_status = (wa && wa.error) ? 'error' : 'ineligible';
                    w.row.wa_ban_reason = wa ? wa.banReason : null;
                }
                updateDotStatus(w.idx, w.row.status || '');
            }).catch(function() {
                w.row.wa_status = 'error';
                updateDotStatus(w.idx, w.row.status || '');
            });
        })).then(nextBatch);
    }
    try {
        await nextBatch();
        state.isDirty = true;
        persist();
    } catch(e) {}
    if (cachedApply) persist();
}

__ss.hydrateWaCache = async function(rows) {
    try {
        if (!rows || !rows.length) return;
        if (typeof api.getWaCache !== 'function') return;
        var uidArr = [];
        rows.forEach(function(row) {
            var uid = row.uid;
            if (!uid && row.cookies) {
                var m = row.cookies.match(/c_user=(\d+)/);
                if (m) uid = m[1];
            }
            if (uid) uidArr.push(uid);
        });
        if (!uidArr.length) return;
        var res = await api.getWaCache(uidArr);
        var cache = (res && res.cache) || {};
        rows.forEach(function(row) {
            var uid = row.uid;
            if (!uid && row.cookies) {
                var m = row.cookies.match(/c_user=(\d+)/);
                if (m) uid = m[1];
            }
            var hit = uid ? cache[uid] : null;
            if (!hit || !hit.status) return;
            if (hit.status === 'eligible') {
                row.wa_status = 'eligible';
                row.wa_ban_reason = hit.banReason || null;
            } else if (hit.status === 'ineligible') {
                row.wa_status = 'ineligible';
                row.wa_ban_reason = hit.banReason || null;
            }
        });
    } catch(e) {}
};

if (dom.checkBtn) {
    dom.checkBtn.addEventListener('click', runCheck);
}

// ── Check dropdown arrow ──
if (dom.checkArrowBtn && dom.checkDropdown) {
    dom.checkArrowBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var isOpen = dom.checkDropdown.classList.contains('open');
        dom.checkDropdown.classList.remove('open');
        dom.checkArrowBtn.classList.remove('open');
        if (!isOpen) {
            var rect = dom.checkArrowBtn.getBoundingClientRect();
            dom.checkDropdown.style.top = (rect.bottom + 6) + 'px';
            dom.checkDropdown.style.right = (window.innerWidth - rect.right) + 'px';
            dom.checkDropdown.classList.add('open');
            dom.checkArrowBtn.classList.add('open');
            if (dom.waCheckSection) {
                var waIsAdmin = !!(__ss.currentUser && __ss.currentUser.isAdmin);
                dom.waCheckSection.style.display = waIsAdmin ? '' : 'none';
            }
        }
    });
}

document.addEventListener('click', function() {
    if (dom.checkDropdown && dom.checkArrowBtn) {
        dom.checkDropdown.classList.remove('open');
        dom.checkArrowBtn.classList.remove('open');
    }
});
if (dom.checkDropdown) {
    dom.checkDropdown.addEventListener('click', function(e) { e.stopPropagation(); });
}

// ── Auto-check toggle ──
var autoCheckOn = localStorage.getItem('ss_autoCheck') === 'true';
if (dom.autoCheckToggle) {
    if (autoCheckOn) dom.autoCheckToggle.classList.add('on');
    dom.autoCheckToggle.addEventListener('click', function() {
        autoCheckOn = !autoCheckOn;
        dom.autoCheckToggle.classList.toggle('on', autoCheckOn);
        localStorage.setItem('ss_autoCheck', autoCheckOn ? 'true' : '');
        __ss.showToast('Auto-check ' + (autoCheckOn ? 'ON' : 'OFF'));
    });
}

// ── Page check toggle (admin only) ──
var waCheckOn = localStorage.getItem('ss_waCheck') === 'true';
if (dom.waCheckSection) {
    dom.waCheckSection.style.display = 'none';
}
if (dom.waCheckToggle) {
    if (waCheckOn) dom.waCheckToggle.classList.add('on');
    dom.waCheckToggle.addEventListener('click', function() {
        waCheckOn = !waCheckOn;
        dom.waCheckToggle.classList.toggle('on', waCheckOn);
        localStorage.setItem('ss_waCheck', waCheckOn ? 'true' : '');
        __ss.showToast('Page Check ' + (waCheckOn ? 'ON' : 'OFF'));
    });
}

// ── Auto-trigger check on cookies cell change ──
function maybeAutoCheck(rowIdx, colKey) {
    if (!autoCheckOn) return;
    if (state.currentFileType !== 'fb_cookie') return;
    if (colKey !== 'cookies') return;
    if (state.checkRunning) return;
    var behavior = __ss.getFileBehavior(state.currentFileType);
    if (!behavior || !behavior.checkAccounts) return;
    runCheck();
}

// ── Populate column toggles in sheet more menu ──
function populateColumnToggles() {
    if (!dom.sheetMoreCols) return;
    state.visibleColumns = state.visibleColumns || new Set(state.COLUMNS.map(function(c) { return c.key; }));
    dom.sheetMoreCols.innerHTML = '';
    state.COLUMNS.forEach(function(col) {
        var item = document.createElement('div');
        item.className = 'sheet-more-col-item';
        var visible = state.visibleColumns.has(col.key);
        item.innerHTML = '<span class="col-toggle' + (visible ? ' on' : '') + '"></span>' + __ss.esc(col.label);
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            if (state.visibleColumns.has(col.key)) {
                state.visibleColumns.delete(col.key);
            } else {
                state.visibleColumns.add(col.key);
            }
            var tog = item.querySelector('.col-toggle');
            tog.classList.toggle('on', state.visibleColumns.has(col.key));
            dom.sheetMoreMenu.classList.remove('open');
            if (state.currentFileId) {
                localStorage.setItem('ss_cols_' + state.currentFileId, JSON.stringify([...state.visibleColumns]));
            }
            renderSheet();
        });
        dom.sheetMoreCols.appendChild(item);
    });
}

// ── Sync dropdown arrow ──
if (dom.syncArrowBtn && dom.syncDropdown) {
    dom.syncArrowBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var isOpen = dom.syncDropdown.classList.contains('open');
        dom.syncDropdown.classList.remove('open');
        dom.syncArrowBtn.classList.remove('open');
        if (!isOpen) {
            var rect = dom.syncArrowBtn.getBoundingClientRect();
            dom.syncDropdown.style.top = (rect.bottom + 6) + 'px';
            dom.syncDropdown.style.right = (window.innerWidth - rect.right) + 'px';
            dom.syncDropdown.classList.add('open');
            dom.syncArrowBtn.classList.add('open');
        }
    });
}

document.addEventListener('click', function() {
    if (dom.syncDropdown && dom.syncArrowBtn) {
        dom.syncDropdown.classList.remove('open');
        dom.syncArrowBtn.classList.remove('open');
    }
});
if (dom.syncDropdown) {
    dom.syncDropdown.addEventListener('click', function(e) { e.stopPropagation(); });
}

// ── Auto-sync toggle ──
if (dom.autoSyncToggle) {
    var autoSyncOn = localStorage.getItem('ss_autoSync') === 'true';
    if (autoSyncOn) dom.autoSyncToggle.classList.add('on');
    dom.autoSyncToggle.addEventListener('click', function() {
        autoSyncOn = !autoSyncOn;
        dom.autoSyncToggle.classList.toggle('on', autoSyncOn);
        localStorage.setItem('ss_autoSync', autoSyncOn ? 'true' : '');
        __ss.showToast('Auto-sync ' + (autoSyncOn ? 'ON' : 'OFF'));
    });
}

// ── API log popup (positioned from dot) ──
function showApiLogs(logs, username, el, crossInfo) {
    var crossHtml = '';
    if (crossInfo && crossInfo.length) {
        crossHtml = '<div style="padding:6px 0;border-bottom:1px solid var(--border2);margin-bottom:4px">' +
            '<div style="font-size:11px;font-weight:600;color:var(--yellow);margin-bottom:4px">&#9888; Cross-file duplicate</div>';
        crossInfo.forEach(function(c) {
            crossHtml += '<div style="font-size:11px;color:var(--text2);padding:2px 0">' + __ss.esc(c.fileName) + ' (row ' + (Number(c.rowIdx) + 1) + ')</div>';
        });
        crossHtml += '</div>';
    }
    var waHtml = '';
    if (el && el.parentElement) {
        var rowIdx = Number(el.dataset.row);
        var row = state.rows[rowIdx];
        if (row && row.wa_status) {
            if (row.wa_status === 'eligible') {
                waHtml = '<div style="padding:6px 0;border-bottom:1px solid var(--border2);margin-bottom:4px">' +
                    '<div style="font-size:11px;font-weight:600;color:var(--green)">&#10003; FB Page</div></div>';
            } else if (row.wa_ban_reason) {
                waHtml = '<div style="padding:6px 0;border-bottom:1px solid var(--border2);margin-bottom:4px">' +
                    '<div style="font-size:11px;color:var(--text3)">&#9888; ' + __ss.esc(row.wa_ban_reason) + '</div></div>';
            }
        }
    }
    dom.logPopupTitle.textContent = username + ' — ' + logs.length + ' API call' + (logs.length > 1 ? 's' : '');
    var h = '';
    logs.forEach(function(log, idx) {
        var statusIcon = log.status === 'done' ? '&#10003;' : '&#10007;';
        var statusColor = log.status === 'done' ? 'var(--green)' : 'var(--red)';
        h += '<div style="padding:6px 0;border-top:' + (idx ? '1px solid var(--border)' : 'none') + ';font-size:12px">';
        (log.calls || []).forEach(function(call) {
            if (call.type === 'error') {
                h += '<div style="color:var(--red);padding:2px 0;font-size:12px">&#9888; ' + __ss.esc(call.response) + '</div>';
            } else {
                h += '<div style="margin-bottom:4px"><span style="color:' + statusColor + ';font-weight:600">' + statusIcon + ' ' + call.type.toUpperCase() + '</span></div>';
                h += '<div style="color:var(--text3);font-size:11px;margin-bottom:1px">' + __ss.esc(call.request) + '</div>';
                var pretty;
                try { pretty = JSON.stringify(JSON.parse(call.response), null, 2); } catch(e) { pretty = call.response; }
                h += '<pre style="margin:2px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--text);font-family:var(--mono);background:var(--bg3);padding:4px 6px;border-radius:4px;line-height:1.4">' + __ss.esc(pretty) + '</pre>';
            }
        });
        h += '</div>';
    });
    dom.logPopupBody.innerHTML = crossHtml + waHtml + (h || '<div style="padding:6px 0;color:var(--text3);font-size:12px">No logs for this row</div>');

    var rect = el.getBoundingClientRect();
    dom.logPopup.style.left = Math.max(4, rect.right - 340) + 'px';
    dom.logPopup.style.top = (rect.bottom + 4) + 'px';
    dom.logPopup.classList.add('open');
}

document.addEventListener('click', function(e) {
    if (dom.logPopup && !dom.logPopup.contains(e.target)) dom.logPopup.classList.remove('open');
});

// ── Undo / Redo ──
function pushUndo(rowIdx, colKey, prevVal) {
    state.undoStack.push({ rowIdx: rowIdx, colKey: colKey, prevVal: prevVal });
    if (state.undoStack.length > 100) state.undoStack.shift();
    state.redoStack = [];
    updateUndoRedo();
}

function updateUndoRedo() {
    dom.undoBtn.disabled = state.undoStack.length === 0;
    dom.redoBtn.disabled = state.redoStack.length === 0;
}

dom.undoBtn.addEventListener('click', function() {
    if (!state.undoStack.length) return;
    var delta = state.undoStack.pop();
    if (delta.type === 'rows') {
        state.redoStack.push({ type: 'rows', prevRows: state.rows.map(function(r) { return Object.assign({}, r); }) });
        state.rows = delta.prevRows.map(function(r) { return Object.assign({}, r); });
        state.isDirty = true;
        renderSheet();
        findDuplicates();
        updateDuplicateState();
        updateValidationState();
        updateUndoRedo();
        persist();
        __ss.showToast('Undo');
        return;
    }
    var row = state.rows[delta.rowIdx];
    var currentVal = row ? (row[delta.colKey] || '') : '';
    state.redoStack.push({ rowIdx: delta.rowIdx, colKey: delta.colKey, prevVal: currentVal });
    if (row) {
        row[delta.colKey] = delta.prevVal;
        updateCellInPlace(delta.rowIdx, delta.colKey, delta.prevVal);
    }
    state.isDirty = true;
    findDuplicates();
    updateDuplicateState();
    updateValidationState();
    updateUndoRedo();
    persist();
    __ss.showToast('Undo');
});

dom.redoBtn.addEventListener('click', function() {
    if (!state.redoStack.length) return;
    var delta = state.redoStack.pop();
    if (delta.type === 'rows') {
        state.undoStack.push({ type: 'rows', prevRows: state.rows.map(function(r) { return Object.assign({}, r); }) });
        state.rows = delta.prevRows.map(function(r) { return Object.assign({}, r); });
        state.isDirty = true;
        renderSheet();
        findDuplicates();
        updateDuplicateState();
        updateValidationState();
        updateUndoRedo();
        persist();
        __ss.showToast('Redo');
        return;
    }
    var row = state.rows[delta.rowIdx];
    var currentVal = row ? (row[delta.colKey] || '') : '';
    state.undoStack.push({ rowIdx: delta.rowIdx, colKey: delta.colKey, prevVal: currentVal });
    if (row) {
        row[delta.colKey] = delta.prevVal;
        updateCellInPlace(delta.rowIdx, delta.colKey, delta.prevVal);
    }
    state.isDirty = true;
    findDuplicates();
    updateDuplicateState();
    updateValidationState();
    updateUndoRedo();
    persist();
    __ss.showToast('Redo');
});

// ── Targeted DOM helpers (Fix 3) ──
function updateCellInPlace(rowIdx, colKey, value) {
    var td = _cellMap.get(rowIdx + ':' + colKey);
    if (!td) return;
    var text = td.querySelector('.cell-text');
    if (text) text.textContent = value || '';
}

function findDuplicates() {
    var colsToCheck = state.COLUMNS.map(function(c) { return c.key; });
    state.dupCells = new Set();
    state.dupRows = new Set();
    colsToCheck.forEach(function(colKey) {
        var valMap = {};
        state.rows.forEach(function(row, rowIdx) {
            var val = (row[colKey] || '').trim();
            if (!val) return;
            if (!valMap[val]) valMap[val] = [];
            valMap[val].push(rowIdx);
        });
        Object.keys(valMap).forEach(function(val) {
            if (valMap[val].length > 1) {
                valMap[val].forEach(function(rowIdx) {
                    state.dupCells.add(rowIdx + ':' + colKey);
                    state.dupRows.add(rowIdx);
                });
            }
        });
    });
    state.hasDuplicates = state.dupCells.size > 0;
    computeCrossDups();
    if (dom.checkBtn) {
        dom.checkBtn.classList.toggle('warning', state.hasDuplicates);
    }
}

function computeCrossDups() {
    state.crossDupRows = new Set();
    if (!state.crossDups) return;
    state.rows.forEach(function(row, rowIdx) {
        var uid = row.uid || row.username;
        if (!uid && row.cookies) {
            var m = row.cookies.match(/c_user=(\d+)/);
            if (m) uid = m[1];
        }
        if (uid && state.crossDups[uid]) {
            state.crossDupRows.add(rowIdx);
        }
    });
}

function updateDuplicateState() {
    document.querySelectorAll('.cell-dup').forEach(function(el) {
        el.classList.remove('cell-dup');
    });
    state.dupCells.forEach(function(key) {
        var td = _cellMap.get(key);
        if (td) td.classList.add('cell-dup');
    });
    state.rows.forEach(function(row, rowIdx) {
        updateDotStatus(rowIdx, row.status || '');
    });
    if (dom.checkBtn) {
        dom.checkBtn.classList.toggle('warning', state.hasDuplicates);
    }
}

function updateValidationState() {
    document.querySelectorAll('.cell-invalid').forEach(function(el) {
        el.classList.remove('cell-invalid');
    });
    state.invalidCells.forEach(function(key) {
        var td = _cellMap.get(key);
        if (td) td.classList.add('cell-invalid');
    });
}

function updateDotStatus(rowIdx, status) {
    var dot = _dotMap.get(String(rowIdx));
    if (!dot) return;
    var rowDot = dot.querySelector('.row-dot');
    if (rowDot) {
        rowDot.className = 'row-dot';
        if (state.dupRows.has(Number(rowIdx)) || state.crossDupRows.has(Number(rowIdx))) {
            rowDot.classList.add('d-yellow');
        } else if (state.rows[rowIdx] && state.rows[rowIdx].wa_status === 'eligible') rowDot.classList.add('d-green');
        else if (status === 'good' || status === 'done') rowDot.classList.add('d-blue');
        else if (status === 'bad') rowDot.classList.add('d-red');
        else if (status === 'pending') { rowDot.classList.add('d-spin'); rowDot.classList.add('d-yellow'); }
    }
}

function updateSelectionDOM() {
    if (!dom.grid) return;
    dom.grid.querySelectorAll('.ms-sel, .col-sel, .row-sel, .row-selected').forEach(function(el) {
        el.classList.remove('ms-sel', 'col-sel', 'row-sel', 'row-selected');
    });
    if (!state.selectionMode) return;
    state.selectedItems.forEach(function(key) {
        var td = _cellMap.get(key);
        if (td) td.classList.add('ms-sel');
    });
}

// ── Event delegation (Fix 1) ──
function setupGridDelegation() {
    if (dom.grid._delegated) return;
    dom.grid._delegated = true;
    var timer = null, heldEl = null, holdActive = false;
    var _clickCount = 0, _clickTarget = null, _clickTimer = null;

    dom.grid.addEventListener('click', function(e) {
        if (holdActive) { holdActive = false; return; }
        var td = e.target.closest('td.dc');
        var dot = e.target.closest('.dot-cell');
        var rh = e.target.closest('th.rh');
        var ch = e.target.closest('th.ch:not(.corner):not(.ch-dot)');
        var corner = e.target.closest('th.corner');

        if (corner && state.currentFileId) { selectAllCells(); return; }

        var target = rh || ch || dot || td;
        if (!target) return;
        if (target !== _clickTarget) { _clickCount = 0; _clickTarget = target; }
        _clickCount++;
        if (_clickTimer) clearTimeout(_clickTimer);
        if (_clickCount === 3) {
            _clickCount = 0;
            _clickTarget = null;
            if (rh && state.currentFileId) { tripleTapRow(parseInt(rh.dataset.row)); return; }
            if (ch && state.currentFileId) { tripleTapCol(ch.dataset.col); return; }
            return;
        }
        _clickTimer = setTimeout(function() { _clickCount = 0; _clickTarget = null; }, 400);

        if (rh && state.currentFileId) { toggleSelection('row', parseInt(rh.dataset.row)); return; }
        if (dot && state.currentFileId) {
            var behavior = __ss.getFileBehavior(state.currentFileType);
            if (behavior && behavior.onDotDoubleTap) {
                var row = state.rows[parseInt(dot.dataset.row)];
                behavior.onDotDoubleTap(row).then(function(result) {
                    if (result && result.action === 'totp_copied') {
                        __ss.showToast('TOTP ' + result.code + ' copied');
                    }
                });
            }
            return;
        }
        if (ch && state.currentFileId) { toggleSelection('col', null, ch.dataset.col); return; }
        if (td && state.currentFileId) {
            if (state.selectionMode) { toggleSelection('cell', parseInt(td.dataset.row), td.dataset.col); }
            else { openQuickEdit(parseInt(td.dataset.row), td.dataset.col); }
        }
    });

    dom.grid.addEventListener('dblclick', function(e) {
        var td = e.target.closest('td.dc');
        if (td && state.currentFileId && !state.selectionMode) {
            doubleTapAction(parseInt(td.dataset.row), td.dataset.col);
        }
    });

    dom.grid.addEventListener('pointerdown', function(e) {
        var td = e.target.closest('td.dc');
        if (td && !state.selectionMode) {
            heldEl = td;
            timer = setTimeout(function() {
                holdActive = true;
                timer = null;
                __ss.vibrate(15);
                enterSelectionMode('cell', td.dataset.row, td.dataset.col);
            }, 500);
        }
        var dot = e.target.closest('.dot-cell');
        if (dot) {
            heldEl = dot;
            timer = setTimeout(function() {
                holdActive = true;
                timer = null;
                __ss.vibrate(15);
                var behavior = __ss.getFileBehavior(state.currentFileType);
                var row = state.rows[parseInt(dot.dataset.row)];
                var crossInfo = null;
                var uid = row.uid || row.username;
                if (!uid && row.cookies) { var mx = row.cookies.match(/c_user=(\d+)/); if (mx) uid = mx[1]; }
                if (uid && state.crossDups && state.crossDups[uid]) {
                    crossInfo = state.crossDups[uid].filter(function(e) { return e.fileId !== state.currentFileId; });
                }
                if (behavior && behavior.onDotHold) {
                    var result = behavior.onDotHold(row, state.apiLogs);
                    if (result && result.action === 'show_logs') {
                        showApiLogs(result.logs, result.label || row.username, dot, crossInfo);
                    }
                }
            }, 500);
        }
        var ch = e.target.closest('th.ch:not(.corner):not(.ch-dot)');
        if (ch && !state.selectionMode) {
            heldEl = ch;
            timer = setTimeout(function() {
                holdActive = true;
                timer = null;
                __ss.vibrate(15);
                enterSelectionMode('col', null, ch.dataset.col);
            }, 500);
        }
        var rh = e.target.closest('th.rh');
        if (rh && !state.selectionMode) {
            heldEl = rh;
            timer = setTimeout(function() {
                holdActive = true;
                timer = null;
                __ss.vibrate(15);
                enterSelectionMode('row', rh.dataset.row, null);
            }, 500);
        }
    });

    dom.grid.addEventListener('pointerup', function() {
        if (timer) { clearTimeout(timer); timer = null; }
        heldEl = null;
        holdActive = false;
    });

    dom.grid.addEventListener('pointerleave', function() {
        if (timer) { clearTimeout(timer); timer = null; }
        heldEl = null;
        holdActive = false;
    });
}

// ── Triple-tap helpers ──
function tripleTapRow(rowIdx) {
    var row = state.rows[rowIdx];
    if (!row) return;
    var vals = state.COLUMNS.map(function(c) { return { key: c.key, val: row[c.key] || '' }; });
    var hasData = vals.some(function(v) { return v.val; });
    if (hasData) {
        var text = vals.map(function(v) { return v.val; }).join('\t');
        navigator.clipboard.writeText(text).then(function() {
            __ss.vibrate();
            __ss.showToast('Row copied');
        }).catch(function() { __ss.showToast('Cannot copy'); });
    } else {
        navigator.clipboard.readText().then(function(text) {
            if (!text) return;
            var parts = text.split('\t');
            vals.forEach(function(v, i) {
                if (parts[i] !== undefined) row[v.key] = parts[i];
            });
            state.isDirty = true;
            var behavior = __ss.getFileBehavior(state.currentFileType);
            vals.forEach(function(v, i) {
                if (parts[i] !== undefined && behavior && behavior.onCellChange) {
                    behavior.onCellChange(rowIdx, v.key, parts[i], state);
                }
            });
            renderSheet();
            findDuplicates();
            updateDuplicateState();
            updateValidationState();
            persist();
            __ss.showToast('Row pasted');
        }).catch(function() {});
    }
}

function tripleTapCol(colKey) {
    var vals = [];
    state.rows.forEach(function(row, i) {
        var v = row[colKey] || '';
        if (v) vals.push({ idx: i, val: v });
    });
    if (vals.length) {
        var text = vals.map(function(v) { return v.val; }).join('\n');
        navigator.clipboard.writeText(text).then(function() {
            __ss.vibrate();
            __ss.showToast('Copied ' + vals.length + ' cells');
        }).catch(function() { __ss.showToast('Cannot copy'); });
    } else {
        navigator.clipboard.readText().then(function(text) {
            if (!text) return;
            var parts = text.split('\n').filter(function(s) { return s; });
            var behavior = __ss.getFileBehavior(state.currentFileType);
            parts.forEach(function(val, i) {
                if (state.rows[i]) {
                    state.rows[i][colKey] = val;
                    if (behavior && behavior.onCellChange) {
                        behavior.onCellChange(i, colKey, val, state);
                    }
                }
            });
            state.isDirty = true;
            renderSheet();
            findDuplicates();
            updateDuplicateState();
            updateValidationState();
            persist();
            __ss.showToast('Pasted ' + parts.length + ' cells');
        }).catch(function() {});
    }
}

// ── Render ──
function populateCellMaps() {
    _cellMap.clear();
    _dotMap.clear();
    dom.grid.querySelectorAll('td.dc').forEach(function(td) {
        _cellMap.set(td.dataset.row + ':' + td.dataset.col, td);
    });
    dom.grid.querySelectorAll('.dot-cell').forEach(function(td) {
        _dotMap.set(td.dataset.row, td);
    });
}

function renderSheet() {
    var selectedRows = {};
    var selectedCols = {};
    state.selectedItems.forEach(function(key) {
        var parts = key.split(':');
        selectedRows[parts[0]] = (selectedRows[parts[0]] || 0) + 1;
        selectedCols[parts[1]] = (selectedCols[parts[1]] || 0) + 1;
    });
    var numRows = state.rows.length;
    var numCols = state.COLUMNS.length;
    var displayCols = state.visibleColumns ? state.COLUMNS.filter(function(c) { return state.visibleColumns.has(c.key); }) : state.COLUMNS;

    var h = '<thead><tr><th class="corner"></th>';
    displayCols.forEach(function(col) {
        var isColSel = state.selectionMode && selectedCols[col.key] === numRows;
        h += '<th class="ch' + (isColSel ? ' col-sel' : '') + '" data-col="' + col.key + '">' + col.label + '</th>';
    });
    h += '<th class="ch-dot"></th>';
    h += '</tr></thead><tbody>';

    state.rows.forEach(function(row, i) {
        var isRowSel = state.selectionMode && selectedRows[i] === numCols;
        h += '<tr class="' + (isRowSel ? 'row-selected' : '') + '"><th class="rh' + (isRowSel ? ' row-sel' : '') + '" data-row="' + i + '">' + (i + 1) + '</th>';
        displayCols.forEach(function(col) {
            var isSel = state.selectedItems.has(i + ':' + col.key);
            var isDup = state.dupCells.has(i + ':' + col.key);
            var isInvalid = state.invalidCells.has(i + ':' + col.key);
            var val = row[col.key] || '';
            h += '<td class="dc' + (isSel ? ' ms-sel' : '') + (isDup ? ' cell-dup' : '') + (isInvalid ? ' cell-invalid' : '') + '" data-row="' + i + '" data-col="' + col.key + '"><div class="cell-inner"><span class="cell-text">' + __ss.esc(val) + '</span></div></td>';
        });
        var status = row.status || '';
        var isDup = state.dupRows.has(i) || state.crossDupRows.has(i);
        var dotClass = isDup ? 'd-yellow' : (row.wa_status === 'eligible' ? 'd-green' : status === 'good' ? 'd-blue' : status === 'bad' ? 'd-red' : status === 'pending' ? 'd-yellow' : '');
        h += '<td class="dot-cell" data-row="' + i + '"><div style="display:flex;align-items:center;justify-content:center;gap:4px">';
        h += '<span class="row-dot ' + dotClass + '"></span>';
        h += '</div></td>';
        h += '</tr>';
    });

    h += '<tr class="add-row"><td class="rh-add" colspan="' + (1 + displayCols.length + 1) + '" id="addRowCell">+ Add row</td></tr>';
    h += '</tbody>';
    dom.grid.innerHTML = h;

    var addCell = document.getElementById('addRowCell');
    if (addCell) addCell.addEventListener('click', addRow);

    populateCellMaps();
    updateUndoRedo();
    updateDuplicateState();
}

// ── Row operations ──

function addRow() {
    for (var i = 0; i < 100; i++) {
        state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
    }
    state.isDirty = true;
    renderSheet();
    persist();
    __ss.showToast('100 rows added');
}

function doubleTapAction(rowIdx, colKey) {
    var row = state.rows[rowIdx];
    if (!row) return;
    var val = row[colKey] || '';
    if (!val) {
        navigator.clipboard.readText().then(function(text) {
            if (!text) return;
            __ss.vibrate();
            pushUndo(rowIdx, colKey, row[colKey] || '');
            row[colKey] = text;
            updateCellInPlace(rowIdx, colKey, text);
            var behavior = __ss.getFileBehavior(state.currentFileType);
            if (behavior && behavior.onCellChange) {
                var preSnapshot = {};
                state.COLUMNS.forEach(function(c) { preSnapshot[c.key] = row[c.key] || ''; });
                behavior.onCellChange(rowIdx, colKey, text, state);
                state.COLUMNS.forEach(function(c) {
                    var newVal = row[c.key] || '';
                    if (newVal !== preSnapshot[c.key]) updateCellInPlace(rowIdx, c.key, newVal);
                });
            }
            if (!behavior || !behavior.onCellChange) {
                updateCellInPlace(rowIdx, colKey, text);
            }
            state.isDirty = true;
            findDuplicates();
            maybeAutoCheck(rowIdx, colKey);
            updateDuplicateState();
            updateValidationState();
            persist();
            __ss.showToast('Pasted');
        }).catch(function() {});
    } else {
        navigator.clipboard.writeText(val).then(function() {
            __ss.vibrate();
            __ss.showToast('Copied');
        }).catch(function() {});
    }
}

// ── Quick edit bar ──
function openQuickEdit(rowIdx, colKey) {
    var row = state.rows[rowIdx];
    if (!row) return;
    state.selectedCell = { rowIdx: rowIdx, colIdx: colKey, originalVal: row[colKey] || '' };
    var col = state.COLUMNS.find(function(c) { return c.key === colKey; });
    dom.qebChip.textContent = col ? col.label : colKey;
    dom.qebInput.value = row[colKey] || '';
    dom.qebBar.classList.add('open');
    var td = _cellMap.get(rowIdx + ':' + colKey);
    state.selectedCell.domText = td ? td.querySelector('.cell-text') : null;
    __ss.highlightCell(td);
}

function commitQuickEdit() {
    if (!state.selectedCell) return;
    var row = state.rows[state.selectedCell.rowIdx];
    if (!row) return;
    var val = dom.qebInput.value;
    if (val !== state.selectedCell.originalVal) {
        pushUndo(state.selectedCell.rowIdx, state.selectedCell.colIdx, state.selectedCell.originalVal);
        row[state.selectedCell.colIdx] = val;
        updateCellInPlace(state.selectedCell.rowIdx, state.selectedCell.colIdx, val);
        state.isDirty = true;
        var behavior = __ss.getFileBehavior(state.currentFileType);
        if (behavior && behavior.onCellChange) {
            var preSnapshot = {};
            state.COLUMNS.forEach(function(c) { preSnapshot[c.key] = row[c.key] || ''; });
            behavior.onCellChange(state.selectedCell.rowIdx, state.selectedCell.colIdx, val, state);
            state.COLUMNS.forEach(function(c) {
                var newVal = row[c.key] || '';
                if (newVal !== preSnapshot[c.key]) updateCellInPlace(state.selectedCell.rowIdx, c.key, newVal);
            });
        } else {
            updateCellInPlace(state.selectedCell.rowIdx, state.selectedCell.colIdx, val);
        }
        findDuplicates();
        maybeAutoCheck(state.selectedCell.rowIdx, state.selectedCell.colIdx);
        updateDuplicateState();
        updateValidationState();
        persist();
    }
    dom.qebBar.classList.remove('open');
    __ss.clearCellHighlight();
    state.selectedCell = null;
}

dom.qebSaveBtn.addEventListener('click', commitQuickEdit);
dom.qebInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitQuickEdit(); }
    if (e.key === 'Escape') { dom.qebBar.classList.remove('open'); __ss.clearCellHighlight(); state.selectedCell = null; }
});
dom.qebInput.addEventListener('input', function() {
    if (!state.selectedCell || state.selectedCell.rowIdx === undefined) return;
    if (state.selectedCell.domText) {
        state.selectedCell.domText.textContent = dom.qebInput.value;
    }
});
dom.qebPasteBtn.addEventListener('click', function() {
    navigator.clipboard.readText().then(function(t) {
        dom.qebInput.value = t;
        dom.qebInput.focus();
        if (state.selectedCell) {
            var row = state.rows[state.selectedCell.rowIdx];
            if (row) {
                pushUndo(state.selectedCell.rowIdx, state.selectedCell.colIdx, row[state.selectedCell.colIdx] || '');
                row[state.selectedCell.colIdx] = t;
                state.isDirty = true;
                if (state.selectedCell.domText) {
                    state.selectedCell.domText.textContent = t;
                }
                var behavior = __ss.getFileBehavior(state.currentFileType);
                if (behavior && behavior.onCellChange) {
                    behavior.onCellChange(state.selectedCell.rowIdx, state.selectedCell.colIdx, t, state);
                }
                findDuplicates();
                updateDuplicateState();
                updateValidationState();
                persist();
            }
        }
    }).catch(function() { __ss.showToast('Cannot read clipboard'); });
});
dom.qebClearBtn.addEventListener('click', function() {
    dom.qebInput.value = '';
    dom.qebInput.focus();
    if (state.selectedCell) {
        var row = state.rows[state.selectedCell.rowIdx];
        if (row) {
            pushUndo(state.selectedCell.rowIdx, state.selectedCell.colIdx, row[state.selectedCell.colIdx] || '');
            row[state.selectedCell.colIdx] = '';
            state.isDirty = true;
            if (state.selectedCell.domText) {
                state.selectedCell.domText.textContent = '';
            }
            var behavior = __ss.getFileBehavior(state.currentFileType);
            if (behavior && behavior.onCellChange) {
                behavior.onCellChange(state.selectedCell.rowIdx, state.selectedCell.colIdx, '', state);
            }
            findDuplicates();
            updateDuplicateState();
            updateValidationState();
            persist();
        }
    }
});

// ── Selection mode ──
function enterSelectionMode(type, row, col) {
    __ss.vibrate();
    state.selectionMode = true;
    dom.qebBar.classList.remove('open');
    __ss.clearCellHighlight();
    state.selectedCell = null;
    if (type === 'cell') {
        state.selectedItems.add(row + ':' + col);
    } else if (type === 'col') {
        state.rows.forEach(function(r, i) { state.selectedItems.add(i + ':' + col); });
    } else if (type === 'row') {
        state.COLUMNS.forEach(function(c) { state.selectedItems.add(row + ':' + c.key); });
    }
    updateSelBar();
    updateSelectionDOM();
}

function exitSelectionMode() {
    state.selectionMode = false;
    state.selectedItems.clear();
    dom.selBar.classList.remove('open');
    updateSelectionDOM();
}

function toggleSelection(type, row, col) {
    state.selectionMode = true;
    if (type === 'cell') {
        var key = row + ':' + col;
        if (state.selectedItems.has(key)) state.selectedItems.delete(key);
        else state.selectedItems.add(key);
    } else if (type === 'col') {
        var allInCol = state.rows.length > 0 && state.rows.every(function(r, i) { return state.selectedItems.has(i + ':' + col); });
        if (allInCol) {
            state.rows.forEach(function(r, i) { state.selectedItems.delete(i + ':' + col); });
        } else {
            state.rows.forEach(function(r, i) { state.selectedItems.add(i + ':' + col); });
        }
    } else if (type === 'row') {
        var allInRow = state.COLUMNS.every(function(c) { return state.selectedItems.has(row + ':' + c.key); });
        if (allInRow) {
            state.COLUMNS.forEach(function(c) { state.selectedItems.delete(row + ':' + c.key); });
        } else {
            state.COLUMNS.forEach(function(c) { state.selectedItems.add(row + ':' + c.key); });
        }
    }
    updateSelBar();
    updateSelectionDOM();
}

function updateSelBar() {
    var total = state.selectedItems.size;
    if (total === 0) {
        exitSelectionMode();
        return;
    }
    dom.selCount.textContent = total + ' selected';
    dom.selBar.classList.add('open');
}

function deleteSelectedCells() {
    if (!state.selectionMode) return;
    var behavior = __ss.getFileBehavior(state.currentFileType);
    state.selectedItems.forEach(function(key) {
        var parts = key.split(':');
        var rowIdx = parseInt(parts[0]);
        var colKey = parts[1];
        if (state.rows[rowIdx]) {
            var prevVal = state.rows[rowIdx][colKey] || '';
            if (prevVal !== '') pushUndo(rowIdx, colKey, prevVal);
            state.rows[rowIdx][colKey] = '';
            updateCellInPlace(rowIdx, colKey, '');
            if (behavior && behavior.onCellChange) {
                behavior.onCellChange(rowIdx, colKey, '', state);
            }
        }
    });
    state.isDirty = true;
    findDuplicates();
    updateDuplicateState();
    updateValidationState();
    exitSelectionMode();
    persist();
    __ss.showToast('Deleted');
}

function copySelectedCells() {
    if (!state.selectionMode) return;
    var byRow = {};
    state.selectedItems.forEach(function(key) {
        var parts = key.split(':');
        var rowIdx = parseInt(parts[0]);
        var colKey = parts[1];
        if (!byRow[rowIdx]) byRow[rowIdx] = [];
        byRow[rowIdx].push({col: colKey, val: state.rows[rowIdx] ? state.rows[rowIdx][colKey] || '' : ''});
    });
    var colOrder = state.COLUMNS.map(function(c) { return c.key; });
    var colOrderMap = {};
    colOrder.forEach(function(k, i) { colOrderMap[k] = i; });
    var sortedRows = Object.keys(byRow).sort(function(a, b) { return a - b; });
    var lines = [];
    sortedRows.forEach(function(ri) {
        var cells = byRow[ri];
        cells.sort(function(a, b) { return colOrderMap[a.col] - colOrderMap[b.col]; });
        lines.push(cells.map(function(c) { return c.val; }).join('\t'));
    });
    var text = lines.join('\n');
    if (!text) { __ss.showToast('Nothing to copy'); return; }
    navigator.clipboard.writeText(text).then(function() {
        __ss.showToast('Copied ' + state.selectedItems.size + ' cells');
        exitSelectionMode();
    }).catch(function() { __ss.showToast('Cannot copy'); });
}

function selectAllCells() {
    dom.qebBar.classList.remove('open');
    __ss.clearCellHighlight();
    state.selectedCell = null;
    state.selectionMode = true;
    state.selectedItems.clear();
    state.rows.forEach(function(row, i) {
        state.COLUMNS.forEach(function(col) {
            state.selectedItems.add(i + ':' + col.key);
        });
    });
    _cellMap.forEach(function(td) { td.classList.add('ms-sel'); });
    updateSelBar();
}

// ── Selection bar events ──
dom.selDelete.addEventListener('click', deleteSelectedCells);
dom.selCopy.addEventListener('click', copySelectedCells);
dom.selSelectAll.addEventListener('click', selectAllCells);
dom.selUnselectAll.addEventListener('click', function() {
    state.selectedItems.clear();
    exitSelectionMode();
});

// ── Copy all ──
dom.copyAllBtn.addEventListener('click', function() {
    dom.sheetMoreMenu.classList.remove('open');
    if (!state.rows.length) { __ss.showToast('No data'); return; }
    var lines = [];
    lines.push(state.COLUMNS.map(function(c) { return c.label; }).join('\t'));
    var hasData = false;
    state.rows.forEach(function(row) {
        var isEmpty = state.COLUMNS.every(function(c) { return !row[c.key]; });
        if (!isEmpty) {
            hasData = true;
            lines.push(state.COLUMNS.map(function(c) { return row[c.key] || ''; }).join('\t'));
        }
    });
    if (!hasData) { __ss.showToast('No data'); return; }
    var text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function() {
        __ss.showToast('Copied ' + (lines.length - 1) + ' rows');
    }).catch(function() { __ss.showToast('Cannot copy'); });
});

// ── Sheet more menu ──
dom.sheetMoreBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var rect = dom.sheetMoreBtn.getBoundingClientRect();
    dom.sheetMoreMenu.style.top = (rect.bottom + 4) + 'px';
    dom.sheetMoreMenu.style.right = (window.innerWidth - rect.right) + 'px';
    dom.sheetMoreMenu.classList.toggle('open');
});

document.addEventListener('click', function() {
    dom.sheetMoreMenu.classList.remove('open');
});

// ── Download xlsx ──
function _doDownload(filterFn, suffix) {
    var dlCols = state.COLUMNS.filter(function(c) { return c.key !== 'uid'; });
    var data = [];
    var hasData = false;
    state.rows.forEach(function(row, idx) {
        if (filterFn && !filterFn(row, idx)) return;
        var isEmpty = dlCols.every(function(c) { return !row[c.key]; });
        if (!isEmpty) {
            hasData = true;
            data.push(dlCols.map(function(c) { return row[c.key] || ''; }));
        }
    });
    if (!hasData) { __ss.showToast('No data to download'); return; }
    var ws = XLSX.utils.aoa_to_sheet(data);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    var name = (dom.sheetTitleBtn._fullName || dom.sheetTitleBtn.textContent || 'export') + (suffix || '') + ' [' + data.length + ']';
    XLSX.writeFile(wb, name + '.xlsx');
    __ss.showToast('Downloaded');
}

dom.menuDownload.addEventListener('click', function() {
    dom.sheetMoreMenu.classList.remove('open');

    if (state.currentFileType !== 'fb_cookie') {
        _doDownload(null, '');
        return;
    }

    var dlCols = state.COLUMNS.filter(function(c) { return c.key !== 'uid'; });
    var total = 0, active = 0, wa = 0, activeNoWa = 0, combo = 0, onlyCookie = 0, only2fa = 0, dead = 0;
    state.rows.forEach(function(row) {
        var empty = dlCols.every(function(c) { return !row[c.key]; });
        if (!empty) total++;
        if (row.status === 'good') active++;
        if (row.wa_status === 'eligible') wa++;
        if (row.status === 'good' && row.wa_status !== 'eligible') activeNoWa++;
        if (row.status === 'good' && row.cookies && row.twofakey) combo++;
        if (row.status === 'good' && row.cookies && !row.twofakey) onlyCookie++;
        if (row.status === 'good' && row.twofakey && !row.cookies) only2fa++;
        if (row.status === 'bad') dead++;
    });

    var opts = '';
    if (total > 0) opts += '<button class="download-opt-btn primary" data-opt="all">All <span class="opt-count">' + total + '</span></button>';
    if (active > 0) opts += '<button class="download-opt-btn btn-green" data-opt="valid">Alive <span class="opt-count">' + active + '</span></button>';
    if (combo > 0) opts += '<button class="download-opt-btn btn-violet" data-opt="combo">Cookie + 2FA <span class="opt-count">' + combo + '</span></button>';
    if (onlyCookie > 0) opts += '<button class="download-opt-btn btn-slate" data-opt="onlycookie">Only Cookie <span class="opt-count">' + onlyCookie + '</span></button>';
    if (only2fa > 0) opts += '<button class="download-opt-btn btn-cyan" data-opt="only2fa">Only 2FA <span class="opt-count">' + only2fa + '</span></button>';
    if (wa > 0) opts += '<button class="download-opt-btn btn-blue" data-opt="wa">FB Page <span class="opt-count">' + wa + '</span></button>';
    if (activeNoWa > 0) opts += '<button class="download-opt-btn btn-amber" data-opt="valid-nwa">No Page <span class="opt-count">' + activeNoWa + '</span></button>';
    if (dead > 0) opts += '<button class="download-opt-btn btn-red" data-opt="dead">Dead <span class="opt-count">' + dead + '</span></button>';

    var overlay = document.createElement('div');
    overlay.className = 'download-opt-overlay';
    overlay.innerHTML =
        '<div class="download-opt-box">' +
            '<div class="download-opt-title">Download</div>' +
            opts +
            '<button class="download-opt-cancel">Cancel</button>' +
        '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function(e) {
        var btn = e.target.closest('.download-opt-btn');
        if (btn && !btn.classList.contains('disabled')) {
            overlay.remove();
            switch (btn.dataset.opt) {
                case 'all': _doDownload(null, ''); break;
                case 'valid': _doDownload(function(row) { return row.status === 'good'; }, ' (Alive)'); break;
                case 'combo': _doDownload(function(row) { return row.status === 'good' && row.cookies && row.twofakey; }, ' (Cookie + 2FA)'); break;
                case 'onlycookie': _doDownload(function(row) { return row.status === 'good' && row.cookies && !row.twofakey; }, ' (Only Cookie)'); break;
                case 'only2fa': _doDownload(function(row) { return row.status === 'good' && !row.cookies && row.twofakey; }, ' (Only 2FA)'); break;
                case 'wa': _doDownload(function(row) { return row.wa_status === 'eligible'; }, ' (FB Page)'); break;
                case 'valid-nwa': _doDownload(function(row) { return row.status === 'good' && row.wa_status !== 'eligible'; }, ' (No Page)'); break;
                case 'dead': _doDownload(function(row) { return row.status === 'bad'; }, ' (Dead)'); break;
            }
        } else if (e.target.closest('.download-opt-cancel') || e.target === overlay) {
            overlay.remove();
        }
    });
});

// ── Upload xlsx (inside file) ──
var pendingUploadData = null;
var pendingMerge = false;

function dedupKeyForRow(row) {
    if (state.currentFileType === 'fb_cookie') {
        if (row.uid) return row.uid;
        if (row.cookies) { var m = row.cookies.match(/c_user=(\d+)/); if (m) return m[1]; }
        return null;
    }
    if (state.currentFileType === 'ig_cookie') return row.username || null;
    return null;
}

function mergeRows(incoming) {
    var existing = {};
    state.rows.forEach(function(row) {
        var k = dedupKeyForRow(row);
        if (k) existing[k] = true;
    });
    var added = [];
    var skipped = 0;
    incoming.forEach(function(row) {
        var k = dedupKeyForRow(row);
        if (k && existing[k]) { skipped++; return; }
        if (k) existing[k] = true;
        added.push(row);
    });
    if (added.length === 0) { __ss.showToast('Merged 0 (skipped ' + skipped + ')'); return; }
    state.undoStack.push({ type: 'rows', prevRows: state.rows.map(function(r) { return Object.assign({}, r); }) });
    state.redoStack = [];
    state.rows = state.rows.concat(added);
    state.isDirty = true;
    renderSheet();
    findDuplicates();
    renderSheet();
    persist('merge');
    if (state.currentFileId && api.getCrossDups) {
        api.getCrossDups(state.currentFileId).then(function(cd) {
            if (cd) { state.crossDups = cd.dups; findDuplicates(); updateDuplicateState(); }
        }).catch(function() {});
    }
    updateUndoRedo();
    __ss.showToast('Merged ' + added.length + ' (skipped ' + skipped + ')');
}

dom.menuMerge.addEventListener('click', function() {
    dom.sheetMoreMenu.classList.remove('open');
    pendingMerge = true;
    dom.xlsxFileInput.click();
});

dom.menuUpload.addEventListener('click', function() {
    dom.sheetMoreMenu.classList.remove('open');
    dom.xlsxFileInput.click();
});

dom.xlsxFileInput.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    var reader = new FileReader();
    reader.onload = function(ev) {
        var wb = XLSX.read(ev.target.result, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var json = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (json.length < 1) { __ss.showToast('File is empty'); return; }
        var headers = (json[0] || []).map(function(h) { return String(h).toLowerCase().trim(); });
        var colMap = null;
        var dataStart = 1;
        var matchedCols = state.COLUMNS.filter(function(c) {
            return headers.indexOf(c.key.toLowerCase()) !== -1 || headers.indexOf(c.label.toLowerCase()) !== -1;
        });
        if (matchedCols.length > 0) {
            colMap = matchedCols.map(function(c) {
                var idx = headers.indexOf(c.key.toLowerCase());
                if (idx === -1) idx = headers.indexOf(c.label.toLowerCase());
                return { key: c.key, idx: idx };
            });
        } else {
            colMap = state.COLUMNS.map(function(c, i) { return { key: c.key, idx: i }; });
            dataStart = 0;
        }
        var rows = [];
        for (var i = dataStart; i < json.length; i++) {
            var row = {};
            var hasData = false;
            colMap.forEach(function(cm) {
                var val = json[i][cm.idx] || '';
                row[cm.key] = String(val);
                if (val) hasData = true;
            });
            if (hasData) rows.push(row);
        }
        if (rows.length === 0) { __ss.showToast('No data rows found'); return; }
        if (state.currentFileType === 'fb_cookie') {
            rows.forEach(function(r) {
                if (r.cookies) {
                    var m = r.cookies.match(/c_user=(\d+)/);
                    if (m) r.uid = m[1];
                }
            });
        }
        if (pendingMerge) {
            pendingMerge = false;
            mergeRows(rows);
            return;
        }
        pendingUploadData = rows;
        dom.uploadModeOverlay.classList.add('open');
    };
    reader.readAsArrayBuffer(file);
});

dom.uploadReplace.addEventListener('click', async function() {
    if (!pendingUploadData) return;
    var ok = await __ss.showConfirm('Replace ALL ' + pendingUploadData.length + ' rows? Your file currently holds ' + state.rows.length + ' rows. Existing data will be **permanently replaced**. Continue?', 'Yes, replace');
    if (!ok) return;
    dom.uploadModeOverlay.classList.remove('open');
    state.undoStack = []; state.redoStack = [];
    state.rows = pendingUploadData;
    while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
    state.isDirty = true;
    renderSheet();
    findDuplicates();
    renderSheet();
    persist('replace');
    if (state.currentFileId && api.getCrossDups) {
        api.getCrossDups(state.currentFileId).then(function(cd) {
            if (cd) { state.crossDups = cd.dups; }
        }).catch(function() {});
    }
    __ss.showToast('Replaced with ' + pendingUploadData.length + ' rows');
    pendingUploadData = null;
});

dom.uploadAppend.addEventListener('click', function() {
    if (!pendingUploadData) return;
    dom.uploadModeOverlay.classList.remove('open');
    state.undoStack = []; state.redoStack = [];
    state.rows = state.rows.concat(pendingUploadData);
    state.isDirty = true;
    renderSheet();
    findDuplicates();
    renderSheet();
    persist('append');
    if (state.currentFileId && api.getCrossDups) {
        api.getCrossDups(state.currentFileId).then(function(cd) {
            if (cd) { state.crossDups = cd.dups; }
        }).catch(function() {});
    }
    __ss.showToast('Appended ' + pendingUploadData.length + ' rows');
    pendingUploadData = null;
});

dom.uploadModeCancel.addEventListener('click', function() {
    dom.uploadModeOverlay.classList.remove('open');
    pendingUploadData = null;
});

dom.uploadModeOverlay.addEventListener('click', function(e) {
    if (e.target === dom.uploadModeOverlay) {
        dom.uploadModeOverlay.classList.remove('open');
        pendingUploadData = null;
    }
});

// ── Version history modal ──
var ACTION_LABELS = {
    edit: 'Edit',
    replace: 'Replace',
    append: 'Append',
    merge: 'Merge',
    restore: 'Restore',
    check: 'Check',
    sync: 'Sync',
    import: 'Import'
};

var _versionMeta = null;
var _versionShown = 0;
var _versionPageSize = 50;
var _versionGroupsOpen = {};
var _versionRowCache = new Map();
var _versionDayEls = {};
var _versionSummaryEls = {};
var _versionPage = 1;
var _versionPages = 1;
var _WEEK = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function versionApiGetHistory(fileId) {
    return state.isAdminFile ? api.adminGetHistory(fileId) : api.getHistory(fileId);
}
function versionApiGetVersion(fileId, v) {
    return state.isAdminFile ? api.adminGetVersion(fileId, v) : api.getVersion(fileId, v);
}
function versionApiRestore(fileId, v) {
    return state.isAdminFile ? api.adminRestoreVersion(fileId, v) : api.restoreVersion(fileId, v);
}
function versionApiName(fileId, v, name) {
    return state.isAdminFile ? api.adminNameVersion(fileId, v, name) : api.nameVersion(fileId, v, name);
}
function versionApiFork(fileId, v) {
    return state.isAdminFile ? api.adminForkVersion(fileId, v) : api.forkVersion(fileId, v);
}

function fmtVersionTime(ts) {
    var d = new Date(ts);
    var now = Date.now();
    var diff = now - ts;
    var rel;
    if (diff < 60000) rel = 'just now';
    else if (diff < 3600000) rel = Math.floor(diff / 60000) + ' min ago';
    else if (diff < 86400000) rel = Math.floor(diff / 3600000) + ' hr ago';
    else rel = Math.floor(diff / 86400000) + ' day' + (Math.floor(diff / 86400000) > 1 ? 's' : '') + ' ago';
    var pad = function(n) { return String(n).padStart(2, '0'); };
    return (d.getDate() + ' ' + _MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes())) + '  (' + rel + ')';
}

// Cached per-version row load (keys + rows). Never rejects; errors degrade to empty.
function versionRows(v) {
    v = Number(v);
    var hit = _versionRowCache.get(v);
    if (hit) return Promise.resolve(hit);
    return versionApiGetVersion(state.currentFileId, v).then(function(data) {
        var rows = (data && data.rows) ? data.rows : [];
        var keys = new Set();
        rows.forEach(function(r) {
            var k = dedupKeyForRow(r);
            if (k) keys.add(String(k));
        });
        var rec = { rows: rows, keys: keys, ok: !!(data && data.rows) };
        _versionRowCache.set(v, rec);
        return rec;
    }).catch(function(e) {
        console.error('[Versions] load v' + v + ' error:', e);
        var rec = { rows: [], keys: new Set(), ok: false };
        _versionRowCache.set(v, rec);
        return rec;
    });
}

// One-liner "what happened" per version.
function versionSummary(rec, prev) {
    if (!prev) return 'Created file with ' + rec.rowCount + ' row' + (rec.rowCount === 1 ? '' : 's');
    var cur = _versionRowCache.get(Number(rec.v));
    var old = _versionRowCache.get(Number(prev.v));
    if (cur && old && cur.keys.size && old.keys.size) {
        var added = 0, removed = 0;
        cur.keys.forEach(function(k) { if (!old.keys.has(k)) added++; });
        old.keys.forEach(function(k) { if (!cur.keys.has(k)) removed++; });
        var waChanged = 0;
        var oldByKey = {};
        old.rows.forEach(function(r) {
            var k = dedupKeyForRow(r);
            if (k !== null && k !== undefined) oldByKey[String(k)] = r;
        });
        cur.rows.forEach(function(r) {
            var k = dedupKeyForRow(r);
            if (k === null || k === undefined) return;
            var o = oldByKey[String(k)];
            if (o && ((o.wa_status || '') !== (r.wa_status || ''))) waChanged++;
        });
        var delta = rec.rowCount - prev.rowCount;
        var parts = [];
        if (added) parts.push('Added ' + added + ' row' + (added === 1 ? '' : 's') + ' (' + added + ' new uid' + (added === 1 ? '' : 's') + ')');
        if (removed) parts.push('Removed ' + removed + ' row' + (removed === 1 ? '' : 's'));
        if (waChanged) parts.push('Changed wa_status on ' + waChanged + ' row' + (waChanged === 1 ? '' : 's'));
        if (!parts.length) {
            if (delta !== 0) return 'Full replace ' + prev.rowCount + '→' + rec.rowCount + ' rows';
            return 'Same rows (' + rec.rowCount + ')';
        }
        return parts.join(', ');
    }
    if (rec.rowCount !== prev.rowCount) {
        var d = rec.rowCount - prev.rowCount;
        if (d > 0) return '+' + d + ' rows';
        return d + ' rows';
    }
    return 'Same row count (' + rec.rowCount + ' rows)';
}

function dayKeyOf(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function fmtDayHeader(ts) {
    var d = new Date(ts);
    return _WEEK[d.getDay()] + ' ' + d.getDate() + ' ' + _MONTHS[d.getMonth()];
}

function insertVersionEl(el) {
    dom.versionList.appendChild(el);
}

function dayBuildGroup(ts) {
    var key = dayKeyOf(ts);
    var grp = _versionDayEls[key];
    if (!grp) {
        grp = document.createElement('div');
        grp.className = 'version-day-group open';
        if (_versionGroupsOpen[key] === false) grp.classList.remove('open');
        var head = document.createElement('div');
        head.className = 'version-day';
        var label = document.createElement('span');
        label.className = 'version-day-label';
        label.textContent = fmtDayHeader(ts);
        var countEl = document.createElement('span');
        countEl.className = 'version-day-count';
        countEl.textContent = '0';
        head.appendChild(label);
        head.appendChild(countEl);
        head.addEventListener('click', function() {
            var open = grp.classList.contains('open');
            grp.classList.toggle('open', !open);
            _versionGroupsOpen[key] = !open;
        });
        grp.appendChild(head);
        _versionDayEls[key] = grp;
        insertVersionEl(grp);
    }
    return grp;
}

function renderVersionPager() {
    var pager = document.createElement('div');
    pager.className = 'version-pager';
    var info = document.createElement('span');
    info.className = 'version-pager-info';
    var total = _versionMeta ? _versionMeta.length : 0;
    var from = _versionMeta && _versionMeta.length ? (_versionPage - 1) * _versionPageSize + 1 : 0;
    var to = Math.min(_versionPage * _versionPageSize, total);
    info.textContent = total === 0 ? 'No versions' : 'Page ' + _versionPage + ' of ' + _versionPages + ' · ' + from + '–' + to + ' of ' + total;
    var btns = document.createElement('span');
    btns.className = 'version-pager-btns';
    var prevBtn = document.createElement('button');
    prevBtn.className = 'version-page-btn';
    prevBtn.textContent = '← Prev';
    prevBtn.disabled = _versionPage <= 1;
    prevBtn.addEventListener('click', function() { goVersionPage(_versionPage - 1); });
    var nextBtn = document.createElement('button');
    nextBtn.className = 'version-page-btn';
    nextBtn.textContent = 'Next →';
    nextBtn.disabled = _versionPage >= _versionPages;
    nextBtn.addEventListener('click', function() { goVersionPage(_versionPage + 1); });
    btns.appendChild(prevBtn);
    btns.appendChild(nextBtn);
    pager.appendChild(info);
    pager.appendChild(btns);
    dom.versionList.appendChild(pager);
}

function goVersionPage(n) {
    n = Math.max(1, Math.min(_versionPages, n));
    if (n === _versionPage) return;
    _versionPage = n;
    renderVersionPage();
}

function renderVersionPage() {
    var meta = _versionMeta;
    removeVersionPager();
    _versionDayEls = {};
    _versionSummaryEls = {};
    if (!meta || !meta.length) {
        var empty = document.createElement('div');
        empty.className = 'version-empty';
        empty.textContent = 'No versions yet — actions like replace, append, merge, check and sync are saved here.';
        dom.versionList.appendChild(empty);
        return;
    }
    renderVersionPager();
    var start = (_versionPage - 1) * _versionPageSize;
    var end = Math.min(start + _versionPageSize, meta.length);
    for (var i = start; i < end; i++) {
        buildVersionItem(meta[i], i);
    }
    refreshVersionDayCounts();
}

function refreshVersionDayCounts() {
    Object.keys(_versionDayEls).forEach(function(key) {
        var grp = _versionDayEls[key];
        var countEl = grp && grp.querySelector('.version-day-count');
        if (countEl) {
            var n = 0;
            var children = grp.querySelectorAll(':scope > .version-item');
            n = children.length;
            countEl.textContent = String(n) + (n === 1 ? ' version' : ' versions');
        }
    });
}

function removeVersionPager() {
    var el = dom.versionList.querySelector('.version-pager');
    if (el) el.remove();
}

// Fetch the current page's version rows (bounded ~pageSize), then refresh each summary in place.
function prefetchVersionSummaries() {
    var meta = _versionMeta || [];
    var start = (_versionPage - 1) * _versionPageSize;
    var end = Math.min(start + _versionPageSize, meta.length);
    for (var i = start; i < end; i++) {
        (function(idx) {
            var rec = meta[idx];
            versionRows(Number(rec.v)).then(function() {
                var sumEl = _versionSummaryEls['v' + rec.v];
                if (sumEl) sumEl.textContent = versionSummary(rec, meta[idx + 1]);
            });
        })(i);
    }
}

function buildVersionItem(rec, idx) {
    var prev = _versionMeta[idx + 1];
    var delta = prev ? rec.rowCount - prev.rowCount : rec.rowCount;
    var deltaTxt = prev ? (delta > 0 ? '+' + delta : String(delta)) : '=0';
    var item = document.createElement('div');
    item.className = 'version-item';
    item.innerHTML =
        '<div class="version-head">' +
            '<div class="version-meta">' +
                (rec.name ? '<div class="version-name-row"><span class="version-name">' + __ss.esc(rec.name) + '</span><button class="version-rename-btn">Rename</button></div>' : '') +
                '<div class="version-time">' + fmtVersionTime(rec.ts) + '</div>' +
                '<div class="version-summary">' + __ss.esc(versionSummary(rec, prev)) + '</div>' +
                '<div class="version-detail">' + (prev ? (delta >= 0 ? 'Added ' + delta + ' row' + (delta === 1 ? '' : 's') : 'Removed ' + (-delta) + ' row' + (delta === -1 ? '' : 's')) : 'Created file with ' + rec.rowCount + ' row' + (rec.rowCount === 1 ? '' : 's')) + ' · ' + rec.rowCount + ' rows</div>' +
            '</div>' +
            '<span class="version-badge ' + (rec.action === 'restore' ? 'restore' : (rec.action === 'replace' || rec.action === 'merge') ? 'replace' : '') + '">[' + (prev ? deltaTxt : 'New') + '] ' + (ACTION_LABELS[rec.action] || rec.action) + '</span>' +
        '</div>' +
        '<div class="version-footer-actions">' +
            '<button class="version-fork-btn">Copy version</button>' +
            '<span class="spacer"></span>' +
            '<button class="btn btn-ghost btn-sm version-preview-btn">Preview</button>' +
            '<button class="btn btn-danger btn-sm version-restore-btn">Restore</button>' +
        '</div>';
    _versionSummaryEls['v' + rec.v] = item.querySelector('.version-summary');
    var previewBtn = item.querySelector('.version-preview-btn');
    var restoreBtn = item.querySelector('.version-restore-btn');
    var forkBtn = item.querySelector('.version-fork-btn');
    var renameBtn = item.querySelector('.version-rename-btn');
    previewBtn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        toggleVersionPreview(item, rec);
    });
    restoreBtn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        confirmVersionRestore(rec);
    });
    forkBtn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        forkVersion(rec);
    });
    if (renameBtn) {
        renameBtn.addEventListener('click', function(ev) {
            ev.stopPropagation();
            startVersionRename(item, rec);
        });
    }
    dayBuildGroup(rec.ts).appendChild(item);
}

function renderVersionList(meta, preserveState) {
    _versionMeta = meta;
    if (!preserveState) {
        _versionShown = 0;
        _versionGroupsOpen = {};
        _versionPage = 1;
        if (meta && meta.length) _versionPages = Math.ceil(meta.length / _versionPageSize);
        else _versionPages = 1;
    }
    dom.versionList.innerHTML = '';
    dom.versionEmpty.style.display = 'none';
    renderVersionPage();
    prefetchVersionSummaries();
}

// ── Diff engine for version preview ──
function vRowLine(r) {
    var cols = state.COLUMNS || [];
    var vals = [];
    cols.forEach(function (c) {
        var v = r ? r[c.key] : null;
        vals.push((v === null || v === undefined) ? '' : String(v));
    });
    return vals.join(' | ');
}

function vComputeDiff(parentRows, childRows) {
    function vRowMap(rows) {
        var m = {};
        (rows || []).forEach(function (r) {
            var k = dedupKeyForRow(r);
            if (k) m[String(k)] = r;
        });
        return m;
    }
    var om = vRowMap(parentRows), cm = vRowMap(childRows);
    var keys = [];
    Object.keys(om).forEach(function(k){ if(keys.indexOf(k)===-1) keys.push(k); });
    Object.keys(cm).forEach(function(k){ if(keys.indexOf(k)===-1) keys.push(k); });
    var lines = [], add = 0, del = 0;
    keys.forEach(function (k) {
        var o = om[k], n = cm[k];
        if (o && n) {
            if (vRowLine(o) === vRowLine(n)) lines.push({ type: 'ctx', text: vRowLine(n) });
            else { lines.push({ type: 'del', text: vRowLine(o) }); lines.push({ type: 'add', text: vRowLine(n) }); del++; add++; }
        } else if (n) { lines.push({ type: 'add', text: vRowLine(n) }); add++; }
        else { lines.push({ type: 'del', text: vRowLine(o) }); del++; }
    });
    return { lines: lines, add: add, del: del };
}

function vDiffHtml(d, rec, prev) {
    var o = 1, n = 1;
    var body = d.lines.map(function (ln) {
        var og = (ln.type === 'del' || ln.type === 'ctx') ? String(o++) : '';
        var ng = (ln.type === 'add' || ln.type === 'ctx') ? String(n++) : '';
        var pfx = ln.type === 'add' ? '+' : ln.type === 'del' ? '\u2212' : ' ';
        return '<div class="vline ' + ln.type + '">' +
               '<span class="vnum old">' + og + '</span>' +
               '<span class="vnum new">' + ng + '</span>' +
               '<span class="vpfx">' + pfx + '</span>' +
               '<span class="vcode">' + __ss.esc(ln.text) + '</span>' +
               '</div>';
    }).join('');

    var barAdd = d.add;
    var barDel = d.del;
    var statsHtml = '<span class="vstat-add">+' + d.add + '</span><span class="vstat-del">\u2212' + d.del + '</span>';
    var barHtml = '';
    if (barAdd + barDel > 0) {
        for (var i = 0; i < barAdd; i++) barHtml += '<span class="vbar-add"></span>';
        for (var j = 0; j < barDel; j++) barHtml += '<span class="vbar-del"></span>';
    }

    var typeName = state.currentFileType || 'unknown';
    var fileName = (rec.name || dom.sheetTitleBtn._fullName || 'file');
    return '<div class="vdiff">' +
        '<div class="vdiff-file">' +
            '<span class="vdiff-chevron">\u25BC</span>' +
            '<span class="vdiff-path">' + __ss.esc(fileName + '.xlsx') + '</span>' +
            '<span class="vdiff-tag">' + __ss.esc(typeName) + '</span>' +
            '<span class="vdiff-file-stats">' + statsHtml + '</span>' +
            '<span class="vdiff-bar">' + barHtml + '</span>' +
        '</div>' +
        '<div class="vdiff-hunk">' +
            '<span class="vdiff-hunk-menu">\u22EF</span>' +
            '<span class="vdiff-hunk-text">@@ -1,' + Math.max(1, d.oldLen || 1) + ' +1,' + Math.max(1, d.newLen || 1) + ' @@</span>' +
        '</div>' +
        '<div class="vdiff-lines">' + body + '</div>' +
    '</div>';
}

var _versionPreviewOpen = null;
function toggleVersionPreview(item, rec) {
    var existing = item.querySelector('.vdiff');
    if (existing) { existing.remove(); item.classList.remove('open'); _versionPreviewOpen = null; return; }
    if (_versionPreviewOpen) { _versionPreviewOpen.remove(); _versionPreviewOpen = null; }
    var wrap = document.createElement('div');
    wrap.textContent = 'Loading preview…';
    wrap.className = 'version-preview';
    item.appendChild(wrap);
    _versionPreviewOpen = wrap;

    var prev = _versionMeta[_versionMeta.indexOf(rec) + 1] || null;
    versionRows(Number(rec.v)).then(function(cached) {
        if (!wrap.parentNode) return;
        if (!cached.ok) { wrap.textContent = 'Could not load version'; console.error('[Versions] preview failed for v' + rec.v + ':', cached.rows); return; }
        if (prev) {
            versionRows(Number(prev.v)).then(function(prevCached) {
                if (!wrap.parentNode) return;
                var d = vComputeDiff(prevCached.ok ? prevCached.rows : [], cached.rows);
                d.oldLen = prevCached.ok ? prevCached.rows.length : 0;
                d.newLen = cached.rows.length;
                wrap.outerHTML = vDiffHtml(d, rec, prev);
                item.classList.add('open');
                _versionPreviewOpen = item.querySelector('.vdiff');
            });
        } else {
            var d = { lines: [], add: cached.rows.length, del: 0, oldLen: 0, newLen: cached.rows.length };
            cached.rows.forEach(function(r) {
                var line = vRowLine(r);
                if (line) d.lines.push({ type: 'add', text: line });
            });
            wrap.outerHTML = vDiffHtml(d, rec, null);
            item.classList.add('open');
            _versionPreviewOpen = item.querySelector('.vdiff');
        }
    }).catch(function(e) {
        if (wrap.parentNode) { wrap.textContent = 'Error loading preview'; console.error('[Versions] preview error v' + rec.v + ':', e); }
    });
}

function startVersionRename(item, rec) {
    var main = item.querySelector('.version-meta');
    if (!main) return;
    var oldRow = main.querySelector('.version-name-row');
    var row = document.createElement('div');
    row.className = 'version-name-row';
    var input = document.createElement('input');
    input.className = 'version-name-input';
    input.value = rec.name || '';
    input.placeholder = 'Version name';
    row.appendChild(input);
    if (oldRow) main.replaceChild(row, oldRow);
    else main.insertBefore(row, main.firstChild);
    input.focus();
    input.select();
    var done = false;
    function commit() {
        if (done) return;
        done = true;
        var val = input.value;
        versionApiName(state.currentFileId, rec.v, val).then(function() {
            __ss.showToast(val ? 'Version renamed' : 'Version name cleared');
            renderVersionList(_versionMeta, true);
        }).catch(function(e) {
            __ss.showToast('Rename failed');
            console.error('[Versions] rename error v' + rec.v + ':', e);
            renderVersionList(_versionMeta, true);
        });
    }
    function cancel() {
        if (done) return;
        done = true;
        renderVersionList(_versionMeta, true);
    }
    input.addEventListener('keydown', function(e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
}

async function forkVersion(rec) {
    var ok = await __ss.showConfirm('Copy this version into a new file?', 'Copy');
    if (!ok) return;
    try {
        var res = await versionApiFork(state.currentFileId, rec.v);
        var newId = (res && res.file && res.file.id) || (res && res.fileId) || (res && res.id);
        if (!newId) { __ss.showToast('Fork failed'); console.error('[Versions] fork failed:', res); return; }
        dom.versionOverlay.classList.remove('open');
        __ss.showToast('Forked to new file');
        if (state.isAdminFile) __ss.openFileAdmin(newId);
        else __ss.openFile(newId);
    } catch(e) {
        __ss.showToast('Fork failed');
        console.error('[Versions] fork error:', e);
    }
}

async function confirmVersionRestore(rec) {
    var ok = await __ss.showConfirm(
        'Restore version from ' + fmtVersionTime(rec.ts).split('  (')[0] + '? Current rows will be replaced.', 'Restore');
    if (!ok) return;
    try {
        var res = await versionApiRestore(state.currentFileId, rec.v);
        if (!res || !res.ok) { __ss.showToast('Restore failed'); console.error('[Versions] restore failed:', res); return; }
        state.undoStack.push({ type: 'rows', prevRows: state.rows.map(function(r) { return Object.assign({}, r); }) });
        state.redoStack = [];
        state.rows = res.rows;
        while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
        state.isDirty = true;
        renderSheet();
        findDuplicates();
        renderSheet();
        updateUndoRedo();
        dom.versionOverlay.classList.remove('open');
        __ss.showToast('Restored version v' + rec.v + ' (' + res.rows.length + ' rows)');
    } catch(e) {
        __ss.showToast('Restore failed');
        console.error('[Versions] restore error:', e);
    }
}

dom.menuVersions.addEventListener('click', function() {
    dom.sheetMoreMenu.classList.remove('open');
    if (!state.currentFileId) return;
    dom.versionOverlay.classList.add('open');
    dom.versionList.innerHTML = '<div class="version-empty">Loading…</div>';
    dom.versionEmpty.style.display = 'none';
    versionApiGetHistory(state.currentFileId).then(function(meta) {
        renderVersionList(meta);
    }).catch(function(e) {
        dom.versionList.innerHTML = '<div class="version-empty">Could not load history</div>';
        dom.versionEmpty.style.display = 'none';
        console.error('[Versions] history error:', e);
    });
});

if (dom.versionClose) dom.versionClose.addEventListener('click', function() {
    dom.versionOverlay.classList.remove('open');
});
dom.versionOverlay.addEventListener('click', function(e) {
    if (e.target === dom.versionOverlay) dom.versionOverlay.classList.remove('open');
});

// ── Keyboard ──
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && state.selectionMode) {
        exitSelectionMode();
    }
});

// ── Sheet title rename ──
dom.sheetTitleBtn.addEventListener('click', function() {
    if (state.currentFileId) __ss.promptRenameFile(state.currentFileId);
});

// ── Lightweight remote refresh (used by the floating mini window) ──
__ss.renderSheetLocal = function() {
    if (!state.currentFileId) return;
    renderSheet();
    findDuplicates();
    renderSheet();
};

__ss.refreshSheet = async function() {
    var id = state.currentFileId;
    if (!id) return;
    try {
        var rows = await api.getRows(id);
        if (id !== state.currentFileId) return;
        state.rows = rows || [];
        while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
        renderSheet();
        findDuplicates();
        renderSheet();
    } catch(e) {}
};

})();
