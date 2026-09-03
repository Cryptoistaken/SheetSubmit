import { api } from "./api";
import { exportCellValue, FILE_TYPE_DEFS } from "./types";
import type { ColumnDef, FileType, Row, WaCacheEntry } from "./types";

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

export interface ImportXlsxResult {
  id: string;
  name: string;
  type: FileType;
  rows: Row[];
  dataCount: number;
}

export async function importXlsx(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  existingFiles: { name: string }[],
): Promise<ImportXlsxResult> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
  if (json.length < 1) throw new Error("File is empty");
  const headers = (json[0] || []).map((h) => String(h).toLowerCase().trim());

  let typeKey: FileType = "fb_cookie";
  let bestMatch = 0;
  for (const tk of Object.keys(FILE_TYPE_DEFS) as FileType[]) {
    const tdef = FILE_TYPE_DEFS[tk];
    const matches = tdef.columns.filter(
      (c) =>
        headers.indexOf(c.key.toLowerCase()) !== -1 ||
        headers.indexOf(c.label.toLowerCase()) !== -1,
    );
    if (matches.length > bestMatch) {
      bestMatch = matches.length;
      typeKey = tk;
    }
  }

  const td = FILE_TYPE_DEFS[typeKey];
  let colMap: { key: string; idx: number }[];
  let dataStart: number;
  if (bestMatch > 0) {
    colMap = td.columns
      .map((c) => {
        let idx = headers.indexOf(c.key.toLowerCase());
        if (idx === -1) idx = headers.indexOf(c.label.toLowerCase());
        return { key: c.key, idx };
      })
      .filter((cm) => cm.idx !== -1);
    dataStart = 1;
  } else {
    let isFb = false;
    for (let si = 0; si < Math.min(3, json.length); si++) {
      const rowVals = json[si] || [];
      for (let sj = 0; sj < rowVals.length; sj++) {
        const val = String(rowVals[sj]).toLowerCase();
        if (val.indexOf("c_user=") !== -1 || val.indexOf("ds_user_id=") !== -1) {
          isFb = true;
          break;
        }
      }
      if (isFb) break;
    }
    if (isFb) typeKey = "fb_cookie";
    colMap = td.columns.map((c, i) => ({ key: c.key, idx: i }));
    dataStart = 0;
  }

  const rows: Row[] = [];
  for (let i = dataStart; i < json.length; i++) {
    const row: Row = {};
    let hasData = false;
    const source = json[i] || [];
    for (const cm of colMap) {
      const val = source[cm.idx] || "";
      row[cm.key] = String(val);
      if (val) hasData = true;
    }
    if (hasData) rows.push(row);
  }

  if (typeKey === "fb_cookie") {
    for (const r of rows) {
      if (!r.uid && r.cookies) {
        const m = r.cookies.match(/c_user=(\d+)/);
        if (m) r.uid = m[1];
      }
    }
  }

  if (rows.length === 0) throw new Error("No data rows found");

  let name = fileName.replace(/\.xlsx?$/i, "") || "Import " + todayStr();
  if (existingFiles.some((f) => f.name === name)) {
    name = name + " (" + genId().slice(0, 4) + ")";
  }
  const id = genId();

  return { id, name, type: typeKey, rows, dataCount: rows.length };
}

export async function buildXlsx(rows: Row[], columns: ColumnDef[]): Promise<ArrayBuffer> {
  const XLSX = await import("xlsx");
  const data: string[][] = [];
  rows.forEach((row) => {
    const isEmpty = columns.every((c) => !row[c.key]);
    if (!isEmpty) data.push(columns.map((c) => exportCellValue(c.key, row[c.key])));
  });
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

function isNativeWebView(): boolean {
  const w = window as unknown as { Android?: { download?: unknown } };
  return typeof w.Android?.download === "function";
}

function arrBufToDataUrl(buf: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return "data:" + mime + ";base64," + btoa(binary);
}

export async function downloadXlsx(
  rows: Row[],
  columns: ColumnDef[],
  fileName: string,
): Promise<void> {
  const buf = await buildXlsx(rows, columns);
  const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const name = (fileName || "export") + ".xlsx";
  if (isNativeWebView()) {
    (window as unknown as { Android: { download: (n: string, d: string) => void } })
      .Android.download(name, arrBufToDataUrl(buf, mime));
    return;
  }
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Parse the first sheet of an xlsx into rows for an open file (old sheet.js
 * header detection: match column key/label on row 0, else positional). */
export async function parseSheetRows(
  arrayBuffer: ArrayBuffer,
  columns: ColumnDef[],
): Promise<Row[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
  if (json.length < 1) throw new Error("File is empty");
  const headers = (json[0] || []).map((h) => String(h).toLowerCase().trim());
  let colMap: { key: string; idx: number }[];
  let dataStart: number;
  const matchedCols = columns.filter(
    (c) =>
      headers.indexOf(c.key.toLowerCase()) !== -1 ||
      headers.indexOf(c.label.toLowerCase()) !== -1,
  );
  if (matchedCols.length > 0) {
    colMap = matchedCols.map((c) => {
      let idx = headers.indexOf(c.key.toLowerCase());
      if (idx === -1) idx = headers.indexOf(c.label.toLowerCase());
      return { key: c.key, idx };
    });
    dataStart = 1;
  } else {
    colMap = columns.map((c, i) => ({ key: c.key, idx: i }));
    dataStart = 0;
  }
  const rows: Row[] = [];
  for (let i = dataStart; i < json.length; i++) {
    const row: Row = {};
    let hasData = false;
    const source = json[i] || [];
    colMap.forEach((cm) => {
      const val = source[cm.idx] || "";
      row[cm.key] = String(val);
      if (val) hasData = true;
    });
    if (hasData) rows.push(row);
  }
  if (rows.length === 0) throw new Error("No data rows found");
  return rows;
}

/** Sheet-level download (old _doDownload): uid column excluded, no header row,
 * filename "<name><suffix> [N].xlsx". Returns false when nothing to download. */
export async function downloadSheetRows(
  rows: Row[],
  columns: ColumnDef[],
  name: string,
  filterFn?: (row: Row) => boolean,
  suffix?: string,
): Promise<boolean> {
  const XLSX = await import("xlsx");
  const dlCols = columns.filter((c) => c.key !== "uid");
  const data: string[][] = [];
  let hasData = false;
  rows.forEach((row) => {
    if (filterFn && !filterFn(row)) return;
    const isEmpty = dlCols.every((c) => !row[c.key]);
    if (!isEmpty) {
      hasData = true;
      data.push(dlCols.map((c) => exportCellValue(c.key, row[c.key])));
    }
  });
  if (!hasData) return false;
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const filename = name + (suffix || "") + " [" + data.length + "].xlsx";
  if (isNativeWebView()) {
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    (window as unknown as { Android: { download: (n: string, d: string) => void } })
      .Android.download(filename, arrBufToDataUrl(buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    return true;
  }
  XLSX.writeFile(wb, filename);
  return true;
}

/** Custom admin download rows: 4 columns uid, password, cookies, 2fakey — no
 * header. Only-cookie accounts export with an empty 2fa cell. */
export function buildCustomRows(
  rows: Row[],
  password: string,
  filter?: (row: Row) => boolean,
): string[][] {
  const data: string[][] = [];
  rows.forEach((row) => {
    if (filter && !filter(row)) return;
    data.push([
      row.uid ?? "",
      password,
      exportCellValue("cookies", row.cookies),
      exportCellValue("twofakey", row.twofakey),
    ]);
  });
  return data;
}

/** Custom admin download as xlsx (no header row), filename "<name><suffix> [N].xlsx". */
export async function downloadCustomRows(
  rows: Row[],
  name: string,
  password: string,
  filter?: (row: Row) => boolean,
  suffix?: string,
): Promise<boolean> {
  const data = buildCustomRows(rows, password, filter);
  if (!data.length) return false;
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const filename = name + (suffix || "") + " [" + data.length + "].xlsx";
  if (isNativeWebView()) {
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    (window as unknown as { Android: { download: (n: string, d: string) => void } })
      .Android.download(filename, arrBufToDataUrl(buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    return true;
  }
  XLSX.writeFile(wb, filename);
  return true;
}

/** Pre-fill wa_status/wa_ban_reason from the ss:wa: cache (old hydrateWaCache,
 * used on home xlsx import so imported rows show WA state without re-checking). */
export async function hydrateWaCache(rows: Row[]): Promise<void> {
  try {
    if (!rows || !rows.length) return;
    const uidArr: string[] = [];
    rows.forEach((row) => {
      let uid = row.uid ?? null;
      if (!uid && row.cookies) {
        const m = row.cookies.match(/c_user=(\d+)/);
        if (m) uid = m[1];
      }
      if (uid) uidArr.push(uid);
    });
    if (!uidArr.length) return;
    const res = await api.getWaCache(uidArr);
    const cache = (res?.cache ?? {}) as Record<string, WaCacheEntry>;
    rows.forEach((row) => {
      let uid = row.uid ?? null;
      if (!uid && row.cookies) {
        const m = row.cookies.match(/c_user=(\d+)/);
        if (m) uid = m[1];
      }
      const hit = uid ? cache[uid] : null;
      if (!hit || !hit.status) return;
      if (hit.status === "eligible" || hit.status === "ineligible") {
        row.wa_status = hit.status;
        row.wa_ban_reason = hit.banReason ?? null;
        row.wa_page_name = hit.pageName ?? null;
        row.wa_linked_number = hit.linkedNumber ?? null;
      }
    });
  } catch {
    // swallow — old app ignores cache errors
  }
}

export function splitRows<T>(rows: T[], n: number): T[][] {
  if (!rows.length || n <= 1) return n <= 1 ? [rows.slice()] : [rows.slice()];
  const parts = Math.min(Math.max(1, Math.floor(n)), rows.length);
  const size = Math.ceil(rows.length / parts);
  const out: T[][] = [];
  for (let i = 0; i < parts; i++) {
    const c = rows.slice(i * size, (i + 1) * size);
    if (c.length) out.push(c);
  }
  return out;
}
