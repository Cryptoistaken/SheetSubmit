import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { fileTypeDef } from "@/lib/types";
import type { ColumnDef, Row, SheetFile } from "@/lib/types";
import { downloadXlsx, importXlsx, splitRows } from "@/lib/xlsx";

function SplitIcon({ n }: { n: number }) {
  const c = "currentColor";
  if (n === 2) return <svg width="28" height="14" viewBox="0 0 28 14" fill="none"><rect x="0.5" y="0.5" width="12" height="13" rx="1.6" stroke={c} strokeWidth="1.4" /><rect x="15.5" y="0.5" width="12" height="13" rx="1.6" stroke={c} strokeWidth="1.4" /></svg>;
  if (n === 3) return <svg width="28" height="14" viewBox="0 0 28 14" fill="none"><rect x="0.5" y="0.5" width="8" height="13" rx="1.5" stroke={c} strokeWidth="1.4" /><rect x="10" y="0.5" width="8" height="13" rx="1.5" stroke={c} strokeWidth="1.4" /><rect x="19.5" y="0.5" width="8" height="13" rx="1.5" stroke={c} strokeWidth="1.4" /></svg>;
  return <svg width="28" height="14" viewBox="0 0 28 14" fill="none"><rect x="0.5" y="0.5" width="12" height="5.8" rx="1.3" stroke={c} strokeWidth="1.4" /><rect x="15.5" y="0.5" width="12" height="5.8" rx="1.3" stroke={c} strokeWidth="1.4" /><rect x="0.5" y="7.7" width="12" height="5.8" rx="1.3" stroke={c} strokeWidth="1.4" /><rect x="15.5" y="7.7" width="12" height="5.8" rx="1.3" stroke={c} strokeWidth="1.4" /></svg>;
}

export default function SplitterTool() {
  const showToast = useToast();
  const navigate = useNavigate();
  const [source, setSource] = useState<"upload" | "existing">("upload");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cols, setCols] = useState<ColumnDef[] | null>(null);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<SheetFile[] | null>(null);
  const [selId, setSelId] = useState("");
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(2);
  const [custom, setCustom] = useState("");
  const effectiveN = custom.trim() ? parseInt(custom, 10) : n;

  const loadFiles = useCallback(async () => {
    try { setFiles(await api.getFiles()); } catch { setFiles([]); }
  }, []);

  useEffect(() => { if (source === "existing" && files === null) loadFiles(); }, [source, files, loadFiles]);

  const handleUpload = async (f: File) => {
    setLoading(true);
    try {
      const buf = await f.arrayBuffer();
      const res = await importXlsx(buf, f.name, []);
      setRows(res.rows);
      setCols(fileTypeDef(res.type).columns);
      setName(res.name);
      showToast(`Loaded ${res.rows.length} rows`);
    } catch (e) {
      showToast((e as Error).message || "Parse failed");
      setRows(null); setCols(null); setName("");
    } finally { setLoading(false); }
  };

  const handleExisting = async (id: string) => {
    setSelId(id);
    const file = files?.find((x) => x.id === id);
    if (!file) return;
    setLoading(true);
    try {
      const r = await api.getRows(id);
      if (!r || !r.length) throw new Error("No data");
      const c = fileTypeDef(file.type).columns;
      const dl = c.filter((x) => x.key !== "uid");
      const filtered = r.filter((row) => dl.some((col) => row[col.key]));
      if (!filtered.length) throw new Error("No data");
      setRows(filtered);
      setCols(c);
      setName(file.name);
    } catch (e) {
      showToast((e as Error).message || "Failed to load");
      setRows(null); setCols(null);
    } finally { setLoading(false); }
  };

  const doSplit = async () => {
    if (!rows || !cols || !name) { showToast("Load a file first"); return; }
    const parts = effectiveN;
    if (!Number.isFinite(parts) || parts < 1 || parts > 100) { showToast("Pick 1-100 parts"); return; }
    if (parts === 1) { showToast("Pick at least 2"); return; }
    const dlCols = source === "existing" ? cols.filter((c) => c.key !== "uid") : cols;
    const dataRows = rows.filter((r) => dlCols.some((c) => r[c.key]));
    if (!dataRows.length) { showToast("Empty file"); return; }
    const clamped = Math.min(parts, dataRows.length);
    if (clamped !== parts) showToast(`Only ${dataRows.length} rows — splitting into ${clamped}`);
    const chunks = splitRows(dataRows, clamped);
    const base = name.replace(/\.xlsx?$/i, "");
    try {
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        // downloadXlsx adds .xlsx, name includes part + count
        await downloadXlsx(ch, dlCols, `${base} - Part ${i + 1} [${ch.length}]`);
      }
      showToast(`Downloaded ${chunks.length} files`);
    } catch {
      showToast("Download failed");
    }
  };

  return (
    <div>
      <button className="btn btn-ghost" style={{ marginBottom: 16 }} onClick={() => navigate("/tools")}>← Tools</button>
      <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>Splitter</h2>
      <p style={{ fontSize: 13, color: "var(--text3)", marginTop: 2, marginBottom: 16 }}>Split an xlsx into N equal parts</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button className={`btn ${source === "upload" ? "btn-primary" : ""}`} onClick={() => setSource("upload")}>Upload xlsx</button>
        <button className={`btn ${source === "existing" ? "btn-primary" : ""}`} onClick={() => setSource("existing")}>Existing file</button>
      </div>

      {source === "upload" ? (
        <label className="btn" style={{ marginBottom: 12, cursor: "pointer" }}>
          Choose file
          <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.currentTarget.value = ""; }} />
        </label>
      ) : (
        <select className="modal-input" style={{ maxWidth: 360, marginBottom: 12 }} value={selId} onChange={(e) => handleExisting(e.target.value)}>
          <option value="">Select file…</option>
          {(files ?? []).map((f) => <option key={f.id} value={f.id}>{f.name} ({f.dataCount ?? f.rowCount ?? "?"})</option>)}
        </select>
      )}

      {loading ? <div style={{ fontSize: 13, color: "var(--text3)" }}>Loading…</div> : null}
      {rows ? <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text2)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: "6px 10px", marginBottom: 12, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--green)", flexShrink: 0, display: "inline-block" }} />{name} — {rows.length} rows</div> : null}

      {rows && cols ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--rl)", padding: 16, background: "var(--bg)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Split into</div>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap", marginBottom: 12 }}>
            {[2, 3, 4].map((v) => {
              const sel = !custom.trim() && n === v;
              return (
                <button
                  key={v}
                  className="btn"
                  aria-label={`Split into ${v}`}
                  aria-pressed={sel}
                  onClick={() => { setN(v); setCustom(""); }}
                  style={{
                    flex: "1 1 72px",
                    minWidth: 72,
                    justifyContent: "center",
                    padding: "10px 12px",
                    fontWeight: 600,
                    borderColor: sel ? "var(--blue)" : undefined,
                    background: sel ? "var(--blue-light)" : undefined,
                    color: sel ? "var(--blue)" : undefined,
                    display: "inline-flex", alignItems: "center", gap: 8,
                  }}
                >
                  <SplitIcon n={v} /> {v}
                </button>
              );
            })}
            <input
              className="modal-input"
              type="number"
              min={2}
              max={100}
              placeholder="Custom"
              aria-label="Custom parts"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              style={{ flex: "1 1 96px", minWidth: 96, width: 96, textAlign: "center", fontWeight: 600, height: 38, alignSelf: "stretch", borderColor: custom.trim() ? "var(--blue)" : undefined, background: custom.trim() ? "var(--blue-light)" : undefined, color: custom.trim() ? "var(--blue)" : undefined }}
            />
          </div>
          {rows.length > 0 && effectiveN >= 2 ? (
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "nowrap", overflow: "hidden" }}>
              {Array.from({ length: Math.min(effectiveN, Math.min(rows.length, 6)) }).map((_, i, arr) => {
                const total = Math.min(effectiveN, rows.length);
                const per = Math.ceil(rows.length / total);
                const extra = arr.length < total ? ` +${total - arr.length}` : "";
                return (
                  <div key={i} style={{ flex: 1, minWidth: 0, height: 30, borderRadius: "var(--r)", border: "1px solid var(--blue)", background: "var(--blue-light)", color: "var(--blue)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", padding: "0 4px" }}>
                    {per}{i === arr.length - 1 ? extra : ""}
                  </div>
                );
              })}
            </div>
          ) : null}
          <button className="btn btn-primary" onClick={doSplit} style={{ width: "100%", justifyContent: "center", padding: "10px 14px", fontSize: 14, fontWeight: 600 }}>Split &amp; download</button>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Files: “{name.replace(/\.xlsx?$/i, "")} - Part 1 [{rows.length ? Math.ceil(rows.length / (effectiveN || 2)) : 0}].xlsx” …</div>
        </div>
      ) : null}
    </div>
  );
}
