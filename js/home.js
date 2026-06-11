(function() {
var __ss = window.__ss;
var dom = __ss.dom;
var api = __ss.api;
var state = __ss.state;

// ── Home render ──
__ss.renderHome = async function() {
    var files = await api.getFiles();
    dom.filesGrid.innerHTML = '';
    if (files.length === 0) {
        dom.emptyState.style.display = 'flex';
        return;
    }
    dom.emptyState.style.display = 'none';
    files.forEach(function(f) {
        var td = __ss.getTypeDef(f.type);
        var card = document.createElement('div');
        card.className = 'file-card';
        card.dataset.id = f.id;
        if (state.selectedFiles.has(f.id)) card.classList.add('selected');
        card.innerHTML =
            '<div class="file-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg></div>' +
            '<div class="file-card-name">' + __ss.esc(f.name) + '</div>' +
            '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px">' +
            '<span class="file-type-badge ' + td.badgeClass + '">' + __ss.esc(td.badge) + '</span>' +
            '<span class="file-card-meta">' + (f.rowCount || 0) + ' rows</span></div>' +
            '<button class="file-card-dots" data-id="' + f.id + '">&hellip;</button>';

        __ss.attachTapHold(card, {
            onTap: function(el) {
                if (state.fileSelectionMode) {
                    toggleFileSelection(f.id);
                } else {
                    __ss.openFile(f.id);
                }
            },
            onHold: function(el) {
                if (!state.fileSelectionMode) {
                    enterFileSelectionMode(f.id);
                } else {
                    toggleFileSelection(f.id);
                }
            }
        });

        card.querySelector('.file-card-dots').addEventListener('click', function(e) {
            e.stopPropagation();
            if (!state.fileSelectionMode) showFileCtx(e, f.id);
        });

        dom.filesGrid.appendChild(card);
    });
};

// ── File multi-select ──
function enterFileSelectionMode(fileId) {
    state.fileSelectionMode = true;
    state.selectedFiles.clear();
    state.selectedFiles.add(fileId);
    updateFileSelBar();
    __ss.renderHome();
}

function exitFileSelectionMode() {
    state.fileSelectionMode = false;
    state.selectedFiles.clear();
    if (dom.fileSelBar) dom.fileSelBar.classList.remove('open');
    __ss.renderHome();
}

function toggleFileSelection(fileId) {
    if (state.selectedFiles.has(fileId)) {
        state.selectedFiles.delete(fileId);
    } else {
        state.selectedFiles.add(fileId);
    }
    if (state.selectedFiles.size === 0) {
        exitFileSelectionMode();
        return;
    }
    updateFileSelBar();
    __ss.renderHome();
}

function updateFileSelBar() {
    if (!dom.fileSelBar) return;
    var count = state.selectedFiles.size;
    dom.fileSelCount.textContent = count + ' selected';
    dom.fileSelBar.classList.add('open');
}

function deleteSelectedFiles() {
    if (!state.fileSelectionMode) return;
    var ids = Array.from(state.selectedFiles);
    Promise.all(ids.map(function(id) { return api.deleteFile(id); })).then(function() {
        exitFileSelectionMode();
        __ss.renderHome();
        __ss.showToast(ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' deleted');
    });
}

// ── File selection bar events ──
if (dom.fileSelDelete) {
    dom.fileSelDelete.addEventListener('click', deleteSelectedFiles);
}

function showFileCtx(e, fileId) {
    state.fileCtxFileId = fileId;
    var rect = e.target.getBoundingClientRect();
    var left = rect.left;
    var popupW = 140;
    if (left + popupW > window.innerWidth - 8) {
        left = window.innerWidth - popupW - 8;
    }
    dom.fileCtxPopup.style.left = left + 'px';
    dom.fileCtxPopup.style.top = (rect.bottom + 4) + 'px';
    dom.fileCtxPopup.classList.add('open');
}

function hideFileCtx() {
    dom.fileCtxPopup.classList.remove('open');
    state.fileCtxFileId = null;
}

__ss.deleteFile = async function(id) {
    await api.deleteFile(id);
    __ss.renderHome();
    __ss.showToast('File deleted');
};

__ss.promptRenameFile = function(id) {
    api.getFiles().then(function(files) {
        var f = files.find(function(x) { return x.id === id; });
        if (!f) return;
        state.renameFileId = id;
        dom.renameInput.value = f.name;
        dom.renameOverlay.classList.add('open');
        setTimeout(function() { dom.renameInput.focus(); dom.renameInput.select(); }, 100);
    });
};

__ss.commitRename = async function() {
    var name = dom.renameInput.value.trim();
    if (!name) { __ss.showToast('Name cannot be empty'); return; }
    var files = await api.getFiles();
    var f = files.find(function(x) { return x.id === state.renameFileId; });
    if (!f) return;
    await api.updateFile(state.renameFileId, { name: name });
    dom.renameOverlay.classList.remove('open');
    state.renameFileId = null;
    if (state.currentFileId === f.id) {
        dom.sheetTitleBtn.textContent = name;
    }
    __ss.renderHome();
    __ss.showToast('Renamed');
};

// ── File type modal ──
__ss.showTypeModal = function() {
    dom.typeOptions.innerHTML = '';
    __ss.FILE_TYPE_KEYS.forEach(function(k) {
        var td = __ss.FILE_TYPES[k];
        var opt = document.createElement('div');
        opt.className = 'type-option';
        opt.innerHTML =
            '<div class="type-option-icon ' + td.badgeClass + '">' + __ss.esc(td.icon) + '</div>' +
            '<div class="type-option-info">' +
            '<div class="type-option-name">' + __ss.esc(td.label) + '</div>' +
            '<div class="type-option-desc">' + __ss.esc(td.desc) + '</div></div>';
        opt.addEventListener('click', function() {
            dom.typeOverlay.classList.remove('open');
            __ss.createFile(k);
        });
        dom.typeOptions.appendChild(opt);
    });
    dom.typeOverlay.classList.add('open');
};

__ss.createFile = async function(typeKey) {
    if (navigator.clipboard && navigator.clipboard.read) {
        navigator.clipboard.readText().then(function() {}).catch(function() {});
    }

    var td = __ss.getTypeDef(typeKey);
    var name = __ss.todayStr();
    var files = await api.getFiles();
    if (files.some(function(f) { return f.name === name; })) {
        var suffix = 2;
        while (files.some(function(f) { return f.name === name + ' (' + suffix + ')'; })) { suffix++; }
        name = name + ' (' + suffix + ')';
    }
    var id = __ss.genId();
    await api.createFile({ id: id, name: name, type: typeKey, rowCount: 100, createdAt: Date.now(), updatedAt: Date.now() });

    state.COLUMNS = td.columns;
    var emptyRows = [];
    for (var i = 0; i < 100; i++) {
        emptyRows.push(__ss.makeEmptyRow(state.COLUMNS));
    }
    await api.saveRows(id, emptyRows);

    __ss.renderHome();
    __ss.showToast(td.label + ' file created');
    __ss.openFile(id);
};

// ── Context menu events ──
dom.fileCtxRename.addEventListener('click', function() {
    var id = state.fileCtxFileId;
    hideFileCtx();
    if (id) __ss.promptRenameFile(id);
});

dom.fileCtxDelete.addEventListener('click', function() {
    var id = state.fileCtxFileId;
    hideFileCtx();
    if (id) __ss.deleteFile(id);
});

document.addEventListener('click', function(e) {
    if (!dom.fileCtxPopup.contains(e.target)) {
        hideFileCtx();
    }
});

// ── Rename modal events ──
dom.renameCancel.addEventListener('click', function() {
    dom.renameOverlay.classList.remove('open');
    state.renameFileId = null;
});

dom.renameConfirm.addEventListener('click', __ss.commitRename);

dom.renameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); __ss.commitRename(); }
    if (e.key === 'Escape') { dom.renameOverlay.classList.remove('open'); state.renameFileId = null; }
});

dom.renameOverlay.addEventListener('click', function(e) {
    if (e.target === dom.renameOverlay) {
        dom.renameOverlay.classList.remove('open');
        state.renameFileId = null;
    }
});

// ── Type modal events ──
dom.typeCancel.addEventListener('click', function() {
    dom.typeOverlay.classList.remove('open');
});

dom.typeOverlay.addEventListener('click', function(e) {
    if (e.target === dom.typeOverlay) {
        dom.typeOverlay.classList.remove('open');
    }
});

// ── Exit file selection on Escape ──
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && state.fileSelectionMode) {
        exitFileSelectionMode();
    }
});

})();
