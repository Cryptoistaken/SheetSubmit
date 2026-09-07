import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { SlideToConfirmButton } from "@/components/ui/slide-to-confirm-button"
import { HoldToDeleteButton } from "@/components/ui/hold-to-delete-button"
import { InkStamp } from "@/components/ui/ink-stamp"
import { Button } from "@/components/ui/button"
import { api, type DownloadDetail, type HoldRecord } from "@/lib/api"
import { triggerBlobDownload } from "@/lib/xlsx"
import { useToast } from "@/lib/toast"
import ProfileAvatar from "@/components/profile/ProfileAvatar"
import { PoolTypeIcon } from "./PoolsView"

export function ApprovalDetailDialog({ hold, open, onClose, onApprove, onReturn, onDelete, acting, unitPrice, owners }: {
  hold: HoldRecord | null
  open: boolean
  onClose: () => void
  onApprove: (id: string) => void
  onReturn: (id: string) => void
  onDelete: (id: string) => void
  acting: string | null
  unitPrice?: number | null
  owners?: Record<string, { name?: string; photoUrl?: string | null }>
}) {
  const [detail, setDetail] = useState<DownloadDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [dlBusy, setDlBusy] = useState(false)
  const showToast = useToast()

  const doDownload = async () => {
    if (!hold) return
    setDlBusy(true)
    try {
      const blob = await api.getDownloadBlob(hold.id)
      triggerBlobDownload(blob, hold.filename || "download.xlsx")
      showToast(`Downloaded ${hold.filename}`)
    } catch (e) { showToast(String(e instanceof Error ? e.message : e)) } finally { setDlBusy(false) }
  }

  useEffect(() => {
    if (!open || !hold?.id) return
    let cancelled = false
    setLoading(true)
    api.getDownloadDetail(hold.id).then((value) => { if (!cancelled) setDetail(value) }).catch(() => { if (!cancelled) setDetail(null) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [hold?.id, open])

  if (!hold) return null
  const st = String(hold.status || "").toUpperCase()
  const stLabel = st === "HOLD" ? "PENDING" : st
  const isHold = st === "HOLD"
  const isApproved = st === "APPROVED"
  const srcUids = (hold as unknown as { srcUids?: string[] | null }).srcUids ?? null
  const srcFileIds = (hold as unknown as { srcFileIds?: string[] | null }).srcFileIds ?? null
  const qty = (hold as unknown as { held?: number; claimed?: number }).held ?? hold.claimed ?? 0
  const money = (n: number) => unitPrice != null ? `$${(n * unitPrice).toFixed(2)}` : "—"
  const total = money(qty)

  const groups = detail?.groups ?? []
  const users = [...new Set(groups.map((group) => group.srcUid).filter(Boolean))] as string[]
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
       <DialogContent className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>{hold.filename}</DialogTitle>
          <DialogDescription>{hold.poolId} · {qty} qty · {hold.mode ?? "—"} · {stLabel}</DialogDescription>
        </DialogHeader>
        {isApproved ? <div className="py-2"><InkStamp label="APPROVED" /></div> : null}
        <div className="flex flex-col gap-2 text-sm">
          <div><span className="font-semibold">Status:</span> {stLabel}</div>
          {unitPrice != null ? <div><span className="font-semibold">Unit price:</span> ${unitPrice.toFixed(2)} · <span className="font-semibold">Total payment:</span> {total}</div> : null}
          {loading ? <div className="text-muted-foreground">Loading user and file details…</div> : null}
          {users.length ? (
            <div className="flex flex-col gap-2">
              {users.map((uid) => {
                const files = groups.filter((group) => group.srcUid === uid)
                const rows = files.reduce((sum, file) => sum + file.count, 0)
                const pct = qty ? Math.round(rows / qty * 100) : 0
                const profile = owners?.[uid]
                const label = profile?.name || "#" + uid.slice(-6)
                return (
                  <div key={uid} className="rounded-md border bg-muted p-3">
                    <div className="flex items-center gap-2">
                      <ProfileAvatar photoUrl={profile?.photoUrl} fallback={(profile?.name || uid).trim().charAt(0).toUpperCase()} className="size-7" />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold truncate">{label}</div>
                        <div className="text-xs text-muted-foreground">{rows} rows · {files.length} files{unitPrice != null ? ` · ${money(rows)} (${pct}%)` : ""}</div>
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {files.map((file) => (
                        <div key={`${file.srcFileId}-${file.count}`} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span style={{ color: "var(--text3)", flexShrink: 0, display: "inline-flex", lineHeight: 0 }}><PoolTypeIcon poolId={hold.poolId} size={12} /></span>
                          <span className="truncate">File #{file.srcFileId?.slice(-8) ?? "unknown"} · {file.count} rows</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : srcUids?.length ? (
            <div className="flex flex-col gap-2">
              {srcUids.map((uid) => (
                <div key={uid} className="flex items-center gap-2 text-sm">
                  <ProfileAvatar photoUrl={owners?.[uid]?.photoUrl} fallback={(owners?.[uid]?.name || uid).trim().charAt(0).toUpperCase()} className="size-7" />
                  <span className="truncate">{owners?.[uid]?.name || "#" + uid.slice(-6)}</span>
                  <span className="text-xs text-muted-foreground">#{uid.slice(-6)}</span>
                </div>
              ))}
            </div>
          ) : <div className="text-muted-foreground">No source user filter</div>}
          {srcFileIds?.length && !users.length ? <div><span className="font-semibold">Source files:</span> {srcFileIds.map(s => s.slice(-6)).join(", ")} <span className="text-xs text-muted-foreground">({srcFileIds.length})</span></div> : null}
          <div><span className="font-semibold">Quantity:</span> {qty}</div>
        </div>
        <div className="flex flex-col gap-3 pt-4">
          <Button className="w-full" style={{ padding: "12px 20px", fontSize: 15, fontWeight: 700, borderRadius: "var(--rl)" }} disabled={dlBusy} onClick={doDownload}>{dlBusy ? "Preparing…" : "Download"}</Button>
          {isHold ? <SlideToConfirmButton onConfirm={() => onApprove(hold.id)} disabled={acting === hold.id} label={unitPrice != null ? `Slide to approve · ${total}` : "Slide to approve"} /> : null}
          {isHold ? (
            <div className="flex gap-2">
              <HoldToDeleteButton onConfirm={() => onReturn(hold.id)} disabled={acting === hold.id} label="Hold to return" />
            </div>
          ) : (
            <HoldToDeleteButton onConfirm={() => onDelete(hold.id)} disabled={acting === hold.id} label="Hold to delete" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
