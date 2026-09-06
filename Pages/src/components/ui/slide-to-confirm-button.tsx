import * as React from "react"
import { cn } from "@/lib/utils"

export function SlideToConfirmButton({ onConfirm, disabled, label = "Slide to approve" }: { onConfirm: () => void; disabled?: boolean; label?: string }) {
  const [drag, setDrag] = React.useState(0)
  const [confirmed, setConfirmed] = React.useState(false)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef(false)

  const finish = React.useCallback(() => {
    if (confirmed || disabled) return
    setConfirmed(true)
    onConfirm()
    setTimeout(() => { setConfirmed(false); setDrag(0) }, 800)
  }, [confirmed, disabled, onConfirm])

  const onPointerMove = React.useCallback((e: PointerEvent) => {
    if (!dragging.current || !trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left - 24
    const max = rect.width - 48
    const p = Math.max(0, Math.min(x / max, 1))
    setDrag(p)
    if (p >= 0.92) { dragging.current = false; finish() }
  }, [finish])

  const onPointerUp = React.useCallback(() => {
    dragging.current = false
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", onPointerUp)
    if (drag < 0.92) setDrag(0)
  }, [drag, onPointerMove])

  const start = (e: React.PointerEvent) => {
    if (disabled || confirmed) return
    dragging.current = true
    ;(e.target as Element).setPointerCapture(e.pointerId)
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); finish() }
  }

  return (
    <div
      ref={trackRef}
      role="group"
      aria-label={label}
      className={cn("relative flex h-10 w-full select-none items-center rounded-full border bg-muted p-1", disabled && "opacity-50 pointer-events-none", confirmed && "bg-green-500/20 border-green-500/30")}
    >
      <div className="absolute inset-1 rounded-full bg-gradient-to-r from-primary/10 to-primary/5 pointer-events-none" style={{ clipPath: `inset(0 ${100 - drag * 100}% 0 0)` }} aria-hidden />
      <button
        type="button"
        aria-label={label}
        disabled={disabled || confirmed}
        onPointerDown={start}
        onKeyDown={onKeyDown}
        className="relative z-10 flex h-8 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ transform: `translateX(${drag * (trackRef.current ? trackRef.current.clientWidth - 56 : 0)}px)`, transition: dragging.current ? "none" : "transform 0.2s" }}
      >
        {confirmed ? "✓" : "→"}
      </button>
      <span className="flex-1 text-center text-sm font-semibold text-muted-foreground pointer-events-none">{confirmed ? "Approved" : label}</span>
    </div>
  )
}
