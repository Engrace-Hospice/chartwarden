// apps/web/src/modules/23-billing-medicare — shared status presentation for the M23 Billing — Medicare
// surfaces (R2, §5.1 / §10 PR-J). Every M23 screen renders the same StatusPill for a given wire enum by
// resolving it through these tone maps, so the §6.6 badge taxonomy is applied ONCE. Mirrors the M33
// reporting-status.ts precedent: one `Record<string, StatusTone>` per wire enum, plus label helpers and
// resolvers-with-default.
//
// Lantern maps the billing domain vocabulary onto the six-tone StatusTone alphabet (status-pill.tsx):
//   progress(primary) ≈ "in flight" (validating / submitted / ack pending)
//   success(green)    ≈ "good / accepted / paid"
//   warning(amber)    ≈ "needs attention / partial / at-risk window / stale eligibility"
//   error(red)        ≈ "failed / denied / breached window / validation error"
//   critical(gold)    ≈ the §10 reserved tone for irreversible/controlled acts (void/replace ceremonies)
//   neutral(gray)     ≈ "inert" (draft / cancelled / voided terminal)
//
// NOE/NOTR WINDOW STATE is the §5.1 anchor (the countdown-to-windowTargetAt badge on every queue card):
// in_window → success · at_risk → warning · breached → error. The six-tone vocab has no separate amber —
// `warning` IS amber (the clock glyph), which is exactly correct for an at-risk filing window.
import type { StatusTone } from "@wardenx/ui";

// ── claim lifecycle (§2.5 claim_state) ────────────────────────────────────────────────────────────────

/**
 * §2.5 claim state machine → §6.6 tone. draft/validating are pre-flight; ready is staged-good; submitted +
 * ack_pending are in flight; ack_accepted/paid are terminal-good; ack_partial/partial_paid need attention;
 * denied is failed; replaced/voided are inert terminal (the §10-gold ceremony that PRODUCES them lives on
 * the action, not the resting badge).
 */
export const CLAIM_STATE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  validating: "progress",
  ready: "success",
  submitted: "progress",
  ack_pending: "progress",
  ack_accepted: "success",
  ack_partial: "warning",
  paid: "success",
  partial_paid: "warning",
  denied: "error",
  replaced: "neutral",
  voided: "neutral",
};

// ── acknowledgment outcome (999 / 277CA / 835) ────────────────────────────────────────────────────────

/** §3 acknowledgment outcome → tone. accepted = good; partial/warn = needs attention; rejected = failed. */
export const ACK_OUTCOME_TONE: Record<string, StatusTone> = {
  accepted: "success",
  partial: "warning",
  rejected: "error",
  error: "error",
  pending: "progress",
  paid: "success",
  denied: "error",
};

// ── submission status ─────────────────────────────────────────────────────────────────────────────────

/** §3 claim_submission status → tone. */
export const SUBMISSION_STATUS_TONE: Record<string, StatusTone> = {
  queued: "progress",
  transmitted: "progress",
  accepted: "success",
  rejected: "error",
  failed: "error",
};

// ── validation severity (error / warn / info) ─────────────────────────────────────────────────────────

/** §11.A validation finding severity → tone. error blocks; warn is advisory; info is inert. */
export const VALIDATION_SEVERITY_TONE: Record<string, StatusTone> = {
  error: "error",
  warn: "warning",
  warning: "warning",
  info: "neutral",
};

/** §11.A validation RUN status → tone (the per-claim aggregate over its findings). */
export const VALIDATION_RUN_TONE: Record<string, StatusTone> = {
  passed: "success",
  passed_with_warnings: "warning",
  failed: "error",
  overridden: "warning",
  running: "progress",
  pending: "progress",
};

// ── eligibility outcome + staleness ───────────────────────────────────────────────────────────────────

/** §4 eligibility outcome → tone. eligible = good; inactive/ineligible = failed; unknown/error = attention. */
export const ELIGIBILITY_OUTCOME_TONE: Record<string, StatusTone> = {
  eligible: "success",
  active: "success",
  inactive: "error",
  ineligible: "error",
  unknown: "warning",
  error: "warning",
  pending: "progress",
};

/** The eligibility staleness floor (§5.1 screen 16): a check older than this surfaces a "stale" highlight. */
export const ELIGIBILITY_STALE_AFTER_DAYS = 30;

/** Eligibility freshness → tone: a check newer than the floor is `success`; older (or absent) is `warning`. */
export function eligibilityStalenessTone(checkedAt: string | null): StatusTone {
  if (!checkedAt) return "warning";
  const ageDays = (Date.now() - new Date(checkedAt).getTime()) / 86_400_000;
  return ageDays <= ELIGIBILITY_STALE_AFTER_DAYS ? "success" : "warning";
}

/** Human label for the eligibility staleness pill. */
export function eligibilityStalenessLabel(checkedAt: string | null): string {
  if (!checkedAt) return "No check on file";
  const ageDays = Math.floor((Date.now() - new Date(checkedAt).getTime()) / 86_400_000);
  if (ageDays <= 0) return "Checked today";
  return ageDays <= ELIGIBILITY_STALE_AFTER_DAYS ? `${ageDays}d ago` : `Stale — ${ageDays}d ago`;
}

// ── NOE / NOTR window tier (in_window / at_risk / breached) ───────────────────────────────────────────

/** §5.1 NOE/NOTR filing-window tier → tone. in_window success · at_risk warning · breached error. */
export const WINDOW_TIER_TONE: Record<string, StatusTone> = {
  in_window: "success",
  at_risk: "warning",
  breached: "error",
};

/** Resolve a NOE/NOTR window tier directly from the days-remaining to `windowTargetAt` (D5 default). */
export function windowTierTone(daysRemaining: number, atRiskThresholdDays = 2): StatusTone {
  if (daysRemaining < 0) return "error"; // breached
  if (daysRemaining <= atRiskThresholdDays) return "warning"; // at risk
  return "success"; // in window
}

/** Human label for the NOE/NOTR window tier from days-remaining (the countdown caption). */
export function windowTierLabel(daysRemaining: number, atRiskThresholdDays = 2): string {
  if (daysRemaining < 0) return `Breached — ${Math.abs(daysRemaining)}d over`;
  if (daysRemaining <= atRiskThresholdDays) return `At risk — ${daysRemaining}d left`;
  return `In window — ${daysRemaining}d left`;
}

/** §5.1 NOE/NOTR record state → tone (draft inert; submitted in flight; accepted good; cancelled inert). */
export const NOE_NOTR_STATE_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  ready: "success",
  submitted: "progress",
  accepted: "success",
  rejected: "error",
  cancelled: "neutral",
};

// ── label helpers (mirror reporting-status.ts) ────────────────────────────────────────────────────────

/** Title-case an underscore enum value, e.g. `ack_pending` → `Ack Pending`. */
export function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Title-case helper alias (mirror M33 `cap`). */
export const cap = (s: string): string => statusLabel(s);

/** Render integer cents as a US-dollar string with tabular-friendly grouping ($1,234.56). */
export function dollars(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

// ── resolvers-with-default (every map gets a `…Tone(value)` that falls back to neutral) ───────────────

/** Resolve a claim state to its tone, defaulting to neutral for unknown values. */
export function claimStateTone(state: string): StatusTone {
  return CLAIM_STATE_TONE[state] ?? "neutral";
}

/** Resolve an acknowledgment outcome to its tone, defaulting to neutral. */
export function ackOutcomeTone(outcome: string): StatusTone {
  return ACK_OUTCOME_TONE[outcome] ?? "neutral";
}

/** Resolve a submission status to its tone, defaulting to neutral. */
export function submissionStatusTone(status: string): StatusTone {
  return SUBMISSION_STATUS_TONE[status] ?? "neutral";
}

/** Resolve a validation finding severity to its tone, defaulting to neutral. */
export function validationSeverityTone(severity: string): StatusTone {
  return VALIDATION_SEVERITY_TONE[severity] ?? "neutral";
}

/** Resolve a validation run status to its tone, defaulting to neutral. */
export function validationRunTone(status: string): StatusTone {
  return VALIDATION_RUN_TONE[status] ?? "neutral";
}

/** Resolve an eligibility outcome to its tone, defaulting to neutral. */
export function eligibilityOutcomeTone(outcome: string): StatusTone {
  return ELIGIBILITY_OUTCOME_TONE[outcome] ?? "neutral";
}

/** Resolve a NOE/NOTR filing-window tier to its tone, defaulting to neutral. */
export function windowTierTierTone(tier: string): StatusTone {
  return WINDOW_TIER_TONE[tier] ?? "neutral";
}

/** Resolve a NOE/NOTR record state to its tone, defaulting to neutral. */
export function noeNotrStateTone(state: string): StatusTone {
  return NOE_NOTR_STATE_TONE[state] ?? "neutral";
}

// ── Type-of-Bill (TOB) — display label only (no tone; TOB is a classifier, not a status) ──────────────

/** The §2 Type-of-Bill values M23 renders, with their human gloss for the claim table TOB column. */
export const TOB_LABEL: Record<string, string> = {
  "811": "811 · Admit-thru-discharge",
  "812": "812 · Interim — first",
  "813": "813 · Interim — continuing",
  "814": "814 · Interim — last",
  "817": "817 · Replacement",
  "818": "818 · Void / cancel",
};

/** Resolve a TOB code to its display label, defaulting to the bare code. */
export function tobLabel(tob: string): string {
  return TOB_LABEL[tob] ?? tob;
}
