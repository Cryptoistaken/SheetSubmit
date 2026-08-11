(function() {
var __ss = window.__ss;
var dom = __ss.dom;
var api = __ss.api;
var state = __ss.state;

// ── Cache ──
var cachedFiles = null;

// ── Home render ──
__ss.renderHome = async function(useCache) {
    var files;
    if (useCache && cachedFiles) {
        files = cachedFiles;
    } else {
        files = await api.getFiles();
        cachedFiles = files;
    }
    state.filesCache = files;
    dom.filesGrid.innerHTML = '';
    if (files.length === 0) {
        dom.emptyState.style.display = 'flex';
        return;
    }
    dom.emptyState.style.display = 'none';

    var crossDupCounts = state.crossDupCounts;
    if (!crossDupCounts) {
        try {
            var cd = await api.getCrossDups();
            crossDupCounts = cd.counts;
            state.crossDupCounts = crossDupCounts;
        } catch(e) {}
    }

    var fragment = document.createDocumentFragment();
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
            '<div class="file-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg></div>' +
            '<div class="file-card-name">' + __ss.esc(f.name) + '</div>' +
            metaHtml +
            '<div class="file-card-actions">' +
            '<button class="file-card-btn file-card-dl" data-id="' + f.id + '" title="Download"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>' +
            '<button class="file-card-btn file-card-rename" data-id="' + f.id + '" title="Rename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>' +
            '<button class="file-card-btn file-card-del" data-id="' + f.id + '" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
            '</div>';

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

        card.querySelector('.file-card-dl').addEventListener('click', function(e) {
            e.stopPropagation();
            downloadFile(f.id, f.name);
        });
        ['mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function(evt) {
            card.querySelector('.file-card-dl').addEventListener(evt, function(e) { e.stopPropagation(); });
        });

        card.querySelector('.file-card-rename').addEventListener('click', function(e) {
            e.stopPropagation();
            __ss.promptRenameFile(f.id);
        });
        ['mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function(evt) {
            card.querySelector('.file-card-rename').addEventListener(evt, function(e) { e.stopPropagation(); });
        });

        card.querySelector('.file-card-del').addEventListener('click', function(e) {
            e.stopPropagation();
            __ss.deleteFile(f.id);
        });
        ['mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function(evt) {
            card.querySelector('.file-card-del').addEventListener(evt, function(e) { e.stopPropagation(); });
        });

        fragment.appendChild(card);

        var meta = card.querySelector('.file-card-meta');
        if (meta) {
            var count = f.dataCount || 0;
            var parts = [count + ' row' + (count !== 1 ? 's' : '')];
            var cd = crossDupCounts && crossDupCounts[f.id];
            if (cd) parts.push('<span class="cd-badge">' + cd + ' dup</span>');
            meta.innerHTML = parts.join(' &middot; ');
        }
    });
    dom.filesGrid.appendChild(fragment);
};

function resetCrossDupCounts() {
    state.crossDupCounts = null;
}

function downloadFile(id, name) {
    Promise.all([api.getRows(id), api.getFile(id)]).then(function(results) {
        var rows = results[0];
        var f = results[1];
        if (!rows || !rows.length) { __ss.showToast('No data'); return; }
        var td = __ss.getTypeDef(f && f.id ? f.type : 'ig_cookie');
            var data = [];
            rows.forEach(function(row) {
                var isEmpty = td.columns.every(function(c) { return !row[c.key]; });
                if (!isEmpty) data.push(td.columns.map(function(c) { return row[c.key] || ''; }));
            });
            if (!data.length) { __ss.showToast('No data'); return; }
            var ws = XLSX.utils.aoa_to_sheet(data);
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
            XLSX.writeFile(wb, (name || 'export') + '.xlsx');
            __ss.showToast('Downloaded');
        });
}

// ── File multi-select ──
function enterFileSelectionMode(fileId) {
    state.fileSelectionMode = true;
    state.selectedFiles.clear();
    state.selectedFiles.add(fileId);
    updateFileSelBar();
    dom.filesGrid.classList.add('sel-mode');
    dom.filesGrid.querySelectorAll('.file-card').forEach(function(c) { c.classList.toggle('selected', c.dataset.id === fileId); });
}

function exitFileSelectionMode() {
    state.fileSelectionMode = false;
    state.selectedFiles.clear();
    if (dom.fileSelBar) dom.fileSelBar.classList.remove('open');
    dom.filesGrid.classList.remove('sel-mode');
    dom.filesGrid.querySelectorAll('.file-card.selected').forEach(function(c) { c.classList.remove('selected'); });
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
    var cards = dom.filesGrid.querySelectorAll('.file-card');
    cards.forEach(function(c) { c.classList.toggle('selected', state.selectedFiles.has(c.dataset.id)); });
}

function updateFileSelBar() {
    if (!dom.fileSelBar) return;
    var count = state.selectedFiles.size;
    dom.fileSelCount.textContent = count + ' selected';
    dom.fileSelBar.classList.add('open');
}

function selectAllFiles() {
    var files = cachedFiles || state.filesCache;
    if (!files) {
        api.getFiles().then(function(f) {
            cachedFiles = f;
            state.filesCache = f;
            f.forEach(function(f2) { state.selectedFiles.add(f2.id); });
            updateFileSelBar();
            dom.filesGrid.querySelectorAll('.file-card').forEach(function(c) { c.classList.add('selected'); });
        });
        return;
    }
    files.forEach(function(f) { state.selectedFiles.add(f.id); });
    updateFileSelBar();
    dom.filesGrid.querySelectorAll('.file-card').forEach(function(c) { c.classList.add('selected'); });
}

function unselectAllFiles() {
    state.selectedFiles.clear();
    exitFileSelectionMode();
}

async function deleteSelectedFiles() {
    if (!state.fileSelectionMode) return;
    var ids = Array.from(state.selectedFiles);
    var ok = await __ss.showConfirm('Move ' + ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' to archive?', 'Archive');
    if (!ok) return;
    await Promise.all(ids.map(function(id) { return api.deleteFile(id); }));
    resetCrossDupCounts();
    exitFileSelectionMode();
    __ss.renderHome();
    __ss.showToast(ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' archived');
}

if (dom.fileSelDelete) dom.fileSelDelete.addEventListener('click', deleteSelectedFiles);
if (dom.fileSelSelectAll) dom.fileSelSelectAll.addEventListener('click', selectAllFiles);
if (dom.fileSelUnselectAll) dom.fileSelUnselectAll.addEventListener('click', unselectAllFiles);

__ss.showConfirm = function(message, okText) {
    return new Promise(function(resolve) {
        dom.confirmMessage.textContent = message;
        dom.confirmOk.textContent = okText || 'Delete';
        dom.confirmOverlay.classList.add('open');
        function cleanup() {
            dom.confirmOverlay.classList.remove('open');
            dom.confirmOk.removeEventListener('click', onOk);
            dom.confirmCancel.removeEventListener('click', onCancel);
            dom.confirmOverlay.removeEventListener('click', onOverlay);
        }
        function onOk() { cleanup(); resolve(true); }
        function onCancel() { cleanup(); resolve(false); }
        function onOverlay(e) {
            if (e.target === dom.confirmOverlay) { cleanup(); resolve(false); }
        }
        dom.confirmOk.addEventListener('click', onOk);
        dom.confirmCancel.addEventListener('click', onCancel);
        dom.confirmOverlay.addEventListener('click', onOverlay);
    });
};

__ss.deleteFile = async function(id) {
    var ok = await __ss.showConfirm('Move this file to archive?', 'Archive');
    if (!ok) return;
    if (window.Android) {
        try {
            var bubbleFile = window.Android.getBubbleFile();
            if (bubbleFile === id) {
                window.Android.disableBubble();
                __ss.showToast('Floating bubble disabled — file archived');
            }
        } catch(e) {}
    }
    await api.deleteFile(id);
    resetCrossDupCounts();
    __ss.renderHome();
    __ss.showToast('File archived');
};

__ss.promptRenameFile = function(id) {
    api.getFile(id).then(function(f) {
        if (!f || !f.id) return;
        state.renameFileId = id;
        dom.renameInput.value = f.name;
        dom.renameOverlay.classList.add('open');
        setTimeout(function() { dom.renameInput.focus(); dom.renameInput.select(); }, 100);
    });
};

__ss.commitRename = async function() {
    var name = dom.renameInput.value.trim();
    if (!name) { __ss.showToast('Name cannot be empty'); return; }
    var fileId = state.renameFileId;
    if (!fileId) return;
    await api.updateFile(fileId, { name: name });
    dom.renameOverlay.classList.remove('open');
    state.renameFileId = null;
    if (state.currentFileId === fileId) dom.sheetTitleBtn.textContent = name;
    __ss.renderHome();
    __ss.showToast('Renamed');
};

// ── Context menu (archive only) ──
function showArchiveCtx(e, fileId) {
    state.archiveCtxFileId = fileId;
    var rect = e.target.getBoundingClientRect();
    var left = rect.left;
    var popupW = 180;
    if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
    dom.archiveCtxPopup.style.left = left + 'px';
    dom.archiveCtxPopup.style.top = (rect.bottom + 4) + 'px';
    dom.archiveCtxPopup.classList.add('open');
}

// ── Home tabs ──
var htabs = dom.homeTabs ? dom.homeTabs.querySelectorAll('.home-tab') : [];
var allPanes = { files: dom.homePaneFiles, archive: dom.homePaneArchive, admin: dom.homePaneAdmin };
htabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
        htabs.forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var tabKey = tab.dataset.htab;
        Object.keys(allPanes).forEach(function(k) {
            if (allPanes[k]) allPanes[k].style.display = k === tabKey ? '' : 'none';
        });
        if (tabKey === 'archive') renderArchive();
        else if (tabKey === 'admin') renderAdmin();
        else __ss.renderHome();
    });
});

// ── Archive ──
function renderArchive() {
    api.getArchive().then(function(archived) {
        dom.archiveGrid.innerHTML = '';
        if (!archived.length) {
            dom.archiveEmptyState.style.display = 'flex';
            if (dom.archiveSelBar) dom.archiveSelBar.classList.remove('open');
            return;
        }
        dom.archiveEmptyState.style.display = 'none';
        var frag = document.createDocumentFragment();
        archived.forEach(function(f) {
            var td = __ss.getTypeDef(f.type);
            var daysLeft = Math.max(0, 30 - Math.floor((Date.now() - (f.deletedAt || 0)) / 86400000));
            var card = document.createElement('div');
            card.className = 'file-card';
            card.dataset.id = f.id;
            if (state.selectedArchiveFiles.has(f.id)) card.classList.add('selected');
            card.innerHTML =
                '<div class="file-card-icon" style="opacity:0.5"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg></div>' +
                '<div class="file-card-name" style="opacity:0.7">' + __ss.esc(f.name) + '</div>' +
                '<span class="file-card-meta">' + daysLeft + ' days left</span>' +
                '<div class="file-card-actions">' +
                '<button class="file-card-btn archive-restore" data-id="' + f.id + '" title="Restore"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>' +
                '<button class="file-card-btn archive-del" data-id="' + f.id + '" title="Delete permanently"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
                '</div>';

            __ss.attachTapHold(card, {
                onTap: function(el) {
                    if (state.archiveSelectionMode) {
                        toggleArchiveSelection(f.id);
                    } else {
                        enterArchiveSelectionMode(f.id);
                    }
                },
                onHold: function(el) {
                    if (!state.archiveSelectionMode) {
                        enterArchiveSelectionMode(f.id);
                    } else {
                        toggleArchiveSelection(f.id);
                    }
                }
            });

            card.querySelector('.archive-restore').addEventListener('click', function(e) {
                e.stopPropagation();
                api.restoreFile(f.id).then(function() {
                    __ss.showToast('File restored');
                    renderArchive();
                });
            });
            ['mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function(evt) {
                card.querySelector('.archive-restore').addEventListener(evt, function(ev) { ev.stopPropagation(); });
            });

            card.querySelector('.archive-del').addEventListener('click', async function(e) {
                e.stopPropagation();
                var ok = await __ss.showConfirm('Permanently delete this file?', 'Delete Forever');
                if (!ok) return;
                await api.permanentDelete(f.id);
                __ss.showToast('Permanently deleted');
                renderArchive();
            });
            ['mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function(evt) {
                card.querySelector('.archive-del').addEventListener(evt, function(ev) { ev.stopPropagation(); });
            });

            frag.appendChild(card);
        });
        dom.archiveGrid.appendChild(frag);
    });
}

function enterArchiveSelectionMode(fileId) {
    state.archiveSelectionMode = true;
    state.selectedArchiveFiles.clear();
    state.selectedArchiveFiles.add(fileId);
    updateArchiveSelBar();
    renderArchive();
}

function exitArchiveSelectionMode() {
    state.archiveSelectionMode = false;
    state.selectedArchiveFiles.clear();
    if (dom.archiveSelBar) dom.archiveSelBar.classList.remove('open');
    renderArchive();
}

function toggleArchiveSelection(fileId) {
    if (state.selectedArchiveFiles.has(fileId)) {
        state.selectedArchiveFiles.delete(fileId);
    } else {
        state.selectedArchiveFiles.add(fileId);
    }
    if (state.selectedArchiveFiles.size === 0) {
        exitArchiveSelectionMode();
        return;
    }
    updateArchiveSelBar();
    renderArchive();
}

function updateArchiveSelBar() {
    if (!dom.archiveSelBar) return;
    dom.archiveSelCount.textContent = state.selectedArchiveFiles.size + ' selected';
    dom.archiveSelBar.classList.add('open');
}

if (dom.archiveSelSelectAll) {
    dom.archiveSelSelectAll.addEventListener('click', function() {
        api.getArchive().then(function(archived) {
            archived.forEach(function(f) { state.selectedArchiveFiles.add(f.id); });
            updateArchiveSelBar();
            renderArchive();
        });
    });
}

if (dom.archiveSelUnselectAll) {
    dom.archiveSelUnselectAll.addEventListener('click', function() {
        exitArchiveSelectionMode();
    });
}

if (dom.archiveSelRestore) {
    dom.archiveSelRestore.addEventListener('click', async function() {
        if (!state.archiveSelectionMode) return;
        var ids = Array.from(state.selectedArchiveFiles);
        var ok = await __ss.showConfirm('Restore ' + ids.length + ' file' + (ids.length > 1 ? 's' : '') + '?', 'Restore');
        if (!ok) return;
        await api.batchRestore(ids);
        exitArchiveSelectionMode();
        renderArchive();
        __ss.showToast(ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' restored');
    });
}

if (dom.archiveSelDelete) {
    dom.archiveSelDelete.addEventListener('click', async function() {
        if (!state.archiveSelectionMode) return;
        var ids = Array.from(state.selectedArchiveFiles);
        var ok = await __ss.showConfirm('Permanently delete ' + ids.length + ' file' + (ids.length > 1 ? 's' : '') + '?', 'Delete Forever');
        if (!ok) return;
        await api.batchDelete(ids);
        resetCrossDupCounts();
        exitArchiveSelectionMode();
        renderArchive();
        __ss.showToast(ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' permanently deleted');
    });
}

// ── File type modal ──
__ss.toggleFabMenu = function() {
    var menu = dom.homeFabMenu;
    var open = menu.classList.toggle('open');
    if (!open) return;

    menu.innerHTML = '';

    __ss.FILE_TYPE_KEYS.forEach(function(k) {
        var td = __ss.FILE_TYPES[k];
        var item = document.createElement('button');
        item.className = 'home-fab-item';
        item.innerHTML =
            '<span class="home-fab-ic ' + td.badgeClass + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg></span>' +
            '<span><span class="home-fab-name">' + __ss.esc(td.label) + '</span><span class="home-fab-desc">' + __ss.esc(td.desc) + '</span></span>';
        item.addEventListener('click', function() {
            menu.classList.remove('open');
            __ss.createFile(k);
        });
        menu.appendChild(item);
    });

    var sep = document.createElement('div');
    sep.className = 'home-fab-sep';
    menu.appendChild(sep);

    var up = document.createElement('button');
    up.className = 'home-fab-item';
    up.innerHTML =
        '<span class="home-fab-ic" style="background:var(--bg3);color:var(--text2)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></span>' +
        '<span><span class="home-fab-name">Upload xlsx</span><span class="home-fab-desc">Import data from a spreadsheet</span></span>';
    up.addEventListener('click', function() {
        menu.classList.remove('open');
        dom.xlsxFileInputHome.click();
    });
    menu.appendChild(up);
};

document.addEventListener('click', function(e) {
    if (dom.homeFabMenu.classList.contains('open') && !dom.homeFabMenu.contains(e.target) && !dom.homeFab.contains(e.target)) {
        dom.homeFabMenu.classList.remove('open');
    }
});

__ss.createFile = async function(typeKey) {
    if (navigator.clipboard && navigator.clipboard.read) {
        navigator.clipboard.readText().then(function() {}).catch(function() {});
    }
    var td = __ss.getTypeDef(typeKey);
    var name = td.label + ' ' + __ss.todayStr();
    var files = state.filesCache || await api.getFiles();
    if (files.some(function(f) { return f.name === name; })) {
        var suffix = 2;
        while (files.some(function(f) { return f.name === name + ' (' + suffix + ')'; })) { suffix++; }
        name = name + ' (' + suffix + ')';
    }
    var id = __ss.genId();
    await api.createFile({ id: id, name: name, type: typeKey });
    resetCrossDupCounts();
    __ss.showToast(td.label + ' file created');
    __ss.openFile(id);
};

// ── Rename modal ──
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
    if (e.target === dom.renameOverlay) { dom.renameOverlay.classList.remove('open'); state.renameFileId = null; }
});

// ── Escape exits file selection ──
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && state.fileSelectionMode) exitFileSelectionMode();
    if (e.key === 'Escape' && state.archiveSelectionMode) exitArchiveSelectionMode();
});

// ── Home xlsx upload ──
dom.xlsxFileInputHome.addEventListener('change', async function(e) {
    var file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    var reader = new FileReader();
    reader.onload = async function(ev) {
        var wb = XLSX.read(ev.target.result, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var json = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (json.length < 1) { __ss.showToast('File is empty'); return; }
        var headers = (json[0] || []).map(function(h) { return String(h).toLowerCase().trim(); });
        var typeKey = 'ig_cookie';
        var bestMatch = 0;
        __ss.FILE_TYPE_KEYS.forEach(function(tk) {
            var tdef = __ss.FILE_TYPES[tk];
            var matches = tdef.columns.filter(function(c) {
                return headers.indexOf(c.key.toLowerCase()) !== -1 || headers.indexOf(c.label.toLowerCase()) !== -1;
            });
            if (matches.length > bestMatch) {
                bestMatch = matches.length;
                typeKey = tk;
            }
        });
        var td = __ss.FILE_TYPES[typeKey];
        var colMap = null;
        var dataStart = 1;
        if (bestMatch > 0) {
            colMap = td.columns.map(function(c) {
                var idx = headers.indexOf(c.key.toLowerCase());
                if (idx === -1) idx = headers.indexOf(c.label.toLowerCase());
                return { key: c.key, idx: idx };
            }).filter(function(cm) { return cm.idx !== -1; });
        } else {
            var isFb = false;
            for (var si = 0; si < Math.min(3, json.length); si++) {
                var rowVals = json[si] || [];
                for (var sj = 0; sj < rowVals.length; sj++) {
                    var val = String(rowVals[sj]).toLowerCase();
                    if (val.indexOf('c_user=') !== -1 || val.indexOf('ds_user_id=') !== -1) {
                        isFb = true;
                        break;
                    }
                }
                if (isFb) break;
            }
            if (isFb) {
                typeKey = 'fb_cookie';
                td = __ss.FILE_TYPES[typeKey];
            }
            colMap = td.columns.map(function(c, i) { return { key: c.key, idx: i }; });
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
        if (typeKey === 'fb_cookie') {
            rows.forEach(function(r) {
                if (!r.uid && r.cookies) {
                    var m = r.cookies.match(/c_user=(\d+)/);
                    if (m) r.uid = m[1];
                }
            });
        }
        if (rows.length === 0) { __ss.showToast('No data rows found'); return; }
        try { if (window.__ss && __ss.hydrateWaCache) { await __ss.hydrateWaCache(rows); } } catch (e) {}
        var name = file.name.replace(/\.xlsx?$/i, '') || 'Import ' + __ss.todayStr();
        var files = state.filesCache || await api.getFiles();
        if (files.some(function(f) { return f.name === name; })) name = name + ' (' + __ss.genId().slice(0, 4) + ')';
        var id = __ss.genId();
        await api.createFile({ id: id, name: name, type: typeKey, rowCount: rows.length });
        await api.persist(id, { rows: rows, dataCount: rows.length, action: 'import' });
        resetCrossDupCounts();
        __ss.showToast('Imported ' + rows.length + ' rows');
        __ss.openFile(id);
    };
    reader.readAsArrayBuffer(file);
});

// ── Admin tab ──
var adminSearchTimer = null;
var adminSelectedUserId = null;

async function renderAdmin() {
    if (!__ss.currentUser || !__ss.currentUser.isAdmin) return;
    if (adminSelectedUserId) { showAdminUserList(); return; }

    var stats = await api.adminStats();
    if (dom.adminTotalUsers) dom.adminTotalUsers.textContent = stats.totalUsers;
    if (dom.adminTotalFiles) dom.adminTotalFiles.textContent = stats.totalFiles;

    var users = await api.adminUsers();
    renderAdminUserList(users);
}

function renderAdminUserList(users) {
    if (!dom.adminUserList) return;
    dom.adminUserList.innerHTML = '';
    if (dom.adminUserDetail) dom.adminUserDetail.style.display = 'none';
    if (dom.adminStats) dom.adminStats.style.display = '';
    if (dom.adminUserSearch) dom.adminUserSearch.parentElement.style.display = '';

    if (!users.length) {
        dom.adminUserList.innerHTML = '<div class="empty-state"><div class="empty-state-title">No users found</div></div>';
        return;
    }
    users.forEach(function(user) {
        var card = document.createElement('div');
        card.className = 'admin-user-card';
        var displayName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || 'Unknown';
        var lastLogin = user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Never';
        card.innerHTML =
            '<div class="admin-user-avatar-wrap">' +
            (user.photoUrl ? '<img class="admin-user-avatar" src="' + user.photoUrl + '" alt="" />' : '<div class="admin-user-avatar admin-user-avatar-placeholder">' + __ss.esc(displayName.charAt(0).toUpperCase()) + '</div>') +
            '</div>' +
            '<div class="admin-user-info">' +
            '<div class="admin-user-name">' + __ss.esc(displayName) + '</div>' +
            '<div class="admin-user-username">' + (user.username ? '@' + __ss.esc(user.username) : 'ID: ' + user.id) + '</div>' +
            '</div>' +
            '<div class="admin-user-meta">' +
            '<div class="admin-user-stat"><span class="admin-user-stat-val">' + (user.fileCount || 0) + '</span> files</div>' +
            '<div class="admin-user-stat"><span class="admin-user-stat-val">' + lastLogin + '</span></div>' +
            '</div>';

        card.addEventListener('click', function() { showAdminUserDetail(user.id); });
        dom.adminUserList.appendChild(card);
    });
}

function showAdminUserList() {
    adminSelectedUserId = null;
    state.isAdminFile = false;
    state.adminFileOwnerId = null;
    if (dom.adminUserDetail) dom.adminUserDetail.style.display = 'none';
    if (dom.adminStats) dom.adminStats.style.display = '';
    if (dom.adminUserSearch) dom.adminUserSearch.parentElement.style.display = '';
    renderAdmin();
}
__ss.showAdminUserList = showAdminUserList;

async function showAdminUserDetail(userId) {
    adminSelectedUserId = userId;
    if (dom.adminStats) dom.adminStats.style.display = 'none';
    if (dom.adminUserList) dom.adminUserList.innerHTML = '';
    if (dom.adminUserSearch) dom.adminUserSearch.parentElement.style.display = 'none';
    if (dom.adminUserDetail) dom.adminUserDetail.style.display = '';

    var user = await api.adminUser(userId);
    if (!user || !user.id) return;

    var displayName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim() || 'Unknown';
    var lastLogin = user.lastLogin ? new Date(user.lastLogin).toLocaleString() : 'Never';

    if (dom.adminUserHeader) {
        dom.adminUserHeader.innerHTML =
            '<div class="admin-detail-header">' +
            (user.photoUrl ? '<img class="admin-detail-avatar" src="' + user.photoUrl + '" alt="" />' : '<div class="admin-detail-avatar admin-user-avatar-placeholder">' + __ss.esc(displayName.charAt(0).toUpperCase()) + '</div>') +
            '<div class="admin-detail-info">' +
            '<div class="admin-detail-name">' + __ss.esc(displayName) + '</div>' +
            '<div class="admin-detail-meta">' + (user.username ? '@' + __ss.esc(user.username) : 'ID: ' + user.id) + '</div>' +
            '<div class="admin-detail-meta">Last login: ' + lastLogin + '</div>' +
            '<div class="admin-detail-meta">' + (user.fileCount || 0) + ' files, ' + (user.archivedCount || 0) + ' archived</div>' +
            '</div>' +
            '<div class="admin-detail-actions">' +
            '<button class="btn btn-danger btn-sm" id="adminDeleteUserBtn">Delete User</button>' +
            '</div>' +
            '</div>';

        document.getElementById('adminDeleteUserBtn').addEventListener('click', async function() {
            var ok = await __ss.showConfirm('Permanently delete this user and all their files?', 'Delete User');
            if (!ok) return;
            await api.adminDeleteUser(userId);
            __ss.showToast('User deleted');
            showAdminUserList();
        });
    }

    var files = user.files || [];
    if (dom.adminFileList) {
        dom.adminFileList.innerHTML = '';
        if (files.length) {
        files.forEach(function(f) {
            var td = __ss.getTypeDef(f.type);
            var count = f.dataCount || 0;
            var card = document.createElement('div');
            card.className = 'file-card';
            card.innerHTML =
                '<div class="file-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg></div>' +
                '<div class="file-card-name">' + __ss.esc(f.name) + '</div>' +
                '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px">' +
                '<span class="file-type-badge ' + td.badgeClass + '">' + __ss.esc(td.badge) + '</span>' +
                '<span class="file-card-meta">' + count + ' row' + (count !== 1 ? 's' : '') + '</span></div>' +
                '<div class="file-card-actions">' +
                '<button class="file-card-btn admin-file-dl" title="Download"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>' +
                '<button class="file-card-btn admin-file-rename" title="Rename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>' +
                '<button class="file-card-btn admin-file-del file-card-del" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
                '</div>';

            card.addEventListener('click', function() {
                state.isAdminFile = true;
                state.adminFileOwnerId = userId;
                __ss.openFileAdmin(f.id);
            });
            card.querySelector('.admin-file-dl').addEventListener('click', function(e) {
                e.stopPropagation();
                adminDownloadFile(f.id, f.name);
            });
            card.querySelector('.admin-file-rename').addEventListener('click', function(e) {
                e.stopPropagation();
                adminRenameFile(f.id, f.name, userId);
            });
            card.querySelector('.admin-file-del').addEventListener('click', function(e) {
                e.stopPropagation();
                adminDeleteFile(f.id, userId);
            });

            dom.adminFileList.appendChild(card);
        });
        }
    }

    var archived = await api.adminUserArchive(userId);
    if (dom.adminFileList && archived.length) {
        var archHeader = document.createElement('div');
        archHeader.style.cssText = 'grid-column:1/-1;font-size:12px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-top:8px;padding-bottom:4px;border-top:1px solid var(--border);padding-top:16px;';
        archHeader.textContent = 'Archived (' + archived.length + ')';
        dom.adminFileList.appendChild(archHeader);

        archived.forEach(function(f) {
            var td = __ss.getTypeDef(f.type);
            var daysLeft = Math.max(0, 30 - Math.floor((Date.now() - (f.deletedAt || 0)) / 86400000));
            var card = document.createElement('div');
            card.className = 'file-card';
            card.style.opacity = '0.6';
            card.innerHTML =
                '<div class="file-card-icon" style="opacity:0.5"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/></svg></div>' +
                '<div class="file-card-name">' + __ss.esc(f.name) + '</div>' +
                '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px">' +
                '<span class="file-type-badge ' + td.badgeClass + '">' + __ss.esc(td.badge) + '</span>' +
                '<span class="file-card-meta">' + daysLeft + ' days left</span></div>' +
                '<div class="file-card-actions">' +
                '<button class="file-card-btn admin-archive-restore" title="Restore"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>' +
                '<button class="file-card-btn admin-archive-del file-card-del" title="Delete permanently"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
                '</div>';

            card.querySelector('.admin-archive-restore').addEventListener('click', async function(e) {
                e.stopPropagation();
                await api.adminRestoreArchived(userId, f.id);
                __ss.showToast('File restored');
                showAdminUserDetail(userId);
            });
            card.querySelector('.admin-archive-del').addEventListener('click', async function(e) {
                e.stopPropagation();
                var ok = await __ss.showConfirm('Permanently delete this file?', 'Delete Forever');
                if (!ok) return;
                await api.adminDeleteArchived(userId, f.id);
                __ss.showToast('Permanently deleted');
                showAdminUserDetail(userId);
            });

            dom.adminFileList.appendChild(card);
        });
    }
}
__ss.showAdminUserDetail = showAdminUserDetail;

function adminDownloadFile(id, name) {
    Promise.all([api.adminFileRows(id), api.adminFile(id)]).then(function(results) {
        var rows = results[0];
        var f = results[1];
        if (!rows || !rows.length) { __ss.showToast('No data'); return; }
        var td = __ss.getTypeDef(f && f.type ? f.type : 'ig_cookie');
        var data = [];
        rows.forEach(function(row) {
            var isEmpty = td.columns.every(function(c) { return !row[c.key]; });
            if (!isEmpty) data.push(td.columns.map(function(c) { return row[c.key] || ''; }));
        });
        if (!data.length) { __ss.showToast('No data'); return; }
        var ws = XLSX.utils.aoa_to_sheet(data);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        XLSX.writeFile(wb, (name || 'export') + '.xlsx');
        __ss.showToast('Downloaded');
    });
}

function adminRenameFile(fileId, currentName, userId) {
    state.renameFileId = fileId;
    state.renameIsAdmin = true;
    state.renameAdminUserId = userId;
    dom.renameInput.value = currentName;
    dom.renameOverlay.classList.add('open');
    setTimeout(function() { dom.renameInput.focus(); dom.renameInput.select(); }, 100);
}

async function adminDeleteFile(fileId, userId) {
    var ok = await __ss.showConfirm('Move this file to archive?', 'Archive');
    if (!ok) return;
    await api.adminDeleteFile(fileId);
    __ss.showToast('File archived');
    if (adminSelectedUserId) showAdminUserDetail(userId);
}

if (dom.adminBackBtn) {
    dom.adminBackBtn.addEventListener('click', showAdminUserList);
}

if (dom.adminUserSearch) {
    dom.adminUserSearch.addEventListener('input', function() {
        clearTimeout(adminSearchTimer);
        var q = dom.adminUserSearch.value.trim();
        adminSearchTimer = setTimeout(async function() {
            if (q) {
                var users = await api.adminSearchUsers(q);
                renderAdminUserList(users);
            } else {
                renderAdmin();
            }
        }, 300);
    });
}

// ── Override commitRename for admin ──
var origCommitRename = __ss.commitRename;
__ss.commitRename = async function() {
    var name = dom.renameInput.value.trim();
    if (!name) { __ss.showToast('Name cannot be empty'); return; }
    var fileId = state.renameFileId;
    if (!fileId) return;

    if (state.renameIsAdmin) {
        await api.adminUpdateFile(fileId, { name: name });
        dom.renameOverlay.classList.remove('open');
        state.renameFileId = null;
        state.renameIsAdmin = false;
        var userId = state.renameAdminUserId;
        state.renameAdminUserId = null;
        __ss.showToast('Renamed');
        if (userId) showAdminUserDetail(userId);
        return;
    }

    origCommitRename();
};

})();
