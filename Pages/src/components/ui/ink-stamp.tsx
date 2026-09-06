import { cn } from "@/lib/utils"

export function InkStamp({ label = "APPROVED" }: { label?: string }) {
  return (
    <span
      aria-label={label}
      role="status"
      className={cn("inline-flex rotate-[-8deg] select-none items-center justify-center rounded-sm border-[2.5px] border-green-700 px-3 py-1 text-sm font-black tracking-[0.18em] text-green-700 opacity-90")}
      style={{ fontFamily: "var(--mono)", borderStyle: "double", textShadow: "0 0 0.5px currentColor" }}
    >
      {label}
    </span>
  )
}
