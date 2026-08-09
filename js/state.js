(function() {
var __ss = window.__ss = window.__ss || {};

// ── DOM refs ──
var dom = {};
var ids = [
    'homeView', 'sheetView', 'filesGrid', 'emptyState', 'grid',
    'sheetTitleBtn', 'backBtn', 'homeFab', 'qebBar', 'qebInput',
    'qebChip', 'qebSaveBtn', 'qebPasteBtn', 'qebClearBtn', 'undoBtn', 'redoBtn',
    'sheetBtns', 'toast', 'homeTopTitle', 'gearBtn',
    'fileCtxPopup', 'fileCtxRename', 'fileCtxDelete',
    'selBar', 'selCount', 'selDelete', 'selCopy',
    'selSelectAll', 'selUnselectAll', 'copyAllBtn',
    'renameOverlay', 'renameInput', 'renameCancel', 'renameConfirm',
    'homeFabMenu',
    'connStatus', 'connStatusText',
    'homeTabs', 'homePaneFiles',
    'fileSelBar', 'fileSelCount', 'fileSelDelete',
    'sheetMoreBtn', 'sheetMoreMenu', 'menuDownload', 'menuUpload',
    'menuMerge', 'menuVersions',
    'uploadModeOverlay', 'uploadReplace', 'uploadAppend', 'uploadModeCancel',
    'xlsxFileInput', 'xlsxFileInputHome',
    'syncBtnGroup', 'syncBtn', 'syncArrowBtn', 'syncDropdown', 'autoSyncToggle', 'checkBtnGroup', 'checkBtn', 'checkArrowBtn', 'checkDropdown', 'autoCheckToggle', 'waCheckSection', 'waCheckToggle', 'sheetMoreCols',
    'fileSelSelectAll', 'fileSelUnselectAll',
    'confirmOverlay', 'confirmMessage', 'confirmCancel', 'confirmOk',
    'versionOverlay', 'versionList', 'versionEmpty', 'versionClose',
    'logPopup', 'logPopupTitle', 'logPopupBody',
    'homePaneArchive', 'archiveGrid', 'archiveEmptyState',
    'archiveCtxPopup', 'archiveCtxRestore', 'archiveCtxDelete',
    'archiveSelBar', 'archiveSelCount',
    'archiveSelSelectAll', 'archiveSelUnselectAll',
    'archiveSelRestore', 'archiveSelDelete',
    'homePaneAdmin', 'adminStats', 'adminTotalUsers', 'adminTotalFiles',
    'adminUserSearch', 'adminUserList', 'adminUserDetail',
    'adminUserHeader', 'adminFileList', 'adminBackBtn', 'adminTabBtn',
];
ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) dom[id] = el;
});
__ss.dom = dom;

// ── Shared state ──
__ss.state = {
    filesCache: null,
    currentFileId: null,
    currentFileType: null,
    COLUMNS: [],
    rows: [],
    undoStack: [],
    redoStack: [],
    selectedCell: null,
    isDirty: false,
    selectionMode: false,
    selectedItems: new Set(),
    fileSelectionMode: false,
    selectedFiles: new Set(),
    archiveSelectionMode: false,
    selectedArchiveFiles: new Set(),
    fileCtxFileId: null,
    renameFileId: null,
    checkRunning: false,
    visibleColumns: null,
    isTouch: 'ontouchstart' in window,
    isAdminFile: false,
    adminFileOwnerId: null,
    dupCells: new Set(),
    dupRows: new Set(),
    hasDuplicates: false,
    invalidCells: new Set(),
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

// ── Vibration helper ──
__ss.vibrate = function(pattern) {
    if (navigator.vibrate) {
        navigator.vibrate(pattern || 10);
    }
};

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

var _escDiv = null;
__ss.esc = function(s) {
    if (!_escDiv) _escDiv = document.createElement('div');
    _escDiv.textContent = s;
    return _escDiv.innerHTML;
};

__ss.makeEmptyRow = function(columns) {
    var nr = {};
    columns.forEach(function(col) { nr[col.key] = ''; });
    nr.status = '';
    return nr;
};

__ss.attachTapHold = function(el, opts) {
    var taps = [];
    var tapTimer = null;
    function handleDown() {
        lpStart(function() {
            if (opts.onHold) opts.onHold(el);
        });
    }
    function handleUp() {
        var held = lpEnd();
        if (held) return;
        taps.push(Date.now());
        if (taps.length > 3) taps.shift();
        clearTimeout(tapTimer);
        var gap = taps.length > 1 ? taps[taps.length - 1] - taps[taps.length - 2] : Infinity;
        if (gap > 400) { taps = [taps[taps.length - 1]]; }
        if (taps.length === 3) {
            var t = taps;
            taps = [];
            if (opts.onTripleTap) opts.onTripleTap(el);
            return;
        }
        if (taps.length === 2) {
            tapTimer = setTimeout(function() {
                if (taps.length === 2) { taps = []; if (opts.onDoubleTap) opts.onDoubleTap(el); }
            }, 400);
            return;
        }
        tapTimer = setTimeout(function() {
            if (taps.length === 1) { taps = []; if (opts.onTap) opts.onTap(el); }
        }, 400);
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
var _highlightedCell = null;

__ss.clearCellHighlight = function() {
    if (_highlightedCell) {
        _highlightedCell.classList.remove('cell-editing');
        _highlightedCell = null;
    }
};

__ss.highlightCell = function(td) {
    __ss.clearCellHighlight();
    if (td) {
        td.classList.add('cell-editing');
        _highlightedCell = td;
    }
};

})();
