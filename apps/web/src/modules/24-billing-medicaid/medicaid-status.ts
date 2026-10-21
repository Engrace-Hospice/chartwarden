// apps/web/src/modules/24-billing-medicaid — shared status presentation for the M24 Billing — Medicaid
// surfaces (R2, §5 / §6.6). Every M24 screen renders the same StatusPill for a given wire enum through
// these tone maps, so the §6.6 badge taxonomy is applied ONCE (the M23 billing-status.ts / M25
// remittance-status.ts / M26 cap-status.ts precedent).
//
// Lantern six-tone alphabet: progress≈in-flight · success≈good/paid · warning≈needs-attention ·
// error≈failed/denied · critical(gold)≈reserved irreversible ceremony · neutral≈inert/terminal.
import type { StatusTone } from "@chartwarden/ui";

/** `m24_claim_state` → §6.6 tone. In-flight states are progress; the biller's worklist signals are
 * warning/error; PAID is the only success; the post-terminal states are inert neutral. */
export const CLAIM_STATE_TONE: Record<string, StatusTone> = {
  DRAFT: "neutral",
  VALIDATING: "progress",
  FAILED_VALIDATION: "error",
  READY: "progress",
  AWAITING_MEDICARE_PRIMARY: "warning",
  FAILED_MEDICARE_PRIMARY: "error",
  SUBMITTED: "progress",
  POLLING: "progress",
  ACK_PENDING: "progress",
  ACK_TIMEOUT: "warning",
  ACK_ACCEPTED: "progress",
  ACK_REJECTED: "error",
  ACK_PARTIAL: "warning",
  PAID: "success",
  DENIED: "error",
  REPLACED: "neutral",
  VOIDED: "neutral",
  ABANDONED: "neutral",
};

/** The claim states that put a claim on a biller's worklist (§5.1 validation worklist). */
export const WORKLIST_CLAIM_STATES: readonly string[] = [
  "FAILED_VALIDATION",
  "ACK_PARTIAL",
  "ACK_REJECTED",
  "ACK_TIMEOUT",
  "FAILED_MEDICARE_PRIMARY",
  "DENIED",
];

/** `m24_validation_outcome` → tone. `skip_not_applicable` is inert (the rule did not apply to this state). */
export const VALIDATION_OUTCOME_TONE: Record<string, StatusTone> = {
  pass: "success",
  fail: "error",
  warn: "warning",
  info: "progress",
  skip_not_applicable: "neutral",
};

/** `m24_submission_result` → tone. A transport failure/timeout is retryable (warning), a sync reject is not. */
export const SUBMISSION_RESULT_TONE: Record<string, StatusTone> = {
  pending: "progress",
  accepted_sync: "success",
  pending_async: "progress",
  rejected_sync: "error",
  transport_failure: "warning",
  timeout: "warning",
  cancelled: "neutral",
};

/** `m24_acknowledgment_outcome` → tone. */
export const ACK_OUTCOME_TONE: Record<string, StatusTone> = {
  accepted: "success",
  rejected: "error",
  partial: "warning",
};

/** `m24_eligibility_outcome` → tone. `unknown`/`error` are the biller's follow-up signals. */
export const ELIGIBILITY_OUTCOME_TONE: Record<string, StatusTone> = {
  active: "success",
  inactive: "error",
  unknown: "warning",
  mco_assignment: "progress",
  error: "error",
};

/** `m24_rb_arrangement_state` → tone. TERMINATED/SUPERSEDED/EXPIRED are inert terminals. */
export const RB_ARRANGEMENT_STATE_TONE: Record<string, StatusTone> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  EXPIRED: "neutral",
  TERMINATED: "neutral",
  SUPERSEDED: "neutral",
};

/** `m24_rb_day_status` → tone. `pending` still needs a decision; `excluded`/`voided` are removed from billing. */
export const RB_DAY_STATUS_TONE: Record<string, StatusTone> = {
  pending: "warning",
  billable: "progress",
  excluded: "neutral",
  voided: "neutral",
  billed: "success",
};

/** Sandbox connectivity-test result → tone (the credential screen's health signal). */
export const SANDBOX_RESULT_TONE: Record<string, StatusTone> = {
  ok: "success",
  pass: "success",
  fail: "error",
  error: "error",
  never: "neutral",
};

/** Resolve a wire enum through a tone map, defaulting to neutral (use `?` not `&&` — empty string is valid). */
export function toneOf(
  map: Record<string, StatusTone>,
  key: string | null | undefined,
): StatusTone {
  return key ? (map[key] ?? "neutral") : "neutral";
}

/** Title-case a snake/upper wire enum for display (e.g. `FAILED_VALIDATION` → "Failed validation"). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The §5.1 claim-kind labels (combined / hospice-only / R&B-only). */
export function kindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "combined_hospice_rb":
      return "Combined (hospice + R&B)";
    case "hospice_only":
      return "Hospice only";
    case "rb_only":
      return "R&B only";
    default:
      return humanize(kind);
  }
}

/** The §2.3 type-of-bill labels — 811–814 originals, 817 replacement, 818 void. */
export function tobLabel(tob: string | null | undefined): string {
  switch (tob) {
    case "811":
      return "811 · Admit-through-discharge";
    case "812":
      return "812 · Interim first";
    case "813":
      return "813 · Interim continuing";
    case "814":
      return "814 · Interim last";
    case "817":
      return "817 · Replacement";
    case "818":
      return "818 · Void / cancel";
    default:
      return tob ?? "—";
  }
}

/** The §4.4 channel labels (how the claim reaches the state). */
export function channelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case "direct_mmis":
      return "Direct MMIS";
    case "cco_clearinghouse":
      return "CCO / clearinghouse";
    case "sftp":
      return "SFTP";
    case "portal":
      return "Payer portal";
    case "state_proprietary":
      return "State proprietary";
    default:
      return humanize(channel);
  }
}

/** The acknowledgment-kind labels (X12 999 / 277CA / state-specific). */
export function ackKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "sync_999":
      return "999 functional ack";
    case "sync_277ca":
      return "277CA claim ack";
    case "async_state_specific":
      return "State ack file";
    default:
      return humanize(kind);
  }
}

/** Render integer cents as USD (e.g. 3446534 → "$34,465.34"). */
export function money(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Render a 0..1 fraction as a percentage label. `isFraction` defaults true. */
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

/** A short opaque id label for a PHI-adjacent identifier surfaced in a queue column. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 8);
}
