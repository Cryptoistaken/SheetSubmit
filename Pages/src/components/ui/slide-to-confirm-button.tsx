import { forwardRef, useRef, useState, type ComponentPropsWithoutRef, type PointerEvent as ReactPointerEvent } from "react"
import { cn } from "@/lib/utils"
import { ArrowRight, Check } from "lucide-react"

const PAD = 4
const KNOB = 40

export type SlideToConfirmButtonProps = Readonly<
  {
    label?: string
    confirmedLabel?: string
    disabled?: boolean
    onConfirm?: () => void
  } & Omit<ComponentPropsWithoutRef<"div">, "onConfirm"> &
    Pick<ComponentPropsWithoutRef<"div">, "className">
>

export const SlideToConfirmButton = forwardRef<HTMLDivElement, SlideToConfirmButtonProps>(
  ({ className, label = "Slide to confirm", confirmedLabel = "Confirmed", disabled, onConfirm, ...props }, ref) => {
    const trackRef = useRef<HTMLDivElement>(null)
    const draggingRef = useRef(false)
    const [x, setX] = useState(0)
    const [confirmed, setConfirmed] = useState(false)

    const maxX = () => {
      const track = trackRef.current
      if (!track) return 0
      return track.offsetWidth - KNOB - PAD * 2
    }

    const handleDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (confirmed) return
      draggingRef.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    const handleMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggingRef.current || confirmed) return
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const next = Math.min(Math.max(event.clientX - rect.left - PAD - KNOB / 2, 0), maxX())
      setX(next)
    }

    const handleUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      if (x >= maxX() - 4) {
        setX(maxX())
        setConfirmed(true)
        onConfirm?.()
      } else {
        setX(0)
      }
    }

    const progress = maxX() > 0 ? x / maxX() : 0

    return (
      <div
        ref={ref}
        data-slot="slide-to-confirm-button"
        className={cn("font-sans select-none w-full", className)}
        {...props}
      >
        <div
          ref={trackRef}
          className={cn(
            "relative h-12 w-full transform-gpu isolate overflow-hidden rounded-full p-1 transition-[box-shadow] duration-300",
            "shadow-[inset_0_1px_2px_rgba(0,0,0,0.08),inset_0_2px_4px_rgba(0,0,0,0.05),inset_0_-2px_3px_rgba(0,0,0,0.06),0_1px_0_rgba(255,255,255,0.9)]",
            confirmed
              ? "bg-muted shadow-[inset_0_1px_3px_rgba(0,0,0,0.2),inset_0_-2px_3px_rgba(0,0,0,0.12),0_1px_0_rgba(255,255,255,0.9)]"
              : "bg-muted",
            disabled && "opacity-50 pointer-events-none"
          )}
        >
          <span
            aria-hidden
            className="absolute inset-0 rounded-full transition-colors duration-300"
            style={{
              width: confirmed ? "100%" : `${(PAD + KNOB / 2 + progress * (maxX())) / (maxX() + KNOB + PAD * 2) * 100}%`,
              backgroundColor: confirmed ? "rgb(0,0,0)" : "hsl(var(--primary))",
              opacity: confirmed ? 0.15 : 0.06,
            }}
          />
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 flex items-center justify-center text-sm font-medium transition-colors duration-200"
            )}
            style={{ opacity: confirmed ? 0 : 1 - progress * 1.6 }}
          >
            <span className="text-muted-foreground [text-shadow:0_1px_0_rgba(255,255,255,0.8)]">{label}</span>
          </span>
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 flex items-center justify-center text-sm font-medium",
              "text-foreground [text-shadow:0_1px_1px_rgba(0,0,0,0.25)]"
            )}
            style={{
              opacity: confirmed ? 1 : 0,
              transform: confirmed ? "translateY(0)" : "translateY(8px)",
              transition: "opacity 0.3s ease 0.15s, transform 0.3s ease 0.15s",
            }}
          >
            {confirmedLabel}
          </span>
          <button
            type="button"
            aria-label={label}
            disabled={confirmed}
            onPointerDown={handleDown}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerCancel={handleUp}
            className={cn(
              "absolute top-1 left-1 flex size-10 touch-none items-center justify-center rounded-full will-change-transform",
              "shadow-[0_1px_1px_rgba(0,0,0,0.12),0_2px_3px_rgba(0,0,0,0.12),inset_0_1.5px_0_rgba(255,255,255,1),inset_0_-2px_3px_rgba(0,0,0,0.1)]",
              confirmed
                ? "bg-foreground text-background cursor-default shadow-[0_1px_1px_rgba(0,0,0,0.06),inset_0_1px_1px_rgba(0,0,0,0.06),inset_0_2px_3px_rgba(0,0,0,0.03),inset_0_-2px_3px_rgba(0,0,0,0.05)]"
                : "bg-background text-foreground cursor-grab active:cursor-grabbing active:bg-accent active:shadow-[0_1px_1px_rgba(0,0,0,0.06),inset_0_1px_1px_rgba(0,0,0,0.06),inset_0_2px_3px_rgba(0,0,0,0.03),inset_0_-2px_3px_rgba(0,0,0,0.05)]",
              draggingRef.current
                ? "transition-[box-shadow,background-color] duration-200 ease-out"
                : "transition-[transform,box-shadow,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
            )}
            style={{ transform: `translate3d(${x}px, 0, 0)` }}
          >
            <span
              className="absolute"
              style={{
                opacity: confirmed ? 0 : 1,
                transform: confirmed ? "scale(0)" : "scale(1)",
                transition: "opacity 0.2s, transform 0.2s",
              }}
            >
              <ArrowRight size={18} strokeWidth={2.5} aria-hidden className="filter-[drop-shadow(0_1px_0_rgba(255,255,255,0.9))_drop-shadow(0_-1px_0.5px_rgba(0,0,0,0.12))]" />
            </span>
            <span
              className="absolute"
              style={{
                opacity: confirmed ? 1 : 0,
                transform: confirmed ? "scale(1)" : "scale(0)",
                transition: "opacity 0.3s ease 0.1s, transform 0.3s cubic-bezier(0.32,0.72,0,1) 0.1s",
              }}
            >
              <Check size={18} strokeWidth={2.5} aria-hidden className="text-background filter-[drop-shadow(0_1px_0_rgba(255,255,255,0.9))_drop-shadow(0_-1px_0.5px_rgba(0,0,0,0.12))]" />
            </span>
          </button>
        </div>
      </div>
    )
  }
)

SlideToConfirmButton.displayName = "SlideToConfirmButton"
