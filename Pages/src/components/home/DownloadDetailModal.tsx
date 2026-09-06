import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DownloadDetail } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HoldToDeleteButton } from "@/components/ui/hold-to-delete-button";
import { InkStamp } from "@/components/ui/ink-stamp";
import { useToast } from "@/lib/toast";

function triggerBlobDownload(blob: Blob, filename: string) {
  const w = window as unknown as { Android?: { download?: (name: string, data: string) => void } };
  if (typeof w.Android?.download === "function") {
    const reader = new FileReader();
    reader.onload = () => w.Android!.download!(filename, String(reader.result));
    reader.readAsDataURL(blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DownloadDetailModal({ downloadId, onClose, onDeleted }: { downloadId: string | null; onClose: () => void; onDeleted?: () => void }) {
  const open = !!downloadId;
  const [detail, setDetail] = useState<DownloadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<"download" | "revert" | "delete" | null>(null);
  const showToast = useToast();

  useEffect(() => {
    if (!downloadId) { setDetail(null); setErr(null); return; }
    let cancelled = false;
    setLoading(true); setErr(null);
    api.getDownloadDetail(downloadId).then((d) => { if (!cancelled) setDetail(d); }).catch((e) => { if (!cancelled) setErr(String(e instanceof Error ? e.message : e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [downloadId]);

  const dt = detail ? new Date(detail.at || detail.ts) : null;
  const dateStr = dt ? dt.toLocaleString() : "";
  const rawStatus = (detail as unknown as { status?: string })?.status;
  const isApproved = rawStatus ? String(rawStatus).toUpperCase() === "APPROVED" : false;
  const isReverted = !!detail?.reverted || (rawStatus ? String(rawStatus).toUpperCase() === "REVERTED" || String(rawStatus).toUpperCase() === "REJECTED" : false);
  const users = detail ? Array.from(detail.groups.reduce((map, group) => {
    const key = group.srcUid || "unknown";
    const current = map.get(key) ?? [];
    current.push(group);
    map.set(key, current);
    return map;
  }, new Map<string, DownloadDetail["groups"]>())) : [];

  const doDownload = async () => {
    if (!detail) return;
    setActing("download");
    try { const blob = await api.getDownloadBlob(detail.id); triggerBlobDownload(blob, detail.filename || "download.xlsx"); showToast(`Downloaded ${detail.filename}`) } catch (e) { showToast(String(e instanceof Error ? e.message : e)) } finally { setActing(null) }
  };
  const doRevert = async () => {
    if (!detail) return;
    setActing("revert");
    try { await api.revertDownload(detail.id); showToast("Rows returned to pool"); setDetail(d => d ? { ...d, reverted: true } as DownloadDetail : d); onDeleted?.() } catch (e) { showToast(String(e instanceof Error ? e.message : e)) } finally { setActing(null) }
  };
  const doDelete = async () => {
    if (!detail) return;
    setActing("delete");
    try { await api.deleteDownload(detail.id); showToast("Deleted"); onClose(); onDeleted?.() } catch (e) { showToast(String(e instanceof Error ? e.message : e)) } finally { setActing(null) }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
       <DialogContent className="max-w-[560px] max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>{loading ? "Loading…" : detail?.filename || "Download detail"}</DialogTitle>
          {detail ? <DialogDescription>{dateStr} · {detail.claimed} claimed · {detail.poolId}{detail.reverted ? " · reverted" : ""}{rawStatus ? ` · ${String(rawStatus).toUpperCase()}` : ""}</DialogDescription> : null}
          {err ? <div className="text-sm text-destructive mt-2">{err}</div> : null}
        </DialogHeader>
        {isApproved ? <div className="py-1"><InkStamp label="APPROVED" /></div> : null}
        {loading ? <div className="text-sm text-muted-foreground py-3">Loading…</div> : null}
        {detail ? (
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground mb-2">Users and files</div>
              {users.length === 0 ? (
                <div className="text-sm text-muted-foreground border rounded-md p-3 bg-muted">No group breakdown available</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {users.map(([uid, files]) => (
                    <div key={uid} className="border rounded-md bg-muted p-3">
                      <div className="text-sm font-semibold">{uid === "unknown" ? "Unknown user" : `User #${uid.slice(-8)}`} <span className="text-xs font-normal text-muted-foreground">{files.reduce((sum, file) => sum + file.count, 0)} rows · {files.length} files</span></div>
                      <div className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                        {files.map((file) => <div key={`${file.srcFileId}-${file.count}`}>File #{file.srcFileId?.slice(-8) ?? "unknown"} · {file.count} rows</div>)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground mb-2">Rows · {detail.rows.length} {detail.keys.length !== detail.rows.length ? `(${detail.keys.length} keys)` : ""}</div>
              {detail.rows.length === 0 ? <div className="text-sm text-muted-foreground p-2">No rows</div> : (
                <div className="border rounded-md overflow-auto max-h-[220px]">
                  <table className="w-full border-collapse text-xs">
                    <thead className="sticky top-0 bg-muted border-b">
                      <tr><th className="text-left p-2 font-semibold text-muted-foreground">uid</th><th className="text-left p-2 font-semibold text-muted-foreground">cookies</th><th className="text-left p-2 font-semibold text-muted-foreground">2fa</th><th className="text-left p-2 font-semibold text-muted-foreground">wa</th></tr>
                    </thead>
                    <tbody>
                      {detail.rows.slice(0, 100).map((r: Record<string, unknown>, idx) => (
                        <tr key={idx} className="border-t"><td className="p-2 font-mono truncate max-w-[90px]">{String(r.uid ?? "").slice(0, 18)}</td><td className="p-2 font-mono truncate max-w-[160px]" title={String(r.cookies ?? "")}>{String(r.cookies ?? "").slice(0, 40)}</td><td className="p-2 font-mono truncate max-w-[90px]">{String(r.twofakey ?? r["twofakey"] ?? r["2fa key"] ?? "").slice(0, 16)}</td><td className="p-2 text-muted-foreground">{String(r.wa_status ?? r.waStatus ?? "").slice(0, 10)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {detail.rows.length > 100 ? <div className="text-xs text-muted-foreground p-2 border-t bg-muted">Showing 100 of {detail.rows.length} rows</div> : null}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button disabled={acting === "download" || isReverted} onClick={doDownload}>{acting === "download" ? "…" : "Download"}</Button>
              <Button variant="outline" disabled={acting === "revert" || isReverted} onClick={doRevert}>{acting === "revert" ? "…" : isReverted ? "Returned" : "Return"}</Button>
              <HoldToDeleteButton onConfirm={doDelete} disabled={acting === "delete"} label="Hold to delete" />
            </div>
          </div>
        ) : !loading ? <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>Close</Button></div> : null}
      </DialogContent>
    </Dialog>
  );
}
