// apps/web/src/modules/26-cap — shared status presentation for the M26 Cap Management surfaces (R2, §5 /
// §6.6). Every M26 screen renders the same StatusPill for a given wire enum through these tone maps, so the
// §6.6 badge taxonomy is applied ONCE (the M23 billing-status.ts / M25 remittance-status.ts precedent).
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/safe · warning≈needs-attention/at-risk ·
// error≈breach/failed · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@chartwarden/ui";

/** cap_period status → §6.6 tone. settled is the inert terminal; reopened is the audit-heavy amber. */
export const PERIOD_STATUS_TONE: Record<string, StatusTone> = {
  open: "progress",
  active: "progress",
  in_settlement: "warning",
  settled: "neutral",
  reopened: "warning",
};

/** cap alert_band → tone. The forward-looking signal: safe→success, watch/warn→warning, breach→error. */
export const BAND_TONE: Record<string, StatusTone> = {
  safe: "success",
  watch_90: "warning",
  warn_95: "warning",
  breach_100: "error",
  inpatient_safe: "success",
  inpatient_watch_18: "warning",
  inpatient_breach_20: "error",
};

/** cap_settlement status → tone. final is the inert terminal (post-ceremony). */
export const SETTLEMENT_STATUS_TONE: Record<string, StatusTone> = {
  proposed: "progress",
  reviewed: "warning",
  final: "neutral",
};

/** cap_psr_recon status → tone. open/investigating are the worklist signals. */
export const PSR_RECON_TONE: Record<string, StatusTone> = {
  open: "warning",
  investigating: "progress",
  resolved: "success",
  accepted: "neutral",
};

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — empty string is valid). */
export function toneOf(
  map: Record<string, StatusTone>,
  key: string | null | undefined,
): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/lower wire enum for display (e.g. `in_settlement` → "In settlement"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Render integer cents as USD (e.g. 3446534 → "$34,465.34"). */
export function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Render a 0..1+ fraction (or a percent number) as a percentage label. `isFraction` defaults true. */
export function pct(value: number | null | undefined, isFraction = true): string {
  if (value == null) return "—";
  const n = isFraction ? value * 100 : value;
  return `${n.toFixed(1)}%`;
}

/** A short ISO-date label (YYYY-MM-DD) from an instant or date string. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}
