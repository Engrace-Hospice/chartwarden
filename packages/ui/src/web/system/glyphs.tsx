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
  | "menu"
  | "home"
  | "user"
  | "users"
  | "settings"
  | "dollar"
  | "activity"
  | "file-text"
  | "calendar"
  | "truck"
  | "message-square"
  | "cpu"
  | "heart"
  | "clipboard-check"
  | "folder"
  | "search";

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
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  users:
    "M17 21v-2a4 4 0 0 0-3-3.87 M9 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M16 3.13a4 4 0 0 1 0 7.75",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  dollar: "M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  "file-text":
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  calendar:
    "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z M16 2v4 M8 2v4 M3 10h18",
  truck:
    "M14 18H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8 M14 2v16 M14 8h5l3 3v5a2 2 0 0 1-2 2h-3 M9 18a2 2 0 1 1 0 4 2 2 0 0 1 0-4z M17 18a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  "message-square": "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  cpu: "M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M20 9h3 M20 15h3 M1 9h3 M1 15h3",
  heart:
    "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
  "clipboard-check":
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 2a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1 M9 14l2 2 4-4",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35",
};

const FILLED: ReadonlySet<GlyphName> = new Set(["sparkle", "dot"]);

export interface GlyphProps {
  name: GlyphName;
  /** Edge length in px (square). Default 16. */
  size?: number;
  /** Decorative by default (aria-hidden). Pass a label to expose it to assistive tech. */
  label?: string;
  /** Custom inline style. */
  style?: import("react").CSSProperties;
}

/** Inline SVG glyph in `currentColor`. Decorative unless `label` is supplied. */
export function Glyph({ name, size = 16, label, style }: GlyphProps): JSX.Element {
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
      style={{ flexShrink: 0, display: "block", ...style }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
