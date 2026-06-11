(function() {
var __ss = window.__ss;
var dom = __ss.dom;
var api = __ss.api;
var state = __ss.state;

// ── Open / Close ──
__ss.openFile = async function(id) {
    var files = await api.getFiles();
    var f = files.find(function(x) { return x.id === id; });
    if (!f) return;
    state.currentFileId = id;
    state.currentFileType = f.type || 'ig_cookie';
    state.COLUMNS = __ss.getTypeDef(state.currentFileType).columns;
    state.rows = await api.getRows(id);
    state.undoStack = await api.getStack(id, 'undo');
    state.redoStack = await api.getStack(id, 'redo');
    state.selectedCell = null;
    state.isDirty = false;

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

    try { history.pushState({fileId: id}, '', 'file/' + id); } catch(e) {}
    updateUndoRedo();
    renderSheet();
};

__ss.closeSheet = function() {
    if (state.selectionMode) exitSelectionMode();
    if (state.isDirty) persist();
    state.currentFileId = null;
    state.currentFileType = null;
    state.COLUMNS = [];
    state.rows = [];
    state.undoStack = [];
    state.redoStack = [];
    state.selectedCell = null;
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

    __ss.renderHome();
};

dom.backBtn.addEventListener('click', __ss.closeSheet);

// ── Persist ──
async function persist() {
    await api.saveRows(state.currentFileId, state.rows);
    await api.saveStack(state.currentFileId, 'undo', state.undoStack);
    await api.saveStack(state.currentFileId, 'redo', state.redoStack);
    var files = await api.getFiles();
    var f = files.find(function(x) { return x.id === state.currentFileId; });
    if (f) {
        f.rowCount = state.rows.length;
        await api.updateFile(state.currentFileId, { rowCount: state.rows.length });
    }
    state.isDirty = false;
}

// ── Undo / Redo ──
function pushUndo() {
    state.undoStack.push(__ss.cloneRows(state.rows));
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
        td.addEventListener('click', function(e) {
            cycleStatus(parseInt(td.dataset.row));
        });
    });

    dom.grid.querySelectorAll('td.dc').forEach(function(td) {
        __ss.attachTapHold(td, {
            onTap: function(el) {
                if (state.selectionMode) {
                    toggleSelection('cell', el.dataset.row, el.dataset.col);
                } else {
                    var rowIdx = parseInt(el.dataset.row);
                    var colKey = el.dataset.col;
                    var now = Date.now();
                    if (now - state.lastCellTap < 400) {
                        doubleTapPaste(rowIdx, colKey);
                    }
                    state.lastCellTap = now;
                    openQuickEdit(rowIdx, colKey);
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
            }
        });
    });

    var addCell = document.getElementById('addRowCell');
    if (addCell) addCell.addEventListener('click', addRow);

    updateUndoRedo();
}

// ── Row operations ──
function cycleStatus(idx) {
    pushUndo();
    var row = state.rows[idx];
    if (!row) return;
    var map = { '': 'good', good: 'bad', bad: 'pending', pending: '' };
    row.status = map[row.status] || 'good';
    state.isDirty = true;
    renderSheet();
    persist();
}

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

function doubleTapPaste(rowIdx, colKey) {
    navigator.clipboard.readText().then(function(text) {
        if (!text) return;
        var row = state.rows[rowIdx];
        if (!row) return;
        pushUndo();
        row[colKey] = text;
        state.isDirty = true;
        renderSheet();
        persist();
        __ss.showToast('Pasted');
    }).catch(function() {});
}

// ── Quick edit bar ──
function openQuickEdit(rowIdx, colKey) {
    var row = state.rows[rowIdx];
    if (!row) return;
    state.selectedCell = { rowIdx: rowIdx, colIdx: colKey };
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
    if (row[state.selectedCell.colIdx] !== val) {
        pushUndo();
        row[state.selectedCell.colIdx] = val;
        state.isDirty = true;
        renderSheet();
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
dom.qebPasteBtn.addEventListener('click', function() {
    navigator.clipboard.readText().then(function(t) { dom.qebInput.value = t; dom.qebInput.focus(); }).catch(function() { __ss.showToast('Cannot read clipboard'); });
});

// ── Selection mode ──
function enterSelectionMode(type, row, col) {
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
    if (!state.rows.length) { __ss.showToast('No data'); return; }
    var lines = [];
    lines.push(state.COLUMNS.map(function(c) { return c.label; }).join('\t'));
    state.rows.forEach(function(row) {
        lines.push(state.COLUMNS.map(function(c) { return row[c.key] || ''; }).join('\t'));
    });
    var text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function() {
        __ss.showToast('Copied all ' + state.rows.length + ' rows');
    }).catch(function() { __ss.showToast('Cannot copy'); });
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
