// @chartwarden/ui web — internal glyph set for the ChartWarden system primitives (R0.3).
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
  | "search"
  | "bell"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "plus"
  | "more-horizontal"
  | "pencil"
  | "phone"
  | "mail"
  | "user-plus"
  | "user-circle"
  | "clipboard-list"
  | "pill"
  | "receipt"
  | "bar-chart"
  | "building"
  | "grid-circles"
  | "layout-grid"
  | "shield-check"
  | "stethoscope"
  | "filter"
  | "download"
  | "upload"
  | "play"
  | "printer"
  | "link"
  | "target"
  | "bed"
  | "thermometer"
  | "droplet"
  | "heart-pulse"
  | "alert-circle"
  | "x-circle"
  | "file-check"
  | "video"
  | "trending-up"
  | "arrow-up"
  | "arrow-down"
  | "calendar-check"
  | "rotate-ccw"
  | "package"
  | "flask"
  | "zap"
  | "scroll"
  | "send"
  | "lungs"
  | "scale"
  | "battery"
  | "utensils"
  | "brain"
  | "frown"
  | "globe"
  | "mic";

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
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-left": "M15 18l-6-6 6-6",
  plus: "M12 5v14 M5 12h14",
  "more-horizontal":
    "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  pencil: "M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z M15 5l4 4",
  phone:
    "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6",
  "user-plus":
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M19 8v6 M22 11h-6",
  "user-circle":
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M7 20.66V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.66",
  "clipboard-list":
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M9 2h6v4H9z M12 11h4 M12 16h4 M8 11h.01 M8 16h.01",
  pill: "M10.5 20.5a4.95 4.95 0 1 1-7-7l10-10a4.95 4.95 0 1 1 7 7z M8.5 8.5l7 7",
  receipt:
    "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8 M12 17.5v-11",
  "bar-chart": "M3 3v18h18 M8 17v-5 M13 17V8 M18 17v-8",
  building:
    "M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18z M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2 M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2 M10 6h4 M10 10h4 M10 14h4 M10 18h4",
  "grid-circles":
    "M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M17 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M7 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "layout-grid": "M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z",
  "shield-check": "M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z M9 12l2 2 4-4",
  stethoscope:
    "M5 3H4a1 1 0 0 0-1 1v5a5 5 0 0 0 10 0V4a1 1 0 0 0-1-1h-1 M8 14v1a6 6 0 0 0 12 0v-3 M20 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",
  play: "M7 4l12 8-12 8z",
  printer:
    "M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  target:
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  bed: "M2 4v16 M2 8h18a2 2 0 0 1 2 2v10 M2 17h20 M6 8v9",
  thermometer: "M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z",
  droplet:
    "M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z",
  "heart-pulse":
    "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27",
  "alert-circle": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v4 M12 16h.01",
  "x-circle": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M15 9l-6 6 M9 9l6 6",
  "file-check":
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 15l2 2 4-4",
  video:
    "M16 13l5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11 M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  "trending-up": "M22 7l-8.5 8.5-5-5L2 17 M16 7h6v6",
  "arrow-up": "M12 19V5 M5 12l7-7 7 7",
  "arrow-down": "M12 5v14 M19 12l-7 7-7-7",
  "calendar-check":
    "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z M16 2v4 M8 2v4 M3 10h18 M9 16l2 2 4-4",
  "rotate-ccw": "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8 M3 3v5h5",
  package:
    "M16.5 9.4l-9-5.19 M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96L12 12.01l8.73-5.05 M12 22.08V12",
  flask: "M9 3h6 M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  scroll:
    "M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4 M19 17V5a2 2 0 0 0-2-2H4 M14 8h-4 M16 12h-6",
  send: "M22 2L11 13 M22 2l-7 20-4-9-9-4z",
  lungs:
    "M12 4v8 M12 12l-3 2.5 M12 12l3 2.5 M9 7.5C6 7.5 3 11.5 3 16.5 3 18.7 4.3 20 6.5 20S10 18.5 10 16.5V9a1.5 1.5 0 0 0-1-1.5z M15 7.5c3 0 6 4 6 9 0 2.2-1.3 3.5-3.5 3.5S14 18.5 14 16.5V9a1.5 1.5 0 0 1 1-1.5z",
  scale: "M12 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M6.5 8h11l2.5 13H4z",
  battery:
    "M3 7h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z M21 11v2 M6 10v4",
  utensils: "M4 2v7a3 3 0 0 0 3 3v10 M7 2v6 M10 2v7a3 3 0 0 1-3 3 M19 22V2c-2.5 0-4 2.5-4 6v6h4",
  brain:
    "M12 5.5a3 3 0 0 0-5.6-1.4A3 3 0 0 0 4 9.2a3 3 0 0 0 .6 5.3A3 3 0 0 0 8 19a3 3 0 0 0 4 1.5z M12 5.5a3 3 0 0 1 5.6-1.4A3 3 0 0 1 20 9.2a3 3 0 0 1-.6 5.3A3 3 0 0 1 16 19a3 3 0 0 1-4 1.5z M12 5.5v15",
  frown: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M8 16.5s1.5-2 4-2 4 2 4 2 M9 9.5h.01 M15 9.5h.01",
  globe:
    "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18",
  mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0 M12 18v3",
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
  /** Stroke weight for outline glyphs. Default 2; the app shell's nav uses a lighter 1.75. */
  strokeWidth?: number;
}

/** Inline SVG glyph in `currentColor`. Decorative unless `label` is supplied. */
export function Glyph({ name, size = 16, label, style, strokeWidth = 2 }: GlyphProps): JSX.Element {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? undefined : strokeWidth}
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
