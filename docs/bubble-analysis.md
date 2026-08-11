# Floating Bubble — Edge Case Analysis & Solutions

> Deep analysis of the floating bubble feature covering all dead ends, edge cases, and failure modes with proposed solutions.

---

## Table of Contents

- [Critical Issues](#critical-issues)
- [High Issues](#high-issues)
- [Medium Issues](#medium-issues)
- [Low Issues](#low-issues)
- [Implementation Guide](#implementation-guide)

---

## Critical Issues

### C1. File Deleted While Bubble Enabled

**Severity:** 🔴 Critical — data loss / infinite error loop

**Location:**
- `js/bubble.js:39-43` — `enableBubble()` stores file ID in prefs
- `js/home.js:237-244` — `deleteFile()` archives file, never touches bubble prefs
- `android/.../FloatingBubbleService.java:375-378` — loads file from prefs without validation

**What happens:**
1. User enables bubble on file X → `bubble_file = "abc123"` stored in SharedPreferences
2. User archives/deletes file X from the main app
3. `bubble_file` pref still points to `"abc123"` — now a dead ID
4. Bubble service keeps running, mini WebView loads `/?bubble=1&file=abc123`
5. `openFile("abc123")` → API returns 404 or empty → fails silently
6. 6s refresh loop (`refreshSheet`) keeps hitting 404 forever
7. User sees a blank/broken bubble with no explanation

**Root cause:** No lifecycle link between file deletion and bubble state. `deleteFile()` doesn't check if the file is bubble-enabled.

**Solution:**

```js
// In js/home.js — deleteFile function
__ss.deleteFile = async function(id) {
    var ok = await __ss.showConfirm('Move this file to archive?', 'Archive');
    if (!ok) return;

    // Clear bubble pref if this file was bubble-enabled
    if (window.Android) {
        try {
            var bubbleFile = await window.Android.getBubbleFile(); // new bridge method
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
```

```java
// In FloatingBubbleService.java — add bridge method
@JavascriptInterface
public String getBubbleFile() {
    return getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_FILE, "");
}
```

**Also add validation on service start:**

```java
// In FloatingBubbleService.java — onCreate
@Override
public void onCreate() {
    super.onCreate();
    // ... existing overlay permission check ...

    // Validate bubble file still exists
    String fileId = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_FILE, "");
    if (fileId.isEmpty()) {
        Log.i(TAG, "No bubble file set, stopping");
        stopSelf();
        return;
    }
    // ... rest of onCreate ...
}
```

---

### C2. File Type Changed After Bubble Enabled

**Severity:** 🔴 Critical — feature silently dead

**Location:**
- `js/bubble.js:265` — `automateClipboard()` early return on type mismatch

**What happens:**
1. User enables bubble on an `fb_cookie` file
2. User later changes that file's type to `ig_cookie`
3. Bubble still loads the file (it exists, just wrong type)
4. `automateClipboard()` hits `if (__ss.state.currentFileType !== 'fb_cookie') return;`
5. Every bubble tap does nothing — no toast, no feedback
6. User thinks clipboard automation is broken

**Root cause:** No type validation when bubble boots. The picker only shows `fb_cookie` files at enable time, but doesn't prevent type changes afterward.

**Solution:**

```js
// In js/bubble.js — boot function
function boot() {
    if (!__ss.currentUser) {
        if (++tries < 40) setTimeout(boot, 300);
        return;
    }
    __ss.openFile(fileId).then(function() {
        // Validate file type
        if (__ss.state.currentFileType !== 'fb_cookie') {
            __ss.showToast('Bubble file is not FB Cookie type — please re-enable bubble');
            return; // Don't start automation or refresh loop
        }
        __ss.bubbleRowLimit = 100;
        automateClipboard();
        window.setInterval(function() {
            if (__ss.refreshSheet) __ss.refreshSheet();
        }, 6000);
    });
}
```

---

### C3. ClipboardCaptureActivity Fails Silently

**Severity:** 🔴 Critical — clipboard automation dead

**Location:**
- `android/.../FloatingBubbleService.java:279-283` — try/catch swallows launch failure

**What happens:**
1. User taps bubble → `showPanel()` called
2. `startActivity(ClipboardCaptureActivity)` throws (rare but possible: activity not found, background start blocked on Android 12+, etc.)
3. Exception caught and ignored
4. `bubble_clip` pref never set
5. 700ms later, `bubbleAutomate()` runs → `readClipboard()` → direct read fails (no focus) → returns `""`
6. Retry loop runs 6 times over 2.4s → gives up
7. Toast: "Clipboard: no cookie or 2FA key found" — misleading

**Root cause:** Silent failure + no fallback + misleading error message.

**Solution:**

```java
// In FloatingBubbleService.java — showPanel
try {
    Intent cap = new Intent(this, ClipboardCaptureActivity.class);
    cap.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    startActivity(cap);
} catch (Exception e) {
    Log.w(TAG, "ClipboardCaptureActivity failed, using fallback", e);
    // Fallback: read clipboard directly (may fail without focus, but worth trying)
    try {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
            CharSequence cs = cm.getPrimaryClip().getItemAt(0).getText();
            String text = cs != null ? cs.toString() : "";
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(KEY_CLIP, text)
                .putLong(KEY_CLIP_AT, System.currentTimeMillis())
                .apply();
        }
    } catch (Exception ignored) {}
}
```

---

### C4. WebView Leak on Service Restart

**Severity:** 🔴 Critical — memory leak / stale state

**Location:**
- `android/.../FloatingBubbleService.java:399-407` — `hidePanel()` only pauses WebView
- `android/.../FloatingBubbleService.java:436-446` — `onDestroy()` destroys but service may not be destroyed

**What happens:**
1. User closes panel → `hidePanel()` calls `miniWebView.onPause()` but keeps instance
2. Android kills service (low memory) → `onDestroy()` may not be called
3. Service restarts (START_STICKY) → `onCreate()` → `ensureMiniWebView()` → returns old (possibly dead) WebView
4. Old WebView references destroyed context → crash or blank page

**Root cause:** WebView lifecycle not tied to service lifecycle. Pausing ≠ destroying.

**Solution:**

```java
// In FloatingBubbleService.java — rewrite hidePanel and ensureMiniWebView
private void hidePanel() {
    if (miniWebView != null) {
        try {
            miniWebView.loadUrl("about:blank"); // Clear content
            miniWebView.onPause();
        } catch (Exception ignored) {}
    }
    if (panelRoot != null) {
        try { windowManager.removeView(panelRoot); } catch (Exception ignored) {}
        panelRoot = null;
    }
}

private void ensureMiniWebView() {
    if (miniWebView != null) {
        // Check if WebView is still usable
        try {
            miniWebView.getUrl(); // throws if destroyed
            return;
        } catch (Exception e) {
            Log.w(TAG, "WebView unusable, recreating");
            try { miniWebView.destroy(); } catch (Exception ignored) {}
            miniWebView = null;
        }
    }
    try {
        miniWebView = new WebView(this);
        // ... rest of setup ...
    } catch (Exception e) {
        Log.e(TAG, "ensureMiniWebView failed", e);
        miniWebView = null;
    }
}
```

---

## High Issues

### H1. Empty Clipboard / Non-Text Clipboard

**Severity:** 🟠 High — silent failure, misleading UX

**Location:** `js/bubble.js:266-276`

**What happens:**
- User taps bubble with empty clipboard → retry loop → gives up silently
- User taps bubble with image in clipboard → `readClipboard()` returns `""` → same path
- No distinction between "empty clipboard" and "no cookie found"

**Solution:**

```js
// In js/bubble.js — automateClipboard
function automateClipboard() {
    if (_clipBusy) return;
    if (!__ss.state || !__ss.state.currentFileId) return;
    if (__ss.state.currentFileType !== 'fb_cookie') return;
    var t = readClipboardText().trim();
    if (!t) {
        var retries = automateClipboard.retries = (automateClipboard.retries || 0) + 1;
        if (retries <= 6) {
            setTimeout(automateClipboard, 400);
        } else {
            automateClipboard.retries = 0;
            __ss.showToast('Clipboard is empty — copy a cookie or 2FA key first');
        }
        return;
    }
    // ... rest of function ...
}
```

---

### H2. All Cells Full — No Empty Row

**Severity:** 🟠 High — dead end, user stuck

**Location:** `js/bubble.js:209-213`, `js/bubble.js:236-239`

**What happens:**
- `findEmptyCell('cookies')` returns -1 → "No empty cookie row" toast
- Bubble only shows 100 rows (padded)
- User can't add a row from mini window — no UI for it
- Dead end: can't save anything, can't add space

**Solution:**

```js
// In js/bubble.js — saveCookieToSheet
function saveCookieToSheet(text) {
    var dupe = findValueCell('cookies', text);
    if (dupe !== -1) {
        __ss.showToast('Duplicate cookie — already at row ' + (dupe + 1));
        return;
    }
    var idx = findEmptyCell('cookies');
    if (idx === -1) {
        // Auto-extend: add 100 more rows
        for (var i = 0; i < 100; i++) {
            __ss.state.rows.push(__ss.makeEmptyRow(__ss.state.COLUMNS));
        }
        idx = findEmptyCell('cookies');
        __ss.showToast('Added 100 more rows');
    }
    __ss.state.rows[idx].cookies = text;
    // ... rest of save logic ...
}
```

---

### H3. Session Expired in Mini WebView

**Severity:** 🟠 High — silent auth failure

**Location:** `android/.../FloatingBubbleService.java:376-379`

**What happens:**
- Session cookie expires (30 days or server-side invalidation)
- Mini WebView loads page → `openFile` returns 401 or empty
- `boot()` retries but `__ss.currentUser` may still be cached from before
- Sheet renders empty or with stale data
- Automation runs on empty rows → saves to wrong place or fails

**Solution:**

```js
// In js/bubble.js — boot function
function boot() {
    if (!__ss.currentUser) {
        if (++tries < 40) setTimeout(boot, 300);
        return;
    }
    __ss.openFile(fileId).then(function() {
        // Check if file loaded successfully
        if (!__ss.state.currentFileId || __ss.state.rows.length === 0) {
            if (++tries < 10) {
                setTimeout(boot, 1000);
            } else {
                __ss.showToast('Cannot load file — session may have expired');
            }
            return;
        }
        __ss.bubbleRowLimit = 100;
        automateClipboard();
        window.setInterval(function() {
            if (__ss.refreshSheet) __ss.refreshSheet();
        }, 6000);
    }).catch(function() {
        __ss.showToast('Failed to load bubble file');
    });
}
```

---

### H4. Rapid Bubble Taps (Double Panel)

**Severity:** 🟠 High — overlay stuck on screen

**Location:** `android/.../FloatingBubbleService.java:237-243`

**What happens:**
- Quick double-tap on bubble → `togglePanel()` → `showPanel()` called twice
- Two `panelRoot` views added to WindowManager
- Second `hidePanel()` only removes one (the field is overwritten)
- First panel stuck on screen — can't dismiss

**Solution:**

```java
// In FloatingBubbleService.java — add guard
private boolean panelShowing = false;

private void togglePanel() {
    if (panelRoot != null || panelShowing) {
        hidePanel();
    } else {
        showPanel();
    }
}

private void showPanel() {
    if (panelShowing) return; // Guard against re-entrancy
    panelShowing = true;
    try {
        // ... existing showPanel code ...
    } finally {
        panelShowing = false;
    }
}
```

---

### H5. Cookie-Only Account (No 2FA Key)

**Severity:** 🟠 High — UX confusion

**Location:** `js/bubble.js:285-291`

**What happens:**
- User copies a cookie → saved to sheet
- No TOTP generated (only happens for 2FA keys)
- User might expect some confirmation that cookie was saved
- Current toast "Cookie saved at row X" is fine, but no clipboard feedback

**Solution:**

```js
// In js/bubble.js — saveCookieToSheet (already shows toast, just enhance)
function saveCookieToSheet(text) {
    // ... existing dupe check ...
    // ... existing save logic ...
    __ss.showToast('Cookie saved at row ' + (idx + 1) + ' — copy a 2FA key next');
    // ... rest ...
}
```

---

### H6. 2FA Key Without Cookie

**Severity:** 🟠 High — orphaned data

**Location:** `js/bubble.js:225-258`

**What happens:**
- User copies 2FA key first → saved to `twofakey` column
- TOTP generated and copied to clipboard
- But `cookies` cell in that row is empty
- Row is half-useful, no linking between cookie and 2FA rows

**Solution:** This is a workflow design issue. The bubble saves to the next empty row for each column independently. Two options:

**Option A — Link cookie and 2FA in same row:**
```js
// When saving a 2FA key, check if the last cookie row has an empty twofakey cell
function saveKeyToSheet(text) {
    var key = normalizeKey(text);
    // ... existing dupe check ...

    // Try to find a row that has a cookie but no 2FA key
    var linkedIdx = -1;
    var rows = __ss.state.rows || [];
    for (var i = rows.length - 1; i >= 0; i--) {
        if (rows[i].cookies && !rows[i].twofakey) {
            linkedIdx = i;
            break;
        }
    }

    if (linkedIdx !== -1) {
        rows[linkedIdx].twofakey = key;
        // ... save logic ...
        __ss.showToast('2FA key paired with cookie at row ' + (linkedIdx + 1));
    } else {
        // Fall back to empty cell
        var idx = findEmptyCell('twofakey');
        // ... existing logic ...
    }
}
```

**Option B — Document the workflow:** Add a hint in the bubble UI explaining the order: copy cookie first, then copy 2FA key.

---

## Medium Issues

### M1. Bubble Toggle Resets If Picker Dismissed

**Severity:** 🟡 Medium — toggle state lies

**Location:** `js/bubble.js:22-29`, `js/bubble.js:69-71`

**What happens:**
- User toggles on → picker opens → user taps scrim to close without selecting
- Toggle is still `checked` visually but `enableBubble` was never called
- Toggle shows "on" but bubble service isn't running

**Solution:**

```js
// In js/bubble.js — toggle handler
toggle.addEventListener('change', function() {
    if (toggle.checked) {
        openPicker();
    } else {
        try { window.Android.disableBubble(); } catch(e) {}
        __ss.showToast('Floating bubble off');
    }
});

// In closePicker — reset toggle if picker was opened for enable
function closePicker(ov) {
    ov.classList.remove('open');
    setTimeout(function() {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        // If enabling but no file selected, reset toggle
        if (toggle && toggle.checked && !window.Android.isBubbleEnabled()) {
            toggle.checked = false;
        }
    }, 150);
}
```

---

### M2. No FB Cookie Files — Empty Picker

**Severity:** 🟡 Medium — same as M1 but specific case

**Location:** `js/bubble.js:76-79`

**Solution:** Same as M1 — reset toggle if picker dismissed without selection.

---

### M3. 700ms Hardcoded Delay

**Severity:** 🟡 Medium — timing fragility

**Location:** `android/.../FloatingBubbleService.java:288-297`

**What happens:**
- Assumes ClipboardCaptureActivity finishes in 700ms
- On slow devices: activity hasn't finished → clipboard read fails
- On fast devices: unnecessary delay

**Solution:**

```java
// In FloatingBubbleService.java — showPanel
// Wait for the capture activity to finish, then run automation
panelRoot.setFocusableInTouchMode(true);

// Poll for clipboard capture completion instead of fixed delay
final int[] pollCount = {0};
final Runnable[] pollRunnable = new Runnable[1];
pollRunnable[0] = new Runnable() {
    @Override
    public void run() {
        pollCount[0]++;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        long clipAt = prefs.getLong(KEY_CLIP_AT, 0);
        boolean captured = clipAt > 0 && System.currentTimeMillis() - clipAt < 2000;

        if (captured || pollCount[0] >= 10) { // Max 10 * 200ms = 2s
            try {
                panelRoot.requestFocus();
                if (miniWebView != null) miniWebView.requestFocus();
                miniWebView.evaluateJavascript(
                    "window.__ss&&window.__ss.bubbleAutomate&&window.__ss.bubbleAutomate();", null);
            } catch (Exception ignored) {}
        } else {
            panelRoot.postDelayed(this, 200);
        }
    }
};
panelRoot.postDelayed(pollRunnable[0], 200);
```

---

### M4. Clipboard Dedup Window Too Short

**Severity:** 🟡 Medium — inconsistent behavior

**Location:** `js/bubble.js:280`

**What happens:**
- Same cookie copied twice within 8s → silently ignored
- Wait 8s and tap again → re-saves (or says duplicate)

**Solution:** Increase window and make behavior consistent:

```js
// In js/bubble.js — automateClipboard
var now = Date.now();
if (_lastAutoText === t && now - _lastAutoAt < 15000) {
    __ss.showToast('Already saved this — copy something new');
    return;
}
```

---

### M5. Duplicate Detection Only Checks Exact Match

**Severity:** 🟡 Medium — duplicate data

**Location:** `js/bubble.js:204-208`

**What happens:**
- Same cookie with trailing whitespace → not detected as duplicate → saved again

**Solution:**

```js
// In js/bubble.js — findValueCell (normalize before comparing)
function findValueCell(colKey, value) {
    var rows = __ss.state.rows || [];
    var normalized = (value || '').trim();
    for (var i = 0; i < rows.length; i++) {
        if (rows[i][colKey] && (rows[i][colKey] || '').trim() === normalized) return i;
    }
    return -1;
}
```

---

### M6. Bubble Position Lost on Config Change

**Severity:** 🟡 Medium — minor annoyance

**Location:** `android/.../FloatingBubbleService.java:176-177`

**Solution:** Persist bubble position in SharedPreferences:

```java
// In FloatingBubbleService.java
private static final String KEY_X = "bubble_x";
private static final String KEY_Y = "bubble_y";

// In addBubbleToWindow — restore position
SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
bubbleParams.x = prefs.getInt(KEY_X, Math.max(0, displayWidth() - windowSize - dp(16)));
bubbleParams.y = prefs.getInt(KEY_Y, dp(220));

// In bubbleTouchListener ACTION_UP — save position
SharedPreferences.Editor editor = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit();
editor.putInt(KEY_X, bubbleParams.x);
editor.putInt(KEY_Y, bubbleParams.y);
editor.apply();
```

---

### M7. No File Name Shown in Mini Window

**Severity:** 🟡 Medium — user confusion

**Location:** `js/bubble.js:111-131`

**Solution:** Add a small file name indicator in bubble mode. In `bubble.js`:

```js
if (BUBBLE_MODE) {
    document.body.classList.add('bubble-mode');
    var fileId = QS.get('file');

    // Add file name indicator
    var nameBar = document.createElement('div');
    nameBar.id = 'bubbleFileName';
    nameBar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:var(--bg2);color:var(--text2);font-size:11px;padding:4px 8px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    nameBar.textContent = 'Loading...';
    document.body.appendChild(nameBar);

    function boot() {
        // ... existing boot code ...
        __ss.openFile(fileId).then(function() {
            if (nameBar && __ss.state.currentFileId) {
                // Fetch file name
                __ss.api.getFile(fileId).then(function(f) {
                    if (f && f.name) nameBar.textContent = f.name;
                });
            }
        });
    }
}
```

---

### M8. Mini WebView Zoom 0.7 Touch Targets

**Severity:** 🟡 Medium — usability

**Location:** `css/bubble.css` (body.bubble-mode)

**Solution:** Increase minimum touch target sizes in bubble mode:

```css
/* In css/bubble.css */
body.bubble-mode .rh,
body.bubble-mode .ch {
    min-width: 44px;
    min-height: 44px;
}
body.bubble-mode .row-dot {
    width: 16px;
    height: 16px;
}
```

---

## Low Issues

### L1. Bubble Shows During Phone Call

**Severity:** 🟢 Low — rare annoyance

**Solution:** Detect phone call state and hide bubble:

```java
// In FloatingBubbleService.java
private PhoneStateListener phoneStateListener;

private void initPhoneStateListener() {
    TelephonyManager tm = (TelephonyManager) getSystemService(Context.TELEPHONY_SERVICE);
    if (tm != null) {
        phoneStateListener = new PhoneStateListener() {
            @Override
            public void onCallStateChanged(int state, String phoneNumber) {
                if (state == TelephonyManager.CALL_STATE_OFFHOOK ||
                    state == TelephonyManager.CALL_STATE_RINGING) {
                    hideBubble();
                } else {
                    showBubble();
                }
            }
        };
        tm.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE);
    }
}
```

---

### L2. Notification Can't Be Dismissed

**Severity:** 🟢 Low — expected FGS behavior

**Solution:** This is by design for foreground services. No change needed, but could add an action button to disable bubble:

```java
// In startAsForeground — add action
Intent disableIntent = new Intent(this, FloatingBubbleService.class);
disableIntent.setAction("STOP_BUNDLE");
PendingIntent disablePi = PendingIntent.getService(this, 1, disableIntent, PendingIntent.FLAG_IMMUTABLE);

Notification n = new Notification.Builder(this, CHANNEL_ID)
    // ... existing ...
    .addAction(R.mipmap.ic_launcher, "Disable bubble", disablePi)
    .build();
```

---

### L3. Clipboard Capture Writes Empty String

**Severity:** 🟢 Low — minor edge case

**Location:** `android/.../ClipboardCaptureActivity.java:42-46`

**Solution:** Don't update timestamp if clipboard is empty:

```java
// In ClipboardCaptureActivity.java
if (!text.isEmpty()) {
    getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        .edit()
        .putString(KEY_CLIP, text)
        .putLong(KEY_CLIP_AT, System.currentTimeMillis())
        .apply();
}
```

---

### L4. No Way to Change Bubble File Without Disabling First

**Severity:** 🟢 Low — UX friction

**Solution:** Add a "Change file" option in the gear menu when bubble is enabled:

```js
// In js/bubble.js — add change file button to picker
ov.querySelector('#bubbleCreateBtn').addEventListener('click', function() {
    // ... existing create logic ...
});

// Add a "Change file" row in gear menu when enabled
if (APP && row && toggle) {
    // ... existing code ...
    if (toggle.checked) {
        var changeBtn = document.createElement('button');
        changeBtn.className = 'gear-toggle-row';
        changeBtn.innerHTML = '<span>Change bubble file</span>';
        changeBtn.addEventListener('click', function() {
            openPicker();
        });
        row.parentNode.insertBefore(changeBtn, row.nextSibling);
    }
}
```

---

### L5. Uri.encode on File ID

**Severity:** 🟢 Low — rare edge case

**Location:** `android/.../FloatingBubbleService.java:378`

**Solution:** Use Uri.encode only on the value, not the whole URL:

```java
// Already correct: Uri.encode(fileId) only encodes the file ID value
String url = HOME_URL + "/?bubble=1&file=" + Uri.encode(fileId);
```

This is actually fine — `Uri.encode` is designed for query parameter values. No change needed unless file IDs contain unusual characters.

---

### L6. Bubble Enabled With No Overlay Permission

**Severity:** 🟢 Low — edge case

**Location:** `android/.../FloatingBubbleService.java:77-82`

**Solution:** Add feedback when service stops due to missing permission:

```java
// In FloatingBubbleService.java — onCreate
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !android.provider.Settings.canDrawOverlays(this)) {
    Log.e(TAG, "overlay permission missing, stopping");
    // Clear the pref so toggle resets
    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().remove(KEY_FILE).apply();
    // Notify user
    new Handler(Looper.getMainLooper()).post(() -> {
        Toast.makeText(this, "Overlay permission required for bubble", Toast.LENGTH_LONG).show();
    });
    stopSelf();
    return;
}
```

---

## Implementation Guide

### Priority Order

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| 1 | C1 — File deletion cleanup | Medium | Prevents infinite error loop |
| 2 | H4 — Rapid tap guard | Low | Prevents stuck overlay |
| 3 | M1 — Toggle state sync | Low | Prevents lying UI |
| 4 | C2 — File type validation | Low | Prevents silent automation death |
| 5 | H2 — Auto-extend rows | Low | Removes dead end |
| 6 | C3 — Clipboard capture fallback | Medium | Improves reliability |
| 7 | H1 — Empty clipboard feedback | Low | Better UX |
| 8 | M3 — Polling instead of fixed delay | Medium | More reliable automation |
| 9 | C4 — WebView lifecycle | Medium | Prevents memory leak |
| 10 | H3 — Session expiry handling | Medium | Better error recovery |

### Files to Modify

| File | Changes |
|------|---------|
| `js/bubble.js` | Boot validation, toggle sync, auto-extend rows, better feedback |
| `js/home.js` | Delete file cleanup, bubble pref clearing |
| `android/.../FloatingBubbleService.java` | Position persistence, rapid tap guard, WebView lifecycle, phone state |
| `android/.../ClipboardCaptureActivity.java` | Empty clipboard handling |
| `android/.../MainActivity.java` | `getBubbleFile()` bridge method |
| `css/bubble.css` | Touch target sizes |

### Testing Checklist

- [ ] Enable bubble → archive file → bubble should disable + toast
- [ ] Enable bubble → change file type → bubble should show warning
- [ ] Rapid double-tap bubble → only one panel should appear
- [ ] Toggle on → dismiss picker → toggle should reset to off
- [ ] Empty clipboard → tap bubble → "clipboard empty" toast
- [ ] All cells full → tap bubble with cookie → auto-extends rows
- [ ] Session expired → bubble shows error toast
- [ ] Bubble position persists across service restart
- [ ] Phone call → bubble hides, returns after call
- [ ] Clipboard capture activity crash → fallback works

---

*Generated: 2026-08-11*
