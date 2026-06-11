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

        var metaHtml = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px">' +
            '<span class="file-type-badge ' + td.badgeClass + '">' + __ss.esc(td.badge) + '</span>' +
            '<span class="file-card-meta" id="meta-' + f.id + '">...</span></div>';

        card.innerHTML =
            '<div class="file-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg></div>' +
            '<div class="file-card-name">' + __ss.esc(f.name) + '</div>' +
            metaHtml +
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
        card.querySelector('.file-card-dots').addEventListener('mousedown', function(e) {
            e.stopPropagation();
        });
        card.querySelector('.file-card-dots').addEventListener('mouseup', function(e) {
            e.stopPropagation();
        });
        card.querySelector('.file-card-dots').addEventListener('touchstart', function(e) {
            e.stopPropagation();
        }, {passive: true});
        card.querySelector('.file-card-dots').addEventListener('touchend', function(e) {
            e.stopPropagation();
        });

        dom.filesGrid.appendChild(card);

        api.getRows(f.id).then(function(rows) {
            var meta = document.getElementById('meta-' + f.id);
            if (!meta) return;
            var count = 0;
            if (rows) {
                count = rows.filter(function(row) {
                    return td.columns.some(function(c) { return row[c.key]; });
                }).length;
            }
            meta.textContent = count + ' row' + (count !== 1 ? 's' : '');
        });
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

    var uploadOpt = document.createElement('div');
    uploadOpt.className = 'type-option';
    uploadOpt.innerHTML =
        '<div class="type-option-icon" style="background:var(--bg3);color:var(--text2)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>' +
        '<div class="type-option-info">' +
        '<div class="type-option-name">Upload xlsx</div>' +
        '<div class="type-option-desc">Import data from a spreadsheet</div></div>';
    uploadOpt.addEventListener('click', function() {
        dom.typeOverlay.classList.remove('open');
        dom.xlsxFileInputHome.click();
    });
    dom.typeOptions.appendChild(uploadOpt);

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
    var name = td.label + ' ' + __ss.todayStr();
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

// ── Home xlsx upload ──
dom.xlsxFileInputHome.addEventListener('change', function(e) {
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
        var td = __ss.FILE_TYPES['ig_cookie'];
        var matchedCols = td.columns.filter(function(c) {
            return headers.indexOf(c.key.toLowerCase()) !== -1 || headers.indexOf(c.label.toLowerCase()) !== -1;
        });
        if (matchedCols.length === 0) { __ss.showToast('Columns don\'t match any file type'); return; }
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
        var name = file.name.replace(/\.xlsx?$/i, '') || 'Import ' + __ss.todayStr();
        api.getFiles().then(function(files) {
            if (files.some(function(f) { return f.name === name; })) {
                name = name + ' (' + __ss.genId().slice(0, 4) + ')';
            }
            var id = __ss.genId();
            api.createFile({ id: id, name: name, type: 'ig_cookie', rowCount: rows.length, createdAt: Date.now(), updatedAt: Date.now() }).then(function() {
                api.saveRows(id, rows).then(function() {
                    __ss.renderHome();
                    __ss.showToast('Imported ' + rows.length + ' rows');
                    __ss.openFile(id);
                });
            });
        });
    };
    reader.readAsArrayBuffer(file);
});

})();
