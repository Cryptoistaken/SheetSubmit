import * as React from "react"
import { cn } from "@/lib/utils"

export function HoldToDeleteButton({ onConfirm, disabled, label = "Hold to delete", holdMs = 700 }: { onConfirm: () => void; disabled?: boolean; label?: string; holdMs?: number }) {
  const [progress, setProgress] = React.useState(0)
  const timerRef = React.useRef<number | null>(null)
  const rafRef = React.useRef<number | null>(null)
  const startRef = React.useRef<number>(0)

  const clear = React.useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    timerRef.current = null
    rafRef.current = null
    setProgress(0)
  }, [])

  const tick = React.useCallback(() => {
    const elapsed = Date.now() - startRef.current
    const p = Math.min(elapsed / holdMs, 1)
    setProgress(p)
    if (p < 1) rafRef.current = requestAnimationFrame(tick)
  }, [holdMs])

  const start = React.useCallback(() => {
    if (disabled) return
    startRef.current = Date.now()
    tick()
    timerRef.current = window.setTimeout(() => { clear(); onConfirm() }, holdMs)
  }, [disabled, holdMs, onConfirm, clear, tick])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onConfirm() }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onPointerDown={start}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onKeyDown={onKeyDown}
      className={cn("relative inline-flex h-9 items-center justify-center overflow-hidden rounded-lg border border-destructive/20 bg-destructive/10 px-4 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", progress > 0 && "bg-destructive/20")}
    >
      <span className="absolute inset-0 origin-left bg-destructive/20 transition-none" style={{ transform: `scaleX(${progress})` }} aria-hidden />
      <span className="relative">{progress > 0 ? `${Math.round(progress * 100)}%` : label}</span>
    </button>
  )
}
