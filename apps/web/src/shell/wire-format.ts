// apps/web/src/shell/wire-format.ts — display helpers for wire values (status enums, ISO instants, ids).
// The M15/M16/M19/M20/M21 `*-status.ts` modules each carried a byte-identical copy of these; they now share
// this one and re-export it, so every existing import from a status module keeps working.
import type { StatusTone } from "@chartwarden/ui";

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — "" is a valid key). */
export function toneOf(
  map: Record<string, StatusTone>,
  key: string | null | undefined,
): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/upper wire enum for display (`gate_engaged` → "Gate engaged"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** A date + HH:MM label for an instant (the supervisory / signature ledgers). */
export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

/** A short opaque id label for a PHI-adjacent identifier surfaced in a queue column. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 8);
}

/** Whole days between now and an instant — negative when the instant has passed. */
export function daysUntil(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return Math.floor((ms - now) / 86_400_000);
}

/** A relative-due label for the §7.1 next-due banner and the gate `valid_until` countdown. */
export function dueLabel(value: string | null | undefined, now = Date.now()): string {
  const days = daysUntil(value, now);
  if (days === null) return "—";
  if (days === 0) return "due today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  const overdue = -days;
  return `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
}
