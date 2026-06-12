(function() {
var __ss = window.__ss = window.__ss || {};
var BASE = '/api';

async function get(path) {
    var r = await fetch(BASE + path);
    return r.json();
}

async function post(path, body) {
    var r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return r.json();
}

async function put(path, body) {
    var r = await fetch(BASE + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return r.json();
}

async function del(path) {
    var r = await fetch(BASE + path, { method: 'DELETE' });
    return r.json();
}

__ss.api = {
    getFiles: function() { return get('/files'); },
    createFile: function(data) { return post('/files', data); },
    updateFile: function(id, data) { return put('/files/' + id, data); },
    deleteFile: function(id) { return del('/files/' + id); },
    getRows: function(id) { return get('/files/' + id + '/rows'); },
    saveRows: function(id, data) { return put('/files/' + id + '/rows', data); },
    getStack: function(id, name) { return get('/files/' + id + '/stack/' + name); },
    saveStack: function(id, name, stack) { return put('/files/' + id + '/stack/' + name, stack); },
    health: function() { return get('/health'); },
    getArchive: function() { return get('/archive'); },
    restoreFile: function(id) { return post('/archive/' + id + '/restore'); },
    permanentDelete: function(id) { return del('/archive/' + id); },
    getSync: function(id) { return get('/files/' + id + '/sync'); },
    setSync: function(id, data) { return put('/files/' + id + '/sync', data); },
    getLogs: function(id) { return get('/files/' + id + '/logs'); },
    addLog: function(id, log) { return post('/files/' + id + '/logs', log); },
};

})();
