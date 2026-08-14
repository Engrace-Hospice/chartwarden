// apps/admin/src/modules/32-ai-platform — shared status presentation for the §5.1 AI Safety Owner
// console (GAP-049). Every screen resolves a wire enum to the §6.6 StatusPill taxonomy through these
// maps, so the badge vocabulary is applied once. The keys mirror the backend's `m32-typebox.ts` literal
// unions verbatim — including the lifecycle states' UPPERCASE form, which is what the wire carries.
import type { StatusTone } from "@wardenx/ui";

/**
 * §2.2 capability lifecycle FSM (8 states) → tone. The one judgement worth stating: `MONITORING` reads
 * `success`, not `progress` — it is the steady state of an approved capability in production, not an
 * in-flight step. `DEPRECATED` is `warning` (still serving, on its way out); `RETIRED` is `neutral`.
 */
export const LIFECYCLE_TONE: Record<string, StatusTone> = {
  PROPOSED: "neutral",
  DESIGN_REVIEW: "progress",
  EVALUATION: "progress",
  PILOT: "progress",
  APPROVED: "success",
  MONITORING: "success",
  DEPRECATED: "warning",
  RETIRED: "neutral",
};

/** The §2.2 FSM's forward edges — used by the transition dialog to offer only reachable states. */
export const LIFECYCLE_EDGES: Record<string, readonly string[]> = {
  PROPOSED: ["DESIGN_REVIEW"],
  DESIGN_REVIEW: ["EVALUATION"],
  EVALUATION: ["PILOT"],
  PILOT: ["APPROVED"],
  APPROVED: ["MONITORING", "DEPRECATED"],
  MONITORING: ["APPROVED", "DEPRECATED"],
  DEPRECATED: ["RETIRED"],
  RETIRED: [],
};

/**
 * The `ai_lifecycle_approval_kind` each edge records. The route re-checks this server-side (§2.2 owns
 * the edge table); offering the right default here just stops the operator guessing.
 */
export const EDGE_APPROVAL_KIND: Record<string, string> = {
  DESIGN_REVIEW: "stage_2_design_review",
  EVALUATION: "stage_3_evaluation",
  PILOT: "stage_4_pilot",
  APPROVED: "stage_5_ga",
  MONITORING: "reapproval",
  DEPRECATED: "deprecation",
  RETIRED: "retirement",
};

/**
 * §2.1 risk tier → tone. A `high` tier reads `critical` rather than `error`: nothing has failed, but
 * §6.6 reserves `critical` for the safety-bearing surfaces, which is what a high-risk clinical AI
 * capability is.
 */
export const RISK_TIER_TONE: Record<string, StatusTone> = {
  low: "neutral",
  medium: "warning",
  high: "critical",
};

/** `ai_invocation_status` → tone. */
export const INVOCATION_TONE: Record<string, StatusTone> = {
  completed: "success",
  failed: "error",
  timed_out: "error",
  killed: "critical",
  capability_unavailable: "warning",
};

/** `ai_hallucination_triage_status` (D9's queue) → tone. */
export const TRIAGE_TONE: Record<string, StatusTone> = {
  open: "error",
  investigating: "progress",
  root_cause_identified: "progress",
  mitigated: "warning",
  closed: "success",
  escalated_to_clinical_safety: "critical",
};

/** The D9 queue's column order — `escalated_to_clinical_safety` sits first so it cannot be scrolled past. */
export const TRIAGE_COLUMNS = [
  "escalated_to_clinical_safety",
  "open",
  "investigating",
  "root_cause_identified",
  "mitigated",
  "closed",
] as const;

/** `ai_hallucination_severity` → tone. `critical` is D16's SEV-1 trigger. */
export const SEVERITY_TONE: Record<string, StatusTone> = {
  low: "neutral",
  medium: "warning",
  high: "error",
  critical: "critical",
};

/** `ai_evaluation_run_status` → tone. */
export const EVAL_TONE: Record<string, StatusTone> = {
  pending: "neutral",
  in_progress: "progress",
  passed: "success",
  failed: "error",
  aborted: "neutral",
};

/** Tenant opt-in status → tone. */
export const OPT_IN_TONE: Record<string, StatusTone> = {
  opted_in: "success",
  paused: "warning",
  opted_out: "neutral",
};

const lookup =
  (map: Record<string, StatusTone>) =>
  (key: string | null | undefined): StatusTone =>
    (key ? map[key] : undefined) ?? "neutral";

export const lifecycleTone = lookup(LIFECYCLE_TONE);
export const riskTierTone = lookup(RISK_TIER_TONE);
export const invocationTone = lookup(INVOCATION_TONE);
export const triageTone = lookup(TRIAGE_TONE);
export const severityTone = lookup(SEVERITY_TONE);
export const evalTone = lookup(EVAL_TONE);
export const optInTone = lookup(OPT_IN_TONE);

/**
 * §5.1.5 SLA: an UNCLOSED report older than 48h is SEV-yellow, older than 72h SEV-red. Returned as a
 * tone + label pair so the queue column and the card agree. `null` = inside SLA, nothing to show.
 *
 * Keyed on `reportedAt` and the CLOSED-ness of the row, not on `triagedAt`: the clock the §5.1.5 SLA
 * describes runs from when a clinician filed the report, and acknowledging one without resolving it
 * does not stop it.
 */
export function slaBreach(
  reportedAt: string,
  closedAt: string | null,
  now: Date,
): { tone: StatusTone; label: string } | null {
  if (closedAt) return null;
  const ageHours = (now.getTime() - new Date(reportedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours)) return null;
  if (ageHours >= 72) return { tone: "critical", label: `SLA breached · ${Math.floor(ageHours)}h` };
  if (ageHours >= 48) return { tone: "warning", label: `SLA at risk · ${Math.floor(ageHours)}h` };
  return null;
}

/**
 * §5.1.6 forecast status. Reads the PROJECTED window total against the caps, not the spend so far: a
 * tenant at 40% of its cap on day 3 of a 30-day window is not "green".
 */
export function forecastStatus(
  projected: number,
  softCap: number | null,
  hardCap: number | null,
): { tone: StatusTone; label: string } {
  if (hardCap !== null && projected >= hardCap)
    return { tone: "error", label: "Projected over hard cap" };
  if (softCap !== null && projected >= softCap)
    return { tone: "warning", label: "Projected over soft cap" };
  return { tone: "success", label: "Within caps" };
}

/**
 * §D11 drift thresholds — 10% / 20% / 30% deltas vs baseline — as a tone, so the §5.1.8 heat-map cell
 * and a capability's Drift tab colour identically. `Math.abs` because drift in either direction is
 * drift: a refusal rate that COLLAPSED is as much a signal as one that spiked.
 */
export function driftTone(delta: number): StatusTone {
  const magnitude = Math.abs(delta);
  if (magnitude >= 0.3) return "critical";
  if (magnitude >= 0.2) return "error";
  if (magnitude >= 0.1) return "warning";
  return "success";
}
