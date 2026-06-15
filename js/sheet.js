(function() {
var __ss = window.__ss;
var dom = __ss.dom;
var api = __ss.api;
var state = __ss.state;

// ── Open / Close ──
__ss.openFile = async function(id) {
    state.isAdminFile = false;
    state.adminFileOwnerId = null;
    var results = await Promise.all([api.getFile(id), api.getRows(id), api.getLogs(id)]);
    var f = results[0];
    if (!f || !f.id) return;
    state.currentFileId = id;
    state.currentFileType = f.type || 'ig_cookie';
    state.COLUMNS = __ss.getTypeDef(state.currentFileType).columns;
    state.rows = results[1] || [];
    while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
    state.undoStack = [];
    state.redoStack = [];
    state.selectedCell = null;
    state.isDirty = false;
    state.syncRunning = false;
    state.apiLogs = results[2] || [];

    dom.homeView.style.display = 'none';
    dom.sheetView.classList.add('active');
    dom.homeFab.classList.add('hidden');
    dom.sheetBtns.style.display = 'flex';
    dom.backBtn.classList.add('visible');
    dom.sheetTitleBtn.textContent = f.name;
    dom.sheetTitleBtn.classList.add('visible');
    dom.homeTopTitle.style.display = 'none';
    dom.connStatus.style.display = 'none';

    if (dom.gearBtn) dom.gearBtn.style.display = 'none';
    var logo = document.querySelector('.topbar-logo');
    if (logo) logo.style.display = 'none';

    updateSyncState();
    try { history.pushState({fileId: id}, '', 'file/' + id); } catch(e) {}
    updateUndoRedo();
    renderSheet();
};

__ss.openFileAdmin = async function(id) {
    var results = await Promise.all([api.adminFile(id), api.adminFileRows(id), api.adminFileLogs(id)]);
    var f = results[0];
    if (!f || !f.id) return;
    state.currentFileId = id;
    state.currentFileType = f.type || 'ig_cookie';
    state.COLUMNS = __ss.getTypeDef(state.currentFileType).columns;
    state.rows = results[1] || [];
    while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
    state.undoStack = [];
    state.redoStack = [];
    state.selectedCell = null;
    state.isDirty = false;
    state.syncRunning = false;
    state.apiLogs = results[2] || [];

    dom.homeView.style.display = 'none';
    dom.sheetView.classList.add('active');
    dom.homeFab.classList.add('hidden');
    dom.sheetBtns.style.display = 'flex';
    dom.backBtn.classList.add('visible');
    dom.sheetTitleBtn.textContent = f.name;
    dom.sheetTitleBtn.classList.add('visible');
    dom.homeTopTitle.style.display = 'none';
    dom.connStatus.style.display = 'none';

    if (dom.gearBtn) dom.gearBtn.style.display = 'none';
    var logo = document.querySelector('.topbar-logo');
    if (logo) logo.style.display = 'none';

    updateSyncState();
    try { history.pushState({fileId: id}, '', 'file/' + id); } catch(e) {}
    updateUndoRedo();
    renderSheet();
};

__ss.closeSheet = function() {
    if (state.selectionMode) exitSelectionMode();
    if (state.isDirty) persist();
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
    var logo = document.querySelector('.topbar-logo');
    if (logo) logo.style.display = '';

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

async function persist() {
    var td = __ss.getTypeDef(state.currentFileType);
    var lastData = state.rows.length - 1;
    while (lastData >= 0 && !td.columns.some(function(c) { return state.rows[lastData][c.key]; })) lastData--;
    var keepCount = Math.min(state.rows.length, Math.max(lastData + 51, 100));
    var trimmed = state.rows.slice(0, keepCount);
    var dataCount = state.rows.filter(function(row) {
        return td.columns.some(function(c) { return row[c.key]; });
    }).length;
    var payload = {
        rows: trimmed,
        logs: state.apiLogs,
        undo: state.undoStack,
        redo: state.redoStack,
        dataCount: dataCount
    };
    if (state.isAdminFile) {
        payload.userId = state.adminFileOwnerId;
        await api.adminPersist(state.currentFileId, payload);
    } else {
        await api.persist(state.currentFileId, payload);
    }
    state.isDirty = false;
}

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
        renderSheet();
        try {
            var result = await behavior.syncRow(row, state);
            state.apiLogs.push(result);
            row.status = result.status === 'done' ? 'good' : 'bad';
            apiAppendLog(state.currentFileId, { log: result });
            apiUpdateCell(state.currentFileId, { rowIdx: i, colKey: 'status', value: row.status });
        } catch(e) {
            var errLog = { username: row.username, steps: [{ type: 'error', message: e.message, time: Date.now() }], status: 'failed' };
            state.apiLogs.push(errLog);
            row.status = 'bad';
            apiAppendLog(state.currentFileId, { log: errLog });
            apiUpdateCell(state.currentFileId, { rowIdx: i, colKey: 'status', value: 'bad' });
        }
        done++;
        renderSheet();
        __ss.showToast('Synced ' + done + '/' + total);
    }
    state.syncRunning = false;
    updateSyncState();
    __ss.showToast('Sync complete — ' + done + '/' + total);
}

if (dom.syncBtn) {
    dom.syncBtn.addEventListener('click', function() {
        if (state.syncRunning) return;
        runSync();
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
function showApiLogs(logs, username, el) {
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
    dom.logPopupBody.innerHTML = h || '<div style="padding:6px 0;color:var(--text3);font-size:12px">No logs for this row</div>';

    var rect = el.getBoundingClientRect();
    dom.logPopup.style.left = Math.max(4, rect.right - 340) + 'px';
    dom.logPopup.style.top = (rect.bottom + 4) + 'px';
    dom.logPopup.classList.add('open');
}

document.addEventListener('click', function(e) {
    if (dom.logPopup && !dom.logPopup.contains(e.target)) dom.logPopup.classList.remove('open');
});

// ── Undo / Redo ──
function pushUndo() {
    var current = __ss.cloneRows(state.rows);
    var last = state.undoStack[state.undoStack.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(current)) return;
    state.undoStack.push(current);
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
    state.redoStack.push(__ss.cloneRows(state.rows));
    state.rows = state.undoStack.pop();
    state.isDirty = true;
    updateUndoRedo();
    renderSheet();
    __ss.showToast('Undo');
});

dom.redoBtn.addEventListener('click', function() {
    if (!state.redoStack.length) return;
    state.undoStack.push(__ss.cloneRows(state.rows));
    state.rows = state.redoStack.pop();
    state.isDirty = true;
    updateUndoRedo();
    renderSheet();
    __ss.showToast('Redo');
});

// ── Render ──
function renderSheet() {
    var h = '<thead><tr><th class="corner"></th>';
    state.COLUMNS.forEach(function(col) {
        var isColSel = state.selectionMode && state.rows.length > 0 && state.rows.every(function(r, i) { return state.selectedItems.has(i + ':' + col.key); });
        h += '<th class="ch' + (isColSel ? ' col-sel' : '') + '" data-col="' + col.key + '">' + col.label + '</th>';
    });
    h += '<th class="ch-dot"></th>';
    h += '</tr></thead><tbody>';

    state.rows.forEach(function(row, i) {
        var isRowSel = state.selectionMode && state.COLUMNS.every(function(c) { return state.selectedItems.has(i + ':' + c.key); });
        h += '<tr class="' + (isRowSel ? 'row-selected' : '') + '"><th class="rh' + (isRowSel ? ' row-sel' : '') + '" data-row="' + i + '">' + (i + 1) + '</th>';
        state.COLUMNS.forEach(function(col) {
            var isSel = state.selectedItems.has(i + ':' + col.key);
            var val = row[col.key] || '';
            h += '<td class="dc' + (isSel ? ' ms-sel' : '') + '" data-row="' + i + '" data-col="' + col.key + '"><div class="cell-inner"><span class="cell-text">' + __ss.esc(val) + '</span></div></td>';
        });
        var status = row.status || '';
        var dotClass = status === 'good' ? 'd-green' : status === 'bad' ? 'd-red' : status === 'pending' ? 'd-yellow' : '';
        h += '<td class="dot-cell" data-row="' + i + '"><div style="display:flex;align-items:center;justify-content:center;gap:4px">';
        h += '<span class="row-dot ' + dotClass + '"></span>';
        h += '</div></td>';
        h += '</tr>';
    });

    h += '<tr class="add-row"><td class="rh-add" colspan="' + (1 + state.COLUMNS.length + 1) + '" id="addRowCell">+ Add row</td></tr>';
    h += '</tbody>';
    dom.grid.innerHTML = h;

    dom.grid.querySelectorAll('.dot-cell').forEach(function(td) {
        __ss.attachTapHold(td, {
            onTap: function(el) {
                var behavior = __ss.getFileBehavior(state.currentFileType);
                if (behavior && behavior.onDotDoubleTap) {
                    var row = state.rows[parseInt(el.dataset.row)];
                    behavior.onDotDoubleTap(row).then(function(result) {
                        if (result && result.action === 'totp_copied') {
                            __ss.showToast('TOTP ' + result.code + ' copied');
                        }
                    });
                }
            },
            onHold: function(el) {
                var behavior = __ss.getFileBehavior(state.currentFileType);
                if (behavior && behavior.onDotHold) {
                    var row = state.rows[parseInt(el.dataset.row)];
                    var result = behavior.onDotHold(row, state.apiLogs);
                    if (result && result.action === 'show_logs') {
                        showApiLogs(result.logs, row.username, el);
                    }
                }
            }
        });
    });

    dom.grid.querySelectorAll('td.dc').forEach(function(td) {
        __ss.attachTapHold(td, {
            onTap: function(el) {
                if (state.selectionMode) {
                    toggleSelection('cell', el.dataset.row, el.dataset.col);
                } else {
                    openQuickEdit(parseInt(el.dataset.row), el.dataset.col);
                }
            },
            onDoubleTap: function(el) {
                if (!state.selectionMode) {
                    doubleTapAction(parseInt(el.dataset.row), el.dataset.col);
                }
            },
            onHold: function(el) {
                if (!state.selectionMode) {
                    enterSelectionMode('cell', el.dataset.row, el.dataset.col);
                }
            }
        });
    });

    dom.grid.querySelectorAll('th.ch').forEach(function(th) {
        if (th.classList.contains('corner') || th.classList.contains('ch-dot')) return;
        __ss.attachTapHold(th, {
            onTap: function(el) {
                if (state.selectionMode) {
                    toggleSelection('col', null, el.dataset.col);
                }
            },
            onHold: function(el) {
                if (!state.selectionMode) {
                    enterSelectionMode('col', null, el.dataset.col);
                }
            },
            onTripleTap: function(el) {
                var colKey = el.dataset.col;
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
                        pushUndo();
                        parts.forEach(function(val, i) {
                            if (state.rows[i]) state.rows[i][colKey] = val;
                        });
                        state.isDirty = true;
                        renderSheet();
                        parts.forEach(function(val, i) {
                            if (state.rows[i]) apiUpdateCell(state.currentFileId, { rowIdx: i, colKey: colKey, value: val });
                        });
                        __ss.vibrate();
                        __ss.showToast('Pasted ' + parts.length + ' cells');
                    }).catch(function() {});
                }
            }
        });
    });

    dom.grid.querySelectorAll('th.rh').forEach(function(th) {
        __ss.attachTapHold(th, {
            onTap: function(el) {
                if (state.selectionMode) {
                    toggleSelection('row', el.dataset.row, null);
                }
            },
            onHold: function(el) {
                if (!state.selectionMode) {
                    enterSelectionMode('row', el.dataset.row, null);
                }
            },
            onTripleTap: function(el) {
                var rowIdx = parseInt(el.dataset.row);
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
                        pushUndo();
                        vals.forEach(function(v, i) {
                            if (parts[i] !== undefined) row[v.key] = parts[i];
                        });
                        state.isDirty = true;
                        renderSheet();
                        vals.forEach(function(v, i) {
                            if (parts[i] !== undefined) apiUpdateCell(state.currentFileId, { rowIdx: rowIdx, colKey: v.key, value: parts[i] });
                        });
                        __ss.vibrate();
                        __ss.showToast('Row pasted');
                    }).catch(function() {});
                }
            }
        });
    });

    var addCell = document.getElementById('addRowCell');
    if (addCell) addCell.addEventListener('click', addRow);

    updateUndoRedo();
}

// ── Row operations ──

function addRow() {
    pushUndo();
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
            pushUndo();
            row[colKey] = text;
            state.isDirty = true;
            renderSheet();
            apiUpdateCell(state.currentFileId, { rowIdx: rowIdx, colKey: colKey, value: text });
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
    dom.qebInput.focus();
    dom.qebInput.select();
    var td = dom.grid.querySelector('td.dc[data-row="' + rowIdx + '"][data-col="' + colKey + '"]');
    __ss.highlightCell(td);
}

function commitQuickEdit() {
    if (!state.selectedCell) return;
    var row = state.rows[state.selectedCell.rowIdx];
    if (!row) return;
    var val = dom.qebInput.value;
    if (val !== state.selectedCell.originalVal) {
        pushUndo();
        row[state.selectedCell.colIdx] = val;
        state.isDirty = true;
        updateUndoRedo();
        apiUpdateCell(state.currentFileId, { rowIdx: state.selectedCell.rowIdx, colKey: state.selectedCell.colIdx, value: val });
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
    if (!state.selectedCell) return;
    var row = state.rows[state.selectedCell.rowIdx];
    if (!row) return;
    row[state.selectedCell.colIdx] = dom.qebInput.value;
    state.isDirty = true;
    var td = dom.grid.querySelector('td.dc[data-row="' + state.selectedCell.rowIdx + '"][data-col="' + state.selectedCell.colIdx + '"]');
    if (td) {
        var text = td.querySelector('.cell-text');
        if (text) text.textContent = dom.qebInput.value;
    }
});
dom.qebPasteBtn.addEventListener('click', function() {
    navigator.clipboard.readText().then(function(t) {
        dom.qebInput.value = t;
        dom.qebInput.focus();
        if (state.selectedCell) {
            var row = state.rows[state.selectedCell.rowIdx];
            if (row) {
                row[state.selectedCell.colIdx] = t;
                state.isDirty = true;
                var td = dom.grid.querySelector('td.dc[data-row="' + state.selectedCell.rowIdx + '"][data-col="' + state.selectedCell.colIdx + '"]');
                if (td) {
                    var text = td.querySelector('.cell-text');
                    if (text) text.textContent = t;
                }
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
            pushUndo();
            row[state.selectedCell.colIdx] = '';
            state.isDirty = true;
            var td = dom.grid.querySelector('td.dc[data-row="' + state.selectedCell.rowIdx + '"][data-col="' + state.selectedCell.colIdx + '"]');
            if (td) {
                var text = td.querySelector('.cell-text');
                if (text) text.textContent = '';
            }
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
    renderSheet();
}

function exitSelectionMode() {
    state.selectionMode = false;
    state.selectedItems.clear();
    dom.selBar.classList.remove('open');
    renderSheet();
}

function toggleSelection(type, row, col) {
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
    renderSheet();
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
    pushUndo();
    state.selectedItems.forEach(function(key) {
        var parts = key.split(':');
        var rowIdx = parseInt(parts[0]);
        var colKey = parts[1];
        if (state.rows[rowIdx]) state.rows[rowIdx][colKey] = '';
    });
    state.isDirty = true;
    exitSelectionMode();
    renderSheet();
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
    var sortedRows = Object.keys(byRow).sort(function(a, b) { return a - b; });
    var lines = [];
    sortedRows.forEach(function(ri) {
        var cells = byRow[ri];
        cells.sort(function(a, b) { return colOrder.indexOf(a.col) - colOrder.indexOf(b.col); });
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
    state.selectedItems.clear();
    state.rows.forEach(function(row, i) {
        state.COLUMNS.forEach(function(col) {
            state.selectedItems.add(i + ':' + col.key);
        });
    });
    updateSelBar();
    renderSheet();
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
    var hasData = state.rows.some(function(row) {
        return state.COLUMNS.some(function(c) { return row[c.key]; });
    });
    if (!hasData) { __ss.showToast('No data'); return; }
    var lines = [];
    lines.push(state.COLUMNS.map(function(c) { return c.label; }).join('\t'));
    state.rows.forEach(function(row) {
        var isEmpty = state.COLUMNS.every(function(c) { return !row[c.key]; });
        if (!isEmpty) {
            lines.push(state.COLUMNS.map(function(c) { return row[c.key] || ''; }).join('\t'));
        }
    });
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
dom.menuDownload.addEventListener('click', function() {
    dom.sheetMoreMenu.classList.remove('open');
    var hasData = state.rows.some(function(row) {
        return state.COLUMNS.some(function(c) { return row[c.key]; });
    });
    if (!hasData) { __ss.showToast('No data to download'); return; }
    var data = [state.COLUMNS.map(function(c) { return c.label; })];
    state.rows.forEach(function(row) {
        var isEmpty = state.COLUMNS.every(function(c) { return !row[c.key]; });
        if (!isEmpty) data.push(state.COLUMNS.map(function(c) { return row[c.key] || ''; }));
    });
    var ws = XLSX.utils.aoa_to_sheet(data);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    var name = dom.sheetTitleBtn.textContent || 'export';
    XLSX.writeFile(wb, name + '.xlsx');
    __ss.showToast('Downloaded');
});

// ── Upload xlsx (inside file) ──
var pendingUploadData = null;

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
        if (json.length < 2) { __ss.showToast('File is empty'); return; }
        var headers = json[0].map(function(h) { return String(h).toLowerCase().trim(); });
        var matchedCols = state.COLUMNS.filter(function(c) {
            return headers.indexOf(c.key.toLowerCase()) !== -1 || headers.indexOf(c.label.toLowerCase()) !== -1;
        });
        if (matchedCols.length === 0) { __ss.showToast('Columns don\'t match this file type'); return; }
        var colMap = matchedCols.map(function(c) {
            var idx = headers.indexOf(c.key.toLowerCase());
            if (idx === -1) idx = headers.indexOf(c.label.toLowerCase());
            return { key: c.key, idx: idx };
        });
        var rows = [];
        for (var i = 1; i < json.length; i++) {
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
        pendingUploadData = rows;
        dom.uploadModeOverlay.classList.add('open');
    };
    reader.readAsArrayBuffer(file);
});

dom.uploadReplace.addEventListener('click', function() {
    if (!pendingUploadData) return;
    dom.uploadModeOverlay.classList.remove('open');
    state.rows = pendingUploadData;
    while (state.rows.length < 100) state.rows.push(__ss.makeEmptyRow(state.COLUMNS));
    state.isDirty = true;
    renderSheet();
    persist();
    __ss.showToast('Replaced with ' + pendingUploadData.length + ' rows');
    pendingUploadData = null;
});

dom.uploadAppend.addEventListener('click', function() {
    if (!pendingUploadData) return;
    dom.uploadModeOverlay.classList.remove('open');
    state.rows = state.rows.concat(pendingUploadData);
    state.isDirty = true;
    renderSheet();
    persist();
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

})();
