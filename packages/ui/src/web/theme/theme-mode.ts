// @wardenx/ui — the light ⇄ dark theme controller shared by apps/web and apps/admin. DESIGN.md §11 uses a class
// strategy: `.dark` on <html> flips every --color-* CSS var. The chosen mode persists in localStorage
// (a UI preference, NOT PHI — safe under the no-PHI-in-browser-storage rule); absent a stored choice we
// honor the OS `prefers-color-scheme`. Applied imperatively so the very first paint is correct (no flash).
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "wx-theme";

export type ThemeMode = "light" | "dark";

function readStored(): ThemeMode | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // private mode / storage disabled — fall back to the OS preference.
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** The mode to use right now: explicit stored choice wins, else the OS preference. */
export function resolvedTheme(): ThemeMode {
  return readStored() ?? (systemPrefersDark() ? "dark" : "light");
}

/** Flip the `.dark` class on <html> (the single switch every Lantern token reacts to). */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", mode === "dark");
  }
}

/** Eager init — call once before React renders so the first paint matches the resolved theme. */
export function initTheme(): ThemeMode {
  const mode = resolvedTheme();
  applyTheme(mode);
  return mode;
}

function persist(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage disabled — the in-memory toggle still works for the session. */
  }
}

/** React state for the toggle control; keeps <html> in sync and persists the choice. */
export function useTheme(): { mode: ThemeMode; toggle: () => void } {
  const [mode, setMode] = useState<ThemeMode>(resolvedTheme);
  useEffect(() => {
    applyTheme(mode);
  }, [mode]);
  const toggle = useCallback(() => {
    setMode((m) => {
      const next: ThemeMode = m === "dark" ? "light" : "dark";
      persist(next);
      return next;
    });
  }, []);
  return { mode, toggle };
}
