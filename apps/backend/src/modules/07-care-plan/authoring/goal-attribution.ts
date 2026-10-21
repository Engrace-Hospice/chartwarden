// apps/backend/src/modules/07-care-plan/authoring/goal-attribution.ts — M7-T06 (§7.3, §7.5).
//
// Goal authoring attribution — the read-side projection of the two preservation rules the write path
// already enforces (service.addGoal / checkPatientStatedGoalVerbatim, M7-T03/T05):
//
//  • §7.3 patient-stated goal preservation: `original_text` is stored verbatim and never mutated; a
//    clinical revision lands in `revised_text` with `status='revised'`. The UI shows BOTH lines
//    ("Original (patient): …; Revised (clinical): …"). `projectGoalAttribution` builds that dual view.
//
//  • §7.5 DPOA-attributed decisions: an `agent_stated` goal carries `acting_consent_id` (the active
//    `dpoa_healthcare` consent at write time, gated by the `dpoa_active` predicate). If the DPOA is
//    revoked LATER the prior entry stays in the record, annotated "consent revoked on <date>" — the row
//    is never deleted or rewritten. `consentRevokedAt` is resolved upstream (Module 39) and passed in.
//
// Pure projection — no I/O. The verbatim/consent WRITE guards live in lifecycle/validation.ts and
// routes/service.ts; this file only renders what those guards preserved.
import type { GoalSource } from "@chartwarden/types";

/** The stored goal fields the attribution view reads (the slice/Drizzle row subset). */
export interface AttributableGoal {
  readonly id: string;
  readonly source: GoalSource;
  readonly originalText: string;
  readonly revisedText: string | null;
  readonly actingConsentId: string | null;
}

/** Who a goal is attributed to (drives the §7.3/§7.5 "(patient)" / "(agent)" / "(clinical)" label). */
export type GoalAttributionParty = "patient" | "family" | "agent" | "clinical";

/** The dual-text + attribution view the care-plan goal panel renders (§7.3 / §7.5). */
export interface GoalAttributionView {
  readonly goalId: string;
  readonly attributedTo: GoalAttributionParty;
  /** The verbatim text as first captured (§7.3 — immutable once the row exists). */
  readonly originalText: string;
  /** The clinical revision, when present (null until a revision lands). */
  readonly revisedText: string | null;
  /** Whether a clinical revision has superseded the original for display. */
  readonly revised: boolean;
  /** The `dpoa_healthcare` consent the agent acted under (§7.5; null unless `agent_stated`). */
  readonly actingConsentId: string | null;
  /** Set when an `agent_stated` goal's DPOA was revoked after the fact (§7.5 annotation; row preserved). */
  readonly consentRevokedNote: string | null;
}

const ATTRIBUTION_BY_SOURCE: Readonly<Record<GoalSource, GoalAttributionParty>> = {
  clinical: "clinical",
  patient_stated: "patient",
  family_stated: "family",
  agent_stated: "agent",
};

/**
 * §7.3/§7.5 — project a goal into its dual-text attribution view. For an `agent_stated` goal whose DPOA
 * was later revoked, pass `consentRevokedAt` (ISO date) to attach the preservation annotation; the
 * original entry is rendered unchanged alongside it.
 */
export function projectGoalAttribution(
  goal: AttributableGoal,
  opts: { readonly consentRevokedAt?: string | null } = {},
): GoalAttributionView {
  const consentRevokedAt = opts.consentRevokedAt ?? null;
  const consentRevokedNote =
    goal.source === "agent_stated" && consentRevokedAt
      ? `consent revoked on ${consentRevokedAt}`
      : null;
  return {
    goalId: goal.id,
    attributedTo: ATTRIBUTION_BY_SOURCE[goal.source],
    originalText: goal.originalText,
    revisedText: goal.revisedText,
    revised: goal.revisedText !== null,
    actingConsentId: goal.actingConsentId,
    consentRevokedNote,
  };
}
