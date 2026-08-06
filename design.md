# Design System — SheetSubmit (Vercel Geist)

A minimal, utility-driven design system for web apps. Zero dependencies, pure CSS custom properties, light/dark theme support, responsive by default.

---

## 1. Fonts

```html
<!-- CDN preload -->
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
```

Two typefaces loaded via `@font-face` from jsDelivr:

| Family | Weights | Use |
|--------|---------|-----|
| **Geist Sans** | 400, 500, 600, 700 | UI text, labels, headings |
| **Geist Mono** | 400, 500, 600, 700 | Code, monospace data, status values |

Fallback stack:
```css
--sans: 'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--mono: 'Geist Mono', 'SF Mono', 'Fira Code', monospace;
```

CDN URLs (pin version as needed):
```
https://cdn.jsdelivr.net/npm/geist@1.7.2/dist/fonts/geist-sans/Geist-Regular.woff2
https://cdn.jsdelivr.net/npm/geist@1.7.2/dist/fonts/geist-mono/GeistMono-Regular.woff2
```

---

## 2. Design Tokens

### Light theme (`:root`)

```css
:root {
  /* Backgrounds */
  --bg:  #ffffff;
  --bg2: #fafafa;
  --bg3: #f5f5f5;
  --bg4: #eaeaea;

  /* Text */
  --text:  #000000;
  --text2: #666666;
  --text3: #999999;

  /* Borders */
  --border:  #eaeaea;
  --border2: #d4d4d4;

  /* Brand */
  --blue:       #0070f3;
  --blue-dark:  #0060df;
  --blue-light: rgba(0, 112, 243, 0.08);
  --red:        #ee0000;
  --red-bg:     rgba(238, 0, 0, 0.08);
  --green:      #00b4d8;
  --green-dark: #0096b7;
  --green-bg:   rgba(0, 180, 216, 0.08);
  --yellow:     #f5a623;
  --yellow-bg:  rgba(245, 166, 35, 0.08);

  /* Selection */
  --sel-bg:     rgba(0, 112, 243, 0.08);
  --sel-border: rgba(0, 112, 243, 0.4);
  --sel-outline:#0070f3;

  /* Focus ring */
  --focus-ring: 0 0 0 2px #0070f3;

  /* Shape */
  --r:  6px;   /* default radius */
  --rl: 8px;   /* large radius (cards, modals) */

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.12);

  /* Overlays */
  --overlay-light: rgba(0, 0, 0, 0.25);
  --overlay-mid:   rgba(0, 0, 0, 0.35);
  --overlay-dark:  rgba(0, 0, 0, 0.45);

  /* Easing */
  --ease-out:      cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out:   cubic-bezier(0.45, 0, 0.55, 1);
  --ease-drawer:   cubic-bezier(0.32, 0.72, 0, 1);
}
```

### Dark theme (`[data-theme="dark"]`)

```css
[data-theme="dark"] {
  --bg:  #000000;
  --bg2: #0a0a0a;
  --bg3: #111111;
  --bg4: #1a1a1a;

  --text:  #ededed;
  --text2: #888888;
  --text3: #666666;

  --border:  #222222;
  --border2: #333333;

  --blue-light: rgba(0, 112, 243, 0.15);
  --red-bg:     rgba(238, 0, 0, 0.15);
  --green-bg:   rgba(0, 180, 216, 0.15);
  --yellow-bg:  rgba(245, 166, 35, 0.15);
  --sel-bg:     rgba(0, 112, 243, 0.15);
  --sel-border: rgba(0, 112, 243, 0.5);

  --overlay-light: rgba(0, 0, 0, 0.5);
  --overlay-mid:   rgba(0, 0, 0, 0.6);
  --overlay-dark:  rgba(0, 0, 0, 0.7);

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.4);
}
```

---

## 3. CSS Reset

```css
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  height: 100%;
  overflow: hidden;
}

body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  display: flex;
  flex-direction: column;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

button, input, select, textarea {
  touch-action: manipulation;
  font-family: var(--sans);
}
```

---

## 4. Keyframes

```css
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes slideUp {
  from { transform: translateY(56px); opacity: 0; }
  to   { transform: translateY(0); opacity: 1; }
}

@keyframes mIn {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes smIn {
  from { opacity: 0; transform: translateY(-6px) scale(0.95); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}
```

### Staggered fade-in for lists (cards, grid items)

```css
.file-card { opacity: 0; animation: fadeIn 0.2s var(--ease-out) forwards; }
.file-card:nth-child(1) { animation-delay: 0ms; }
.file-card:nth-child(2) { animation-delay: 30ms; }
.file-card:nth-child(3) { animation-delay: 60ms; }
.file-card:nth-child(4) { animation-delay: 90ms; }
.file-card:nth-child(5) { animation-delay: 120ms; }
.file-card:nth-child(6) { animation-delay: 150ms; }
.file-card:nth-child(n + 7) { animation-delay: 180ms; }
```

---

## 5. Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 6. Layout

### Topbar (48px fixed height)

```css
.topbar {
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  padding: 0 16px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
```

Left/right sections:
```css
.topbar-l { display: flex; align-items: center; gap: 8px; min-width: 0; }
.topbar-r { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
```

### Home tabs

```css
.home-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  padding: 0 24px;
}

.home-tab {
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text3);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
  margin-bottom: -1px;
}

.home-tab.active {
  color: var(--text);
  border-bottom-color: #000;
}
[data-theme="dark"] .home-tab.active {
  border-bottom-color: #fff;
}
```

### Content panes

```css
.home-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

#homePaneFiles, #homePaneArchive {
  padding: 32px 24px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
}

@media (max-width: 480px) {
  #homePaneFiles, #homePaneArchive { padding: 20px 14px; }
}
```

### Responsive grid (file cards)

```css
.files-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

@media (max-width: 480px) {
  .files-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }
}
```

---

## 7. Components

### File card

```css
.file-card {
  border: 1px solid var(--border);
  border-radius: var(--rl);
  background: var(--bg);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
  min-height: 110px;
}

@media (hover: hover) and (pointer: fine) {
  .file-card:hover {
    border-color: var(--text3);
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
  }
}

.file-card:active { transform: scale(0.99); }

.file-card-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-card-meta { font-size: 12px; color: var(--text3); }
```

### Buttons

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--r);
  border: 1px solid var(--border2);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s, transform 0.1s;
  white-space: nowrap;
  line-height: 1.4;
}

.btn:hover:not(:disabled) { background: var(--bg3); border-color: var(--text3); }
.btn:active:not(:disabled) { transform: scale(0.98); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-primary { background: #000; color: #fff; border-color: #000; }
[data-theme="dark"] .btn-primary { background: #fff; color: #000; border-color: #fff; }

.btn-ghost { background: transparent; border-color: var(--border2); color: var(--text2); }
.btn-ghost:hover:not(:disabled) { background: var(--bg3); color: var(--text); }

.btn-danger { background: var(--red); color: #fff; border-color: var(--red); }
.btn-danger:hover:not(:disabled) { background: #cc0000; border-color: #cc0000; }

.btn-sm { padding: 4px 8px; font-size: 12px; }
```

Focus visible:
```css
.btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
```

### Icon buttons (32x32 square)

```css
.undo-redo-btn, .gear-btn, .profile-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text3);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}

.undo-redo-btn:hover:not(:disabled) { background: var(--bg3); color: var(--text); }
```

### Modal

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-light);
  z-index: 700;
  display: none;
  align-items: center;
  justify-content: center;
}

.modal-overlay.open { display: flex; }

.modal-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rl);
  padding: 20px;
  width: 320px;
  box-shadow: var(--shadow-lg);
  animation: mIn 0.2s var(--ease-out);
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
}

.modal-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  border: 1px solid var(--border2);
  border-radius: var(--r);
  background: var(--bg);
  color: var(--text);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.modal-input:focus { border-color: #000; box-shadow: var(--focus-ring); }
[data-theme="dark"] .modal-input:focus { border-color: #fff; }

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
```

### Toast

```css
.toast-wrap {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  pointer-events: none;
}

.toast {
  background: #000;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 8px;
  opacity: 0;
  transition: opacity 0.2s, transform 0.2s;
  transform: translateY(8px) scale(0.96);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.toast.show { opacity: 1; transform: translateY(0) scale(1); }
[data-theme="dark"] .toast { background: #fff; color: #000; }
```

### Toggle switch

```css
.toggle-switch {
  position: relative;
  width: 36px;
  height: 20px;
}

.toggle-switch input { opacity: 0; width: 0; height: 0; position: absolute; }

.toggle-track {
  position: absolute;
  inset: 0;
  background: var(--bg4);
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.2s;
  border: 1px solid var(--border2);
}

.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px; left: 2px;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--text3);
  transition: transform 0.2s, background 0.2s;
}

.toggle-switch input:checked + .toggle-track {
  background: #000;
  border-color: #000;
}

.toggle-switch input:checked + .toggle-track::after {
  transform: translateX(16px);
  background: #fff;
}

[data-theme="dark"] .toggle-switch input:checked + .toggle-track {
  background: #fff;
  border-color: #fff;
}

[data-theme="dark"] .toggle-switch input:checked + .toggle-track::after {
  background: #000;
}
```

### Selection bar (bottom action bar)

```css
.sel-bar {
  position: fixed;
  z-index: 600;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: none;
  align-items: center;
  padding: 6px 6px 6px 14px;
  gap: 6px;
  box-shadow: var(--shadow-lg);
  left: 8px; right: 8px; bottom: 5vh;
}

.sel-bar.open { display: flex; }

.sel-btn {
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text2);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: var(--r);
  cursor: pointer;
  transition: background 0.1s;
}

.sel-btn:hover { background: var(--bg4); color: var(--text); }
.sel-btn.danger { color: var(--red); border-color: var(--red); background: var(--red-bg); }
```

### Context popup

```css
.file-ctx-popup {
  position: fixed;
  z-index: 800;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rl);
  padding: 4px;
  width: 140px;
  box-shadow: var(--shadow-lg);
  transform: translateY(4px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s, transform 0.12s;
}

.file-ctx-popup.open { opacity: 1; pointer-events: all; transform: translateY(0); }

.file-ctx-item {
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  color: var(--text);
  border-radius: 4px;
  transition: background 0.08s;
}

.file-ctx-item:hover { background: var(--bg3); }
.file-ctx-item.danger { color: var(--red); }
.file-ctx-item.danger:hover { background: var(--red-bg); }
```

### Status badge

```css
.conn-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.conn-status.ok { color: var(--green); background: var(--green-bg); }
.conn-status.err { color: var(--red); background: var(--red-bg); }

.conn-status-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
}
```

### Badge

```css
.file-type-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--text3);
  background: var(--bg3);
  padding: 2px 6px;
  border-radius: 4px;
  display: inline-block;
}

.file-type-badge.t-ig { color: var(--blue); background: var(--blue-light); }
```

### FAB (floating action button)

```css
.home-fab {
  position: fixed;
  bottom: 28px;
  right: 24px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #000;
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  z-index: 200;
  transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
}

[data-theme="dark"] .home-fab { background: #fff; color: #000; }
.home-fab:hover { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); }
.home-fab:active { transform: scale(0.95); }
```

### Empty state

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}

.empty-state svg { color: var(--text3); opacity: 0.3; margin-bottom: 16px; }
.empty-state-title { font-size: 14px; font-weight: 600; color: var(--text2); margin-bottom: 4px; }
.empty-state-sub { font-size: 13px; color: var(--text3); }
```

### User profile button (circular)

```css
.profile-btn {
  overflow: hidden;
  border-radius: 50%;
  border: 1.5px solid var(--border);
  transition: border-color 0.15s;
}

.profile-btn:hover { border-color: var(--text3); }

.gear-user-avatar {
  width: 38px; height: 38px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--border);
}
```

### Settings dropdown panel

```css
.gear-settings-panel {
  position: fixed;
  top: 48px;
  right: 8px;
  z-index: 800;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--rl);
  padding: 12px 16px;
  width: 220px;
  box-shadow: var(--shadow-lg);
  transform: translateY(4px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s, transform 0.15s;
}

.gear-settings-panel.open {
  opacity: 1;
  pointer-events: all;
  transform: translateY(0);
}

.gear-settings-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.gear-divider { height: 1px; background: var(--border); margin: 8px 0; }
```

---

## 8. Grid / Table (data spreadsheet)

```css
table.grid {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  user-select: none;
}

table.grid th, table.grid td { border: 1px solid var(--border); }

/* Row header */
table.grid th.rh {
  width: 36px;
  background: var(--bg2);
  font-size: 11px;
  color: var(--text3);
  text-align: center;
  position: sticky;
  left: 0;
  z-index: 4;
}

/* Column header */
table.grid th.ch {
  background: var(--bg2);
  font-size: 12px;
  color: var(--text2);
  font-weight: 600;
  text-align: center;
  height: 36px;
  position: sticky;
  top: 0;
  z-index: 3;
}

/* Data cell */
table.grid td.dc {
  height: 36px;
  padding: 0;
  font-size: 13px;
  font-family: var(--mono);
  background: var(--bg);
  overflow: hidden;
}

/* Selection states */
td.dc.ms-sel {
  background: var(--sel-bg) !important;
  outline: 1px solid var(--sel-border);
}

th.ch.col-sel, th.rh.row-sel {
  background: var(--sel-bg) !important;
  color: var(--blue) !important;
}
```

---

## 9. Login Screen

```css
.login-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  position: relative;
}

/* Subtle gradient background */
.login-wrap::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 60% 50% at 50% 0%, var(--blue-light) 0%, transparent 60%),
    radial-gradient(ellipse 40% 35% at 80% 80%, rgba(0,180,216,0.04) 0%, transparent 50%);
  pointer-events: none;
}

.login-card {
  width: 100%;
  max-width: 380px;
  text-align: center;
  animation: loginFadeIn 0.5s var(--ease-out) both;
}

@keyframes loginFadeIn {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.login-logo {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: var(--text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  box-shadow: var(--shadow-md);
}

.login-card h1 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.03em;
  margin: 0 0 24px;
}

.login-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 14px 20px;
  border-radius: 10px;
  background: var(--text);
  color: var(--bg);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: opacity 0.15s ease, transform 0.15s ease;
  border: none;
  cursor: pointer;
}

.login-btn:hover { opacity: 0.85; transform: translateY(-1px); }
.login-btn:active { transform: translateY(0); }
.login-btn.loading { opacity: 0.5; pointer-events: none; }
```

---

## 10. Theme Toggle (JS)

```js
(function() {
  var THEME_KEY = 'myapp_theme';

  function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'light';
  }

  function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
  }

  function toggleTheme() {
    var current = getTheme();
    var next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
    return next;
  }

  // Expose + apply on load
  window.__theme = { getTheme, setTheme, toggleTheme };
  setTheme(getTheme());
})();
```

Wire a toggle:
```js
var toggle = document.getElementById('themeToggle');
toggle.checked = window.__theme.getTheme() === 'dark';
toggle.addEventListener('change', function() {
  window.__theme.setTheme(this.checked ? 'dark' : 'light');
});
```

---

## 11. Typography Scale

| Token | Size | Weight | Spacing | Use |
|-------|------|--------|---------|-----|
| `h1` | 22px | 700 | -0.03em | Page titles |
| `h2` | 16px | 700 | -0.02em | Section headers |
| `title` | 14px | 600 | -0.01em | Card titles, modal titles |
| `body` | 13px | 500 | - | Body text, labels |
| `small` | 12px | 400 | - | Meta, timestamps |
| `caption` | 11px | 600 | 0.05em | Uppercase labels |
| `badge` | 10px | 600 | - | Badges, chips |
| `mono` | 13px | 400 | - | Code, data cells |

---

## 12. Spacing

| Token | Value | Use |
|-------|-------|-----|
| xs | 4px | Icon padding, inline gaps |
| sm | 8px | Tight gaps, mini padding |
| md | 12px | Card padding, grid gap |
| lg | 16px | Modal padding, card gap |
| xl | 20px | Section padding |
| 2xl | 24px | Page padding |
| 3xl | 32px | Large section padding |

---

## 13. Shadows

| Token | Value | Use |
|-------|-------|-----|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.04)` | Subtle lift |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.08)` | Card hover |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.12)` | Popups, modals, FABs |

---

## 14. Easing

| Token | Value | Use |
|-------|-------|-----|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Default for UI transitions |
| `--ease-in-out` | `cubic-bezier(0.45, 0, 0.55, 1)` | Symmetric motion |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | Slide-in panels |

Standard transition timing: `0.1s` for micro-interactions, `0.15s` for hover/focus, `0.2s` for enter/exit animations.

---

## 15. Interaction Patterns

### Hover lift (cards, list items)
```css
@media (hover: hover) and (pointer: fine) {
  .card:hover { border-color: var(--text3); box-shadow: var(--shadow-md); transform: translateY(-1px); }
}
.card:active { transform: scale(0.99); }
```

### Press scale (buttons)
```css
.btn:active { transform: scale(0.98); }
```

### Slide-up enter (bottom bars, FABs)
```css
.bar { animation: slideUp 0.2s var(--ease-out) both; }
```

### Fade-in overlay (modals, dropdowns)
```css
.modal-overlay { animation: fadeIn 0.15s var(--ease-out); }
.modal-box { animation: mIn 0.2s var(--ease-out); }
```

---

## 16. File Structure

```
css/
├── base.css         # Reset, tokens, fonts, keyframes, login screen, a11y
├── layout.css       # Topbar, views, grid, file cards, tabs, FAB, admin
├── components.css   # Buttons, modals, toasts
├── dashboard.css    # Profile button, settings panel, toggle switch
└── touch.css        # Touch device overrides
```

### Load order in `<head>`
```html
<link rel="stylesheet" href="css/base.css" />
<link rel="stylesheet" href="css/layout.css" />
<link rel="stylesheet" href="css/touch.css" />
<link rel="stylesheet" href="css/components.css" />
<link rel="stylesheet" href="css/dashboard.css" />
```

---

## 17. Quick Start (copy-paste)

To use this system in a new project:

1. Copy all 5 CSS files
2. Add `data-theme="dark"` to `<html>` for dark mode (or leave blank for light)
3. Set `lang="en"` and the viewport meta tag
4. Link the CSS files in the order above
5. Include the theme.js snippet to enable toggle persistence
6. Use the token variables (`--bg`, `--text`, `--border`, etc.) in your own styles
