// @wardenx/ui web — internal glyph set for the WardenX system primitives (R0.3).
// Dependency-free inline SVG (the repo carries no icon library). Every colored signal in Lantern
// needs a non-color partner (Hard Rule §10.10) — these are those partners: lock, shield, sparkle,
// alert, check, clock, etc. They paint in `currentColor` so the caller's text color drives them.
import type { JSX } from "react";

export type GlyphName =
  | "lock"
  | "shield"
  | "sparkle"
  | "alert"
  | "check"
  | "check-circle"
  | "clock"
  | "info"
  | "eye"
  | "eye-off"
  | "arrow-right"
  | "close"
  | "block"
  | "dot"
  | "spinner"
  | "sun"
  | "moon"
  | "menu";

// 24×24 viewBox path data. Stroke-drawn unless listed in FILLED.
const PATHS: Record<GlyphName, string> = {
  lock: "M6 10V8a6 6 0 0 1 12 0v2 M5 10h14v10H5z",
  shield: "M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  alert: "M12 4l9 16H3z M12 10v4 M12 17.5v.5",
  check: "M5 13l4 4L19 7",
  "check-circle": "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M8.5 12l2.5 2.5 4.5-5",
  clock: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M12 7v5l3 2",
  info: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M12 11v5 M12 8v.5",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "eye-off":
    "M3 3l18 18 M10.6 10.6a3 3 0 0 0 4 4 M9.9 5.2A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.7 M6.1 6.1A17 17 0 0 0 2 12s3.5 7 10 7a9.5 9.5 0 0 0 2.1-.2",
  "arrow-right": "M5 12h14 M13 6l6 6-6 6",
  close: "M6 6l12 12 M18 6L6 18",
  block: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M6 6l12 12",
  dot: "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  spinner: "M12 3a9 9 0 1 0 9 9",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4 12H2 M22 12h-2 M5.6 5.6L4.2 4.2 M19.8 19.8l-1.4-1.4 M18.4 5.6l1.4-1.4 M4.2 19.8l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  menu: "M4 7h16 M4 12h16 M4 17h16",
};

const FILLED: ReadonlySet<GlyphName> = new Set(["sparkle", "dot"]);

export interface GlyphProps {
  name: GlyphName;
  /** Edge length in px (square). Default 16. */
  size?: number;
  /** Decorative by default (aria-hidden). Pass a label to expose it to assistive tech. */
  label?: string;
}

/** Inline SVG glyph in `currentColor`. Decorative unless `label` is supplied. */
export function Glyph({ name, size = 16, label }: GlyphProps): JSX.Element {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? undefined : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ flexShrink: 0, display: "block" }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
