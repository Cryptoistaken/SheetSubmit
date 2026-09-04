import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { DownloadDetail } from "@/lib/api";
import { useModalA11y } from "@/hooks/useModalA11y";

export default function DownloadDetailModal({ downloadId, onClose }: { downloadId: string | null; onClose: () => void }) {
  const open = !!downloadId;
  const boxRef = useRef<HTMLDivElement>(null);
  const a11yRef = useModalA11y(open, onClose, boxRef);
  const [detail, setDetail] = useState<DownloadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!downloadId) { setDetail(null); setErr(null); return; }
    let cancelled = false;
    setLoading(true); setErr(null);
    api.getDownloadDetail(downloadId).then((d) => { if (!cancelled) setDetail(d); }).catch((e) => { if (!cancelled) setErr(String(e instanceof Error ? e.message : e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [downloadId]);

  if (!open) return null;
  const titleId = "dl-detail-title";
  const dt = detail ? new Date(detail.at || detail.ts) : null;
  const dateStr = dt ? dt.toLocaleString() : "";

  return (
    <div
      className="modal-overlay open"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ zIndex: 750 }}
    >
      <div
        ref={(el) => { (boxRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (a11yRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ width: 560, maxWidth: "96vw", maxHeight: "85vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div id={titleId} className="modal-title" style={{ marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {loading ? "Loading…" : detail?.filename || "Download detail"}
            </div>
            {detail ? <div style={{ fontSize: 12, color: "var(--text3)" }}>{dateStr} · {detail.claimed} claimed · {detail.poolId}{detail.reverted ? " · reverted" : ""}</div> : null}
            {err ? <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>{err}</div> : null}
          </div>
          <button className="btn btn-ghost btn-sm" aria-label="Close" onClick={onClose} style={{ flexShrink: 0 }}>✕</button>
        </div>

        {loading ? <div style={{ fontSize: 13, color: "var(--text3)", padding: "12px 0" }}>Loading…</div> : null}

        {detail ? (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--text3)" }}>Source groups</div>
            {detail.groups.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: "var(--r)", padding: 12, background: "var(--bg2)" }}>No group breakdown available</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {detail.groups.map((g, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--r)", background: "var(--bg2)" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {g.srcFileId ? `#${g.srcFileId.slice(-8)}` : g.srcUid ? `uid ${g.srcUid.slice(-8)}` : "Unknown source"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {g.srcUid ? <span title={g.srcUid}>uid:{g.srcUid.slice(-8)}</span> : <span style={{ opacity: .7 }}>no uid</span>}
                        {g.srcFileId ? <span title={g.srcFileId}>file:{g.srcFileId.slice(-8)}</span> : <span style={{ opacity: .7 }}>no file</span>}
                      </div>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--mono)", color: "var(--text)", flexShrink: 0 }}>{g.count} rows</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--text3)", marginTop: 4 }}>
              Rows · {detail.rows.length} {detail.keys.length !== detail.rows.length ? `(${detail.keys.length} keys)` : ""}
            </div>
            {detail.rows.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text3)", padding: 8 }}>No rows</div>
            ) : (
              <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r)", overflow: "auto", maxHeight: 220 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg2)", borderBottom: "1px solid var(--border)" }}>
                    <tr>
                      <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600, color: "var(--text2)" }}>uid</th>
                      <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600, color: "var(--text2)" }}>cookies</th>
                      <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600, color: "var(--text2)" }}>2fa</th>
                      <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600, color: "var(--text2)" }}>wa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rows.slice(0, 100).map((r: Record<string, unknown>, idx) => (
                      <tr key={idx} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px 8px", fontFamily: "var(--mono)", whiteSpace: "nowrap", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis" }}>{String(r.uid ?? r["uid"] ?? "").slice(0, 18)}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "var(--mono)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(r.cookies ?? "")}>{String(r.cookies ?? "").slice(0, 40)}</td>
                        <td style={{ padding: "6px 8px", fontFamily: "var(--mono)", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(r.twofakey ?? r["twofakey"] ?? r["2fa key"] ?? "").slice(0, 16)}</td>
                        <td style={{ padding: "6px 8px", color: "var(--text3)" }}>{String(r.wa_status ?? r.waStatus ?? "").slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.rows.length > 100 ? <div style={{ fontSize: 11, color: "var(--text3)", padding: "6px 8px", borderTop: "1px solid var(--border)", background: "var(--bg3)" }}>Showing 100 of {detail.rows.length} rows</div> : null}
              </div>
            )}

            <div className="modal-footer" style={{ marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        ) : !loading ? (
          <div className="modal-footer"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
        ) : null}
      </div>
    </div>
  );
}
