(function() {
var __ss = window.__ss;
var dom = __ss.dom;
var api = __ss.api;

// ── Connection health ──
async function checkConn() {
    try {
        var h = await api.health();
        if (h.status === 'ok') {
            dom.connStatus.className = 'conn-status ok';
            dom.connStatusText.textContent = 'Connected';
        } else {
            dom.connStatus.className = 'conn-status err';
            dom.connStatusText.textContent = h.status;
        }
    } catch {
        dom.connStatus.className = 'conn-status err';
        dom.connStatusText.textContent = 'Disconnected';
    }
}
setInterval(checkConn, 15000);
checkConn();

// ── Home FAB ──
dom.homeFab.addEventListener('click', __ss.showTypeModal);

// ── Popstate (browser nav) ──
window.addEventListener('popstate', function(e) {
    if (e.state && e.state.fileId) {
        api.getFiles().then(function(files) {
            if (files.find(function(x) { return x.id === e.state.fileId; })) {
                if (__ss.state.currentFileId !== e.state.fileId) __ss.openFile(e.state.fileId);
                return;
            }
            if (__ss.state.currentFileId) __ss.closeSheet();
        });
        return;
    }
    if (__ss.state.currentFileId) __ss.closeSheet();
});

// ── Initial render ──
__ss.renderHome();

// ── Restore file from URL ──
function getFileIdFromUrl() {
    var m = window.location.pathname.match(/\/file\/([^/]+)/);
    return m ? m[1] : null;
}

var openId = getFileIdFromUrl();
if (openId) {
    api.getFiles().then(function(files) {
        var f = files.find(function(x) { return x.id === openId; });
        if (f) {
            try { history.replaceState({fileId: openId}, '', 'file/' + openId); } catch(e) {}
            __ss.openFile(openId);
        }
    });
}

})();
