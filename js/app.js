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
        // Show admin tab
        var adminBtn = document.getElementById('adminTabBtn');
        if (adminBtn && user.isAdmin) {
            adminBtn.style.display = '';
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
var _healthInterval = 15000;
var _healthTimer = null;

function checkConn() {
    fetch('/api/health').then(function(r) { return r.json(); }).then(function(h) {
        _healthInterval = 15000; // reset on success
        var ok = h.status === 'ok' || h.status === 'ready';
        dom.connStatus.className = ok ? 'conn-status ok' : 'conn-status warn';
        dom.connStatusText.textContent = ok ? 'Connected' : 'Reconnecting...';
    }).catch(function() {
        dom.connStatus.className = 'conn-status err';
        dom.connStatusText.textContent = 'Disconnected';
        _healthInterval = Math.min(_healthInterval * 1.5, 120000); // backoff up to 2min
    });
}

function scheduleHealthCheck() {
    _healthTimer = setTimeout(function() {
        checkConn();
        scheduleHealthCheck();
    }, _healthInterval);
}

scheduleHealthCheck();

// ── Home FAB ──
dom.homeFab.addEventListener('click', __ss.showTypeModal);

// ── Popstate (browser nav) ──
window.addEventListener('popstate', function(e) {
    if (e.state && e.state.fileId) {
        __ss.api.getFile(e.state.fileId).then(function(f) {
            if (f && f.id) {
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
            __ss.api.getFile(m[1]).then(function(f) {
                if (f && f.id) {
                    try { history.replaceState({fileId: m[1]}, '', 'file/' + m[1]); } catch(e) {}
                    __ss.openFile(m[1]);
                }
            });
        }
    }
});

})();
