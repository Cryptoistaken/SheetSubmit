(function() {
var __ss = window.__ss = window.__ss || {};

// ── DOM refs ──
var dom = {};
var ids = [
    'homeView', 'sheetView', 'filesGrid', 'emptyState', 'grid',
    'sheetTitleBtn', 'backBtn', 'homeFab', 'qebBar', 'qebInput',
    'qebChip', 'qebSaveBtn', 'qebPasteBtn', 'undoBtn', 'redoBtn',
    'sheetBtns', 'toast', 'homeTopTitle', 'gearBtn',
    'fileCtxPopup', 'fileCtxRename', 'fileCtxDelete',
    'selBar', 'selCount', 'selDelete', 'selCopy',
    'selSelectAll', 'selUnselectAll', 'copyAllBtn',
    'renameOverlay', 'renameInput', 'renameCancel', 'renameConfirm',
    'typeOverlay', 'typeOptions', 'typeCancel',
    'connStatus', 'connStatusText',
    'fileSelBar', 'fileSelCount', 'fileSelDelete',
    'sheetMoreBtn', 'sheetMoreMenu', 'menuDownload', 'menuUpload',
    'uploadModeOverlay', 'uploadReplace', 'uploadAppend', 'uploadModeCancel',
    'xlsxFileInput', 'xlsxFileInputHome',
    'fileSelSelectAll', 'fileSelUnselectAll',
    'homePaneArchive', 'archiveGrid', 'archiveEmptyState',
    'archiveCtxPopup', 'archiveCtxRestore', 'archiveCtxDelete',
];
ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) dom[id] = el;
});
__ss.dom = dom;

// ── Shared state ──
__ss.state = {
    currentFileId: null,
    currentFileType: null,
    COLUMNS: [],
    rows: [],
    undoStack: [],
    redoStack: [],
    selectedCell: null,
    isDirty: false,
    lastCellTap: 0,
    selectionMode: false,
    selectedItems: new Set(),
    fileSelectionMode: false,
    selectedFiles: new Set(),
    fileCtxFileId: null,
    renameFileId: null,
    isTouch: 'ontouchstart' in window,
};

// ── Long-press helpers ──
var _lp = {timer: null, triggered: false};

function lpStart(cb) {
    _lp.triggered = false;
    _lp.timer = setTimeout(function() { _lp.triggered = true; cb(); }, 500);
}
function lpEnd() {
    clearTimeout(_lp.timer);
    var t = _lp.triggered;
    _lp.triggered = false;
    return t;
}
function lpCancel() {
    clearTimeout(_lp.timer);
    _lp.triggered = false;
}

// ── General helpers ──
__ss.genId = function() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
};

__ss.cloneRows = function(r) {
    return r.map(function(row) { return Object.assign({}, row); });
};

__ss.todayStr = function() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
};

var toastTimer = null;
__ss.showToast = function(msg) {
    clearTimeout(toastTimer);
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    toastTimer = setTimeout(function() { dom.toast.classList.remove('show'); }, 2000);
};

__ss.esc = function(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
};

__ss.makeEmptyRow = function(columns) {
    var nr = {};
    columns.forEach(function(col) { nr[col.key] = ''; });
    nr.status = '';
    return nr;
};

__ss.attachTapHold = function(el, opts) {
    function handleDown() {
        lpStart(function() {
            if (opts.onHold) opts.onHold(el);
        });
    }
    function handleUp() {
        var held = lpEnd();
        if (!held && opts.onTap) opts.onTap(el);
    }
    if (__ss.state.isTouch) {
        el.addEventListener('touchstart', handleDown, {passive: true});
        el.addEventListener('touchend', handleUp);
        el.addEventListener('touchmove', lpCancel);
    } else {
        el.addEventListener('mousedown', handleDown);
        el.addEventListener('mouseup', handleUp);
        el.addEventListener('mouseleave', lpCancel);
    }
};

// ── Cell highlight helpers ──
__ss.clearCellHighlight = function() {
    var prev = dom.grid.querySelector('.cell-editing');
    if (prev) prev.classList.remove('cell-editing');
};

__ss.highlightCell = function(td) {
    __ss.clearCellHighlight();
    if (td) td.classList.add('cell-editing');
};

})();
