// apps/web/src/modules/25-remittance — shared status presentation for the M25 Remittance & Denials
// surfaces (R2, §5 / §6.6). Every M25 screen renders the same StatusPill for a given wire enum by resolving
// it through these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M23 billing-status.ts / M33
// reporting-status.ts precedent): one `Record<string, StatusTone>` per wire enum + label/format helpers.
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/posted/paid · warning≈needs-attention/
// at-risk · error≈failed/denied · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@chartwarden/ui";

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
  escalated: "progress", // a late QIC reconsideration moved to OMHA (milestone 4)
  withdrawn: "neutral",
  closed: "neutral",
};

/** beneficiary_appeal state → tone (a record the hospice keeps; "decided" is the notice's outcome, not ours). */
export const BENEFICIARY_STATE_TONE: Record<string, StatusTone> = {
  recorded: "neutral",
  supporting: "progress",
  decided: "success",
  closed: "neutral",
  withdrawn: "neutral",
};

/** Representative status (derived from typed dates by the server) → tone. none_on_file is the one that needs attention. */
export const REPRESENTATIVE_STATUS_TONE: Record<string, StatusTone> = {
  none_on_file: "warning",
  draft: "neutral",
  active: "success",
  validity_end_passed_as_recorded: "warning",
  revoked: "error",
  superseded: "neutral",
};

/** adr_case state → tone. */
export const ADR_STATE_TONE: Record<string, StatusTone> = {
  received: "warning",
  in_assembly: "progress",
  in_review: "progress",
  submitted: "success",
  denied_no_response: "error",
  withdrawn: "neutral",
  closed: "neutral",
};

/** reopening_case state → tone (milestone 3). */
export const REOPENING_STATE_TONE: Record<string, StatusTone> = {
  draft: "warning",
  submitted: "progress",
  decided: "success",
  withdrawn: "neutral",
  closed: "neutral",
};

/** submission_attempt status → tone (milestone 6a). needs_manual is "proof missing": it must read as needing attention. */
export const SUBMISSION_STATUS_TONE: Record<string, StatusTone> = {
  prepared: "progress",
  queued: "progress",
  sending: "progress",
  sent: "progress",
  acknowledged: "success",
  needs_manual: "warning",
  failed: "error",
  cancelled: "neutral",
};

/** tpe_program state → tone (milestone 5). Referred is the bad outcome; compliant is relief. */
export const TPE_PROGRAM_STATE_TONE: Record<string, StatusTone> = {
  active: "progress",
  compliant: "success",
  referred: "error",
  closed: "neutral",
};

/** Advisory TPE referral risk → tone (milestone 5). Not a CMS determination; unknown is inert. */
export const TPE_RISK_TONE: Record<string, StatusTone> = {
  relief: "success",
  low: "success",
  unknown: "neutral",
  elevated: "warning",
  high: "error",
  referred: "error",
};

/** audit_request state → tone (milestone 7a-1). The authority kind is a label only; no state implies a CMS rule. */
export const AUDIT_STATE_TONE: Record<string, StatusTone> = {
  received: "warning",
  in_assembly: "progress",
  in_review: "progress",
  responded: "success",
  closed: "neutral",
  withdrawn: "neutral",
};

/** audit_request dueState → tone. A case with no recorded due date is loud: it is not "fine", it is unknown. */
export const AUDIT_DUE_TONE: Record<string, StatusTone> = {
  no_deadline_recorded: "error",
  none_stated: "neutral",
  open: "progress",
  past: "error",
  not_applicable: "neutral",
};

/** recorded_deadline status → tone (milestone 7a-1). */
export const RECORDED_DEADLINE_TONE: Record<string, StatusTone> = {
  open: "progress",
  due_soon: "warning",
  past: "error",
  satisfied: "success",
};

/** The path a denial takes → tone. Undetermined is inert: the denial stays appealable exactly as before. */
export const DENIAL_ROUTE_TONE: Record<string, StatusTone> = {
  appeal: "progress",
  reopening: "warning",
  undetermined: "neutral",
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
export function toneOf(
  map: Record<string, StatusTone>,
  value: string | null | undefined,
): StatusTone {
  return (value ? map[value] : undefined) ?? "neutral";
}

/** Title-case a snake_case wire enum for a pill label (e.g. `partial_posted` → "Partial Posted"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format a numeric(12,2) decimal-dollar string as USD (the M25 wire amounts are dollars, not cents). */
export function money(value: string | number | null | undefined): string {
  const n =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * A calendar day for display. A date-only string (YYYY-MM-DD) is a day, not an instant: formatting it through
 * `new Date(str)` parses it as UTC midnight and shows the previous day west of Greenwich, so it is formatted in UTC.
 * A full timestamp is an instant and is shown in the viewer's zone.
 */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const m = DATE_ONLY.exec(value);
  if (m) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(
      undefined,
      { timeZone: "UTC" },
    );
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}
