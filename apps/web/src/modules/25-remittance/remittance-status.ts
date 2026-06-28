// apps/web/src/modules/25-remittance — shared status presentation for the M25 Remittance & Denials
// surfaces (R2, §5 / §6.6). Every M25 screen renders the same StatusPill for a given wire enum by resolving
// it through these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M23 billing-status.ts / M33
// reporting-status.ts precedent): one `Record<string, StatusTone>` per wire enum + label/format helpers.
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/posted/paid · warning≈needs-attention/
// at-risk · error≈failed/denied · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@wardenx/ui";

/** remittance_advice parse_status → §6.6 tone. */
export const PARSE_STATUS_TONE: Record<string, StatusTone> = {
  queued: "neutral",
  parsing: "progress",
  parsed: "progress",
  posted: "success",
  partial_posted: "warning",
  failed: "error",
};

/** remittance_line match_state → tone. unmatched is the worklist signal (needs attention). */
export const MATCH_STATE_TONE: Record<string, StatusTone> = {
  unmatched: "warning",
  auto_matched: "progress",
  manual_matched: "progress",
  reversed: "error",
  posted: "success",
};

/** denial category → tone. denial/recoupment are actionable failures; informational is inert. */
export const DENIAL_CATEGORY_TONE: Record<string, StatusTone> = {
  denial: "error",
  reduction: "warning",
  informational: "neutral",
  recoupment: "error",
  unmapped: "warning",
};

/** denial_case state → tone. */
export const DENIAL_STATE_TONE: Record<string, StatusTone> = {
  open: "warning",
  in_progress: "progress",
  escalated: "error",
  appealed: "progress",
  resolved: "success",
  closed: "neutral",
};

/** appeal_case state → tone. */
export const APPEAL_STATE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  submitted: "progress",
  under_review: "progress",
  decided: "success",
  withdrawn: "neutral",
  closed: "neutral",
};

/** appeal decision_outcome → tone. */
export const APPEAL_OUTCOME_TONE: Record<string, StatusTone> = {
  favorable: "success",
  partial: "warning",
  unfavorable: "error",
};

/** The six denial aging buckets → tone (the longer the wait, the hotter). */
export const AGING_BUCKET_TONE: Record<string, StatusTone> = {
  "0-7": "success",
  "8-15": "progress",
  "16-30": "warning",
  "31-60": "warning",
  "61-90": "error",
  "91+": "error",
};

/** Resolve a wire enum to a tone with a neutral default (an unknown value never throws / never goes red). */
export function toneOf(map: Record<string, StatusTone>, value: string | null | undefined): StatusTone {
  return (value ? map[value] : undefined) ?? "neutral";
}

/** Title-case a snake_case wire enum for a pill label (e.g. `partial_posted` → "Partial Posted"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format a numeric(12,2) decimal-dollar string as USD (the M25 wire amounts are dollars, not cents). */
export function money(value: string | number | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
