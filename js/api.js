(function() {
var __ss = window.__ss = window.__ss || {};
var BASE = '/api';
var _controllers = new Map();
var _ctrlId = 0;

function _getController() {
    var id = ++_ctrlId;
    var ctrl = new AbortController();
    _controllers.set(id, ctrl);
    return { id: id, controller: ctrl };
}

function _doneController(id) {
    _controllers.delete(id);
}

async function get(path) {
    var c = _getController();
    try {
        var r = await fetch(BASE + path, { signal: c.controller.signal });
        _doneController(c.id);
        return await r.json();
    } catch(e) {
        _doneController(c.id);
        if (e.name === 'AbortError') return;
        throw e;
    }
}

async function post(path, body) {
    var c = _getController();
    try {
        var r = await fetch(BASE + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: c.controller.signal,
        });
        _doneController(c.id);
        return await r.json();
    } catch(e) {
        _doneController(c.id);
        if (e.name === 'AbortError') return;
        throw e;
    }
}

async function put(path, body) {
    var c = _getController();
    try {
        var r = await fetch(BASE + path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: c.controller.signal,
        });
        _doneController(c.id);
        return await r.json();
    } catch(e) {
        _doneController(c.id);
        if (e.name === 'AbortError') return;
        throw e;
    }
}

async function del(path) {
    var c = _getController();
    try {
        var r = await fetch(BASE + path, { method: 'DELETE', signal: c.controller.signal });
        _doneController(c.id);
        return await r.json();
    } catch(e) {
        _doneController(c.id);
        if (e.name === 'AbortError') return;
        throw e;
    }
}

__ss.api = {
    cancelPending: function() {
        _controllers.forEach(function(c) { c.abort(); });
        _controllers.clear();
        // _controllers is already cleared by .clear() above, so new requests create fresh controllers
    },
    getFiles: function() {
        return get('/files');
    },
    getFile: function(id) { return get('/files/' + id); },
    createFile: function(data) { return post('/files', data); },
    updateFile: function(id, data) { return put('/files/' + id, data); },
    deleteFile: function(id) { return del('/files/' + id); },
    getRows: function(id) {
        return get('/files/' + id + '/rows');
    },
    persist: function(id, data) {
        return put('/files/' + id + '/persist', data);
    },
    health: function() { return get('/health'); },
    getArchive: function() { return get('/archive'); },
    restoreFile: function(id) { return post('/archive/' + id + '/restore'); },
    permanentDelete: function(id) { return del('/archive/' + id); },
    batchRestore: function(ids) { return post('/archive/batch-restore', { ids: ids }); },
    batchDelete: function(ids) { return post('/archive/batch-delete', { ids: ids }); },
    getSync: function(id) { return get('/files/' + id + '/sync'); },
    setSync: function(id, data) { return put('/files/' + id + '/sync', data); },
    updateCell: function(id, data) {
        return put('/files/' + id + '/cell', data);
    },
    appendLog: function(id, data) { return post('/files/' + id + '/log', data); },
    getLogs: function(id) { return get('/files/' + id + '/logs'); },
    getCrossDups: function(fileId) {
        return get('/cross-dups' + (fileId ? '?fileId=' + fileId : ''));
    },
    waCheck: function(cookie) {
        return post('/fb/wa-check', { cookie: cookie });
    },

    adminStats: function() { return get('/admin/stats'); },
    adminUsers: function() { return get('/admin/users'); },
    adminSearchUsers: function(q) { return get('/admin/users/search?q=' + encodeURIComponent(q)); },
    adminUser: function(userId) { return get('/admin/user/' + userId); },
    adminUserArchive: function(userId) { return get('/admin/user/' + userId + '/archive'); },
    adminRestoreArchived: function(userId, fileId) { return post('/admin/user/' + userId + '/archive/' + fileId + '/restore'); },
    adminDeleteArchived: function(userId, fileId) { return del('/admin/user/' + userId + '/archive/' + fileId); },
    adminFile: function(fileId) { return get('/admin/file/' + fileId); },
    adminUpdateFile: function(fileId, data) { return put('/admin/file/' + fileId, data); },
    adminDeleteFile: function(fileId) { return del('/admin/file/' + fileId); },
    adminFileRows: function(fileId) { return get('/admin/file/' + fileId + '/rows'); },
    adminPersist: function(fileId, data) { return put('/admin/file/' + fileId + '/persist', data); },
    adminUpdateCell: function(fileId, data) { return put('/admin/file/' + fileId + '/cell', data); },
    adminAppendLog: function(fileId, data) { return post('/admin/file/' + fileId + '/log', data); },
    adminFileLogs: function(fileId) { return get('/admin/file/' + fileId + '/logs'); },
    adminDeleteUser: function(userId) { return del('/admin/user/' + userId); },
};

})();
