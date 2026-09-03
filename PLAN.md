# Plan: FAB File-Type Presets (Cookie / Combo / Page)

## Goal
FAB shows **1 platform** (Facebook) with **3 file presets** underneath. Each preset creates a file with a different column set:

| Preset | Columns | Description |
|--------|---------|-------------|
| Cookie Only | `cookies`, `uid` | No 2FA, no page |
| Combo (Cookie+2FA) | `cookies`, `twofakey`, `uid` | Has 2FA, no page |
| Page | `cookies`, `twofakey`, `uid` + page columns | Full (future) |

**No backend changes needed.** `SheetFile.columns` already exists, is mutable via `PUT /api/files/:id`, and stored in the DO. The sheetStore just needs to respect it.

---

## Files to change

### 1. `Pages/src/lib/types.ts` — define column presets

Add a `COLUMN_PRESETS` map with the 3 column sets. Keep `FileType` as `fb_cookie` (single type).

```ts
export type FilePreset = "cookie" | "combo" | "page";

export const COLUMN_PRESETS: Record<FilePreset, ColumnDef[]> = {
  cookie: [
    { key: "cookies", label: "cookies", width: 340 },
    { key: "uid", label: "uid", width: 120 },
  ],
  combo: [
    { key: "cookies", label: "cookies", width: 340 },
    { key: "twofakey", label: "2fa key", width: 200 },
    { key: "uid", label: "uid", width: 120 },
  ],
  page: FILE_TYPE_DEFS.fb_cookie.columns, // full set — same as current default
};
```

### 2. `Pages/src/components/home/Fab.tsx` — 3 Facebook buttons

Replace the single "Facebook" `home-fab-item` with a **platform header** ("Facebook") + **3 sub-items** (Cookie Only, Combo, Page). Each sub-item calls `onCreate` with a `FilePreset`.

Update props:
```ts
interface FabProps {
  onCreate: (preset: FilePreset) => void;  // was FileType
  onUpload: (file: File) => void;
}
```

Structure:
```
[Facebook header - non-clickable, just label]
  → Cookie Only (cookies, uid)
  → Combo (cookies, 2fa, uid)
  → Page (full columns)
[separator]
[Upload xlsx]
```

### 3. `Pages/src/lib/api.ts` — pass `columns` in createFile

Add `columns?: ColumnDef[]` to `createFile` params:
```ts
createFile: (data: { id: string; name: string; type: FileType; password?: string; poolEnabled?: boolean; rows?: Row[]; dataCount?: number; columns?: ColumnDef[] }) =>
```

### 4. `Pages/src/pages/HomePage.tsx` — pass preset columns to API

Update `openCreatePw` to accept `FilePreset` and pass the preset's columns:

```ts
const openCreatePw = async (type: FileType, preset?: FilePreset) => {
  // ... existing password logic ...
  const columns = preset ? COLUMN_PRESETS[preset] : undefined;
  created = await api.createFile({ id, name: finalName, type, password, poolEnabled, columns });
};

const createFile = async (preset: FilePreset) => openCreatePw("fb_cookie", preset);
```

### 5. `Pages/src/stores/sheetStore.ts` — respect `file.columns`

Two places load columns (lines ~420 and ~530). Change both from:
```ts
const columns = fileTypeDef(f.type).columns;
```
to:
```ts
const columns = f.columns ?? fileTypeDef(f.type).columns;
```

This is the only backend-facing change: the sheetStore now reads per-file columns if they exist, falling back to the type default.

### 6. `Pages/src/app.css` — minor styling

Add a `.home-fab-platform` label style for the "Facebook" header row (non-clickable, smaller text, muted color). Sub-items use same `.home-fab-item` with slight indent or smaller size.

---

## What stays the same
- **Backend** — zero changes. `columns` is already in `MUTABLE_FILE_FIELDS`, stored in DO, returned in file responses
- **Pool logic** — unaffected (operates on row data, not columns)
- **Cross-file dedup** — unaffected (same `type: "fb_cookie"` for all 3)
- **Download opts** — unaffected (filters on row data)
- **Bubble mode** — unaffected (reads `twofakey`/`wa_status` from row data regardless of column visibility)
- **Upload/import** — stays as-is (imports full column set, user can adjust columns after)

---

## Verification
1. `bun run --cwd Pages typecheck` — no TS errors
2. Manual: FAB shows 3 Facebook sub-options
3. Manual: Create each preset → verify correct columns in sheet grid
4. Manual: Open a file created with preset → verify columns match preset
5. Manual: Old files (no `columns` field) → still show default 3 columns
