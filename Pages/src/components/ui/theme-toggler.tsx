import { MoonIcon, SunIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export function ThemeTogglerButton({ theme, onToggle }: { theme: "light" | "dark"; onToggle: () => void }) {
  const dark = theme === "dark"
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={`Switch to ${dark ? "light" : "dark"} theme`} title={`Switch to ${dark ? "light" : "dark"} theme`} onClick={onToggle}>
      <span className="relative grid size-4 place-items-center overflow-hidden">
        <SunIcon className={`absolute size-4 transition-all duration-300 ${dark ? "rotate-90 scale-0" : "rotate-0 scale-100"}`} aria-hidden="true" />
        <MoonIcon className={`absolute size-4 transition-all duration-300 ${dark ? "rotate-0 scale-100" : "-rotate-90 scale-0"}`} aria-hidden="true" />
      </span>
    </Button>
  )
}
