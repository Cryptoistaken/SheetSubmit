(function() {
var __ss = window.__ss;
var dom = __ss.dom;

// Only exists inside the Android WebView (bridge registered by the app).
// NOTE: gate on window.Android only — nativeClipboardReady is injected later
// (onPageFinished), after deferred scripts already ran at DOMContentLoaded.
var APP = !!window.Android;

var QS = null;
try { QS = new URLSearchParams(window.location.search); } catch(e) {}
var BUBBLE_MODE = APP && QS !== null && QS.get('bubble') === '1' && QS.get('file');

// ── Gear menu row (Android only) ──
var row = document.getElementById('bubbleMenuRow');
var toggle = document.getElementById('bubbleToggle');

if (APP && row && toggle) {
    row.style.display = '';
    try { toggle.checked = !!window.Android.isBubbleEnabled(); } catch(e) {}

    toggle.addEventListener('change', function() {
        if (toggle.checked) {
            openPicker();
        } else {
            try { window.Android.disableBubble(); } catch(e) {}
            __ss.showToast('Floating bubble off');
        }
    });
} else if (row) {
    window.addEventListener('load', function() {
        if (window.Android) {
            row.style.display = '';
            APP = true;
        }
    });
}

function enableBubble(id, name) {
    try { window.Android.enableBubble(id); } catch(e) {}
    if (toggle) toggle.checked = true;
    __ss.showToast('Floating bubble on — ' + name);
}

function closePicker(ov) {
    ov.classList.remove('open');
    setTimeout(function() {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
    }, 150);
}

function openPicker() {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML =
        '<div class="modal-box">' +
        '<div class="modal-title" style="margin-bottom:6px">Floating bubble</div>' +
        '<div style="font-size:13px;color:var(--text2);margin-bottom:10px;line-height:1.5">Choose an FB Cookie file to show in the mini window</div>' +
        '<div class="bubble-picker" id="bubblePickerList"><div class="bubble-picker-empty">Loading&hellip;</div></div>' +
        '<div class="home-fab-sep"></div>' +
        '<button class="home-fab-item" id="bubbleCreateBtn">' +
        '<span class="home-fab-ic t-fb">+</span>' +
        '<span><span class="home-fab-name">Create new FB Cookie file</span><span class="home-fab-desc">Make a fresh file for the bubble</span></span>' +
        '</button>' +
        '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function() { ov.classList.add('open'); });

    ov.addEventListener('click', function(e) {
        if (e.target === ov) closePicker(ov);
    });

    var list = ov.querySelector('#bubblePickerList');

    __ss.api.getFiles().then(function(files) {
        var fb = (files || []).filter(function(f) { return f.type === 'fb_cookie'; });
        if (!fb.length) {
            list.innerHTML = '<div class="bubble-picker-empty">No FB Cookie files yet — create one below</div>';
            return;
        }
        list.innerHTML = '';
        fb.forEach(function(f) {
            var btn = document.createElement('button');
            btn.className = 'home-fab-item';
            btn.innerHTML =
                '<span class="home-fab-ic t-fb">FB</span>' +
                '<span><span class="home-fab-name">' + __ss.esc(f.name) + '</span>' +
                '<span class="home-fab-desc">' + __ss.esc(new Date(f.updatedAt || Date.now()).toLocaleString()) + '</span></span>';
            btn.addEventListener('click', function() {
                closePicker(ov);
                enableBubble(f.id, f.name);
            });
            list.appendChild(btn);
        });
    }).catch(function() {
        list.innerHTML = '<div class="bubble-picker-empty">Could not load files</div>';
    });

    ov.querySelector('#bubbleCreateBtn').addEventListener('click', function() {
        closePicker(ov);
        __ss.createFile('fb_cookie').then(function() {
            __ss.api.getFiles().then(function(files) {
                var newest = (files || [])[0];
                if (newest) enableBubble(newest.id, newest.name);
            }).catch(function() {});
        });
    });
}

// ── Mini-window mode (?bubble=1&file=<id>) ──
if (BUBBLE_MODE) {
    document.body.classList.add('bubble-mode');
    var fileId = QS.get('file');
    var tries = 0;

    function boot() {
        if (!__ss.currentUser) {
            if (++tries < 40) setTimeout(boot, 300);
            return;
        }
        __ss.openFile(fileId).then(function() {
            __ss.bubbleRowLimit = 10;
            window.setInterval(function() {
                if (__ss.refreshSheet) __ss.refreshSheet();
            }, 6000);
        });
    }

    boot();
}

})();