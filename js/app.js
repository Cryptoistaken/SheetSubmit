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

    fetch('/api/bot/info').then(function(r) { return r.json(); }).then(function(info) {
        if (info.username) {
            document.getElementById('botLink').href = 'https://t.me/' + info.username;
            document.getElementById('botUsernameHint').textContent = '@' + info.username;
        }
    }).catch(function() {});
}

function showApp(user) {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('homeView').style.display = 'flex';
    document.querySelector('.topbar').style.display = 'flex';

    // Set user profile
    if (user) {
        var profileBtn = document.getElementById('userProfileBtn');
        var avatar = document.getElementById('userAvatar');
        if (profileBtn) {
            profileBtn.style.display = 'block';
            if (user.photoUrl) {
                avatar.src = user.photoUrl;
            } else {
                avatar.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>');
            }
        }
    }
}

// ── User profile panel ──
var profileBtn = document.getElementById('userProfileBtn');
var profilePanel = document.getElementById('userProfilePanel');
var logoutBtn = document.getElementById('logoutBtn');

if (profileBtn) {
    profileBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var user = __ss.currentUser;
        if (user) {
            document.getElementById('userProfileAvatar').src = user.photoUrl || '';
            document.getElementById('userProfileName').textContent = (user.firstName || '') + ' ' + (user.lastName || '');
            document.getElementById('userProfileUsername').textContent = user.username ? '@' + user.username : '';
            document.getElementById('userProfileUid').textContent = 'UID: ' + user.id;
            if (!user.photoUrl) document.getElementById('userProfileAvatar').style.display = 'none';
            else document.getElementById('userProfileAvatar').style.display = 'block';
        }
        profilePanel.classList.toggle('open');
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
    if (profilePanel && !profilePanel.contains(e.target) && e.target !== profileBtn && !profileBtn.contains(e.target)) {
        profilePanel.classList.remove('open');
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
