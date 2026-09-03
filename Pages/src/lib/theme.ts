import { useCallback, useEffect, useState } from "react";

const THEME_KEY = "ss_theme";

export type Theme = "light" | "dark";

export function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // ignore — fall through to default
  }
  return "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
    // Swap favicon for the active theme, like the original app.
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = theme === "dark" ? "/favicon-dark.svg" : "/favicon-light.svg";
    // Keep the browser chrome color in sync with the page background.
    const metaColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (metaColor) metaColor.content = theme === "dark" ? "#000000" : "#ffffff";
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, toggle };
}
