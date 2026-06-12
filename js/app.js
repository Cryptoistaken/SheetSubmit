(function() {
var __ss = window.__ss;
var dom = __ss.dom;

// ── Auth check ──
async function checkAuth() {
    try {
        var res = await fetch('/api/auth/me');
        var user = await res.json();
        if (user) {
            __ss.currentUser = user;
            showApp(user);
        } else {
            showLogin();
        }
    } catch(e) {
        showLogin();
    }
}

function showLogin() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('homeView').style.display = 'none';
    document.getElementById('sheetView').style.display = 'none';
    document.querySelector('.topbar').style.display = 'none';
    document.getElementById('homeFab').classList.add('hidden');

    var btn = document.getElementById('botLink');
    btn.classList.add('loading');
    btn.querySelector('.btn-label').textContent = 'Loading...';

    fetch('/api/bot/info').then(function(r) { return r.json(); }).then(function(info) {
        if (info.username) {
            btn.href = 'https://t.me/' + info.username + '?start=login';
            btn.querySelector('.btn-label').textContent = 'Open Telegram';
            btn.classList.remove('loading');
            btn.classList.add('ready');
        } else {
            btn.querySelector('.btn-label').textContent = 'Bot not available';
        }
    }).catch(function() {
        btn.querySelector('.btn-label').textContent = 'Connection failed';
    });
}

function showApp(user) {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('homeView').style.display = 'flex';
    document.querySelector('.topbar').style.display = 'flex';
    document.getElementById('homeFab').classList.remove('hidden');

    // Set user avatar on gear button
    if (user) {
        var gearBtn = document.getElementById('gearBtn');
        var avatar = document.getElementById('userBtnAvatar');
        if (gearBtn && user.photoUrl) {
            avatar.src = user.photoUrl;
            gearBtn.classList.add('loaded');
        }
    }
}

// ── Gear button: populate merged panel with user info ──
var gearPanel = document.getElementById('gearPanel');
var gearBtn = document.getElementById('gearBtn');
var logoutBtn = document.getElementById('logoutBtn');

if (gearBtn) {
    gearBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var user = __ss.currentUser;
        if (user) {
            document.getElementById('gearUserAvatar').src = user.photoUrl || '';
            document.getElementById('gearUserName').textContent = (user.firstName || '') + ' ' + (user.lastName || '');
            document.getElementById('gearUserUsername').textContent = user.username ? '@' + user.username : '';
        }
        gearPanel.classList.toggle('open');
    });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', function() {
        fetch('/api/auth/logout').then(function() {
            window.location.reload();
        });
    });
}

document.addEventListener('click', function(e) {
    if (gearPanel && !gearPanel.contains(e.target) && e.target !== gearBtn && !gearBtn.contains(e.target)) {
        gearPanel.classList.remove('open');
    }
});

// ── Connection health ──
async function checkConn() {
    try {
        var h = await fetch('/api/health').then(function(r) { return r.json(); });
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

// ── Home FAB ──
dom.homeFab.addEventListener('click', __ss.showTypeModal);

// ── Popstate (browser nav) ──
window.addEventListener('popstate', function(e) {
    if (e.state && e.state.fileId) {
        fetch('/api/files').then(function(r) { return r.json(); }).then(function(files) {
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
checkAuth().then(function() {
    if (__ss.currentUser) {
        __ss.renderHome();
        checkConn();

        // Restore file from URL
        var m = window.location.pathname.match(/\/file\/([^/]+)/);
        if (m) {
            fetch('/api/files').then(function(r) { return r.json(); }).then(function(files) {
                var f = files.find(function(x) { return x.id === m[1]; });
                if (f) {
                    try { history.replaceState({fileId: m[1]}, '', 'file/' + m[1]); } catch(e) {}
                    __ss.openFile(m[1]);
                }
            });
        }
    }
});

})();
