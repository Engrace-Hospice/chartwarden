// apps/backend/src/modules/16-bereavement/lifecycle/cascades.ts — M16-T03 (§2.6, D6, D9).
//
// The three §2.6 side-effect cascades, as PURE deciders. Each answers one question — "given the plan's
// current state and the fact that just arrived, which transition fires?" — and returns a descriptor the
// M16-T06 worker executes through the machines in ./plan and ./contact. Keeping them out of the workers is
// what makes the D9 timing rules testable without a database and a running outbox.
//
//   • {@link decidePatientOptOutFlip} — the M5 `patient.bereavement_opt_out` flag flipping to `true`. §2.6
//     gives THREE different answers depending on when it lands, and the difference is not cosmetic: a plan
//     that never opened is a completed program, an open one is cut short, and an already-closed one is not
//     re-closed.
//   • {@link decideConsentRevocationCascade} — M39 revoked a `bereavement_outreach_consent`. §2.6 is
//     explicit that M39 is the source of truth and M16 does not gate-keep: M16 cascades.
//   • {@link decidePlanCloseOnRoster} — after ANY contact leaves the roster, does D6's all-opted-out
//     condition now hold?
import { shouldCloseAsDeclined } from "@chartwarden/bereavement";
import type {
  BereavedContactId,
  BereavedContactStatus,
  BereavementPlanStatus,
  ConsentId,
} from "@chartwarden/types";

// ── D9 — the M5 patient-level bereavement opt-out flag flips to true (§2.6) ────────────────────────────

/** What the `m5.patient.bereavement_opt_out_changed` consumer does with the flip. */
export type PatientOptOutAction =
  /** No plan row exists yet — M6's own eligibility rule will suppress `m6.bereavement.eligible`, so there
   *  is nothing for M16 to do. */
  | { readonly kind: "no_plan" }
  /** The plan is `eligible` or `initiating` — it never reached the family; fire `skipPerPatientOptOut`. */
  | { readonly kind: "skip" }
  /** The plan is live — fire the cosign-EXEMPT `closeEarly(patient_opt_out_post_creation)` (D7 does not
   *  apply: this is honoring a directive the patient already gave, not a clinical judgment call). */
  | { readonly kind: "close_early" }
  /** Already closed (incl. under an M4 hold) — a redelivery or a late flip; a no-op, never a second close. */
  | { readonly kind: "already_closed" };

/**
 * §2.6 / D9 — decide what a patient-level opt-out flip means for an existing plan.
 *
 * `flaggedOptOut === false` is a no-op on every state: the flag going back to `false` does NOT re-open a
 * closed program. Re-enrolment after a directive was withdrawn is a counselor-driven decision with fresh
 * M39 consent, not something a boolean flip performs silently.
 */
export function decidePatientOptOutFlip(
  planStatus: BereavementPlanStatus | null,
  flaggedOptOut: boolean,
): PatientOptOutAction {
  if (!flaggedOptOut || planStatus === null) return { kind: "no_plan" };
  switch (planStatus) {
    case "eligible":
    case "initiating":
      return { kind: "skip" };
    case "active":
    case "paused":
      return { kind: "close_early" };
    default:
      return { kind: "already_closed" };
  }
}

// ── D6 + D9 — the M39 consent-revocation cascade (§2.6) ───────────────────────────────────────────────

/** The contact rows an `m39.consent.revoked` delivery resolved to. */
export interface ConsentRevocationFacts {
  readonly consentRecordId: ConsentId;
  /** The bereaved contact holding this `consent_record_id`, or null when the revoked consent is not a
   *  bereavement-outreach consent this org's M16 tracks. */
  readonly contactId: BereavedContactId | null;
  readonly contactStatus: BereavedContactStatus | null;
}

/** What the `m39.consent.revoked` consumer does. */
export type ConsentRevocationAction =
  /** Not a consent M16 holds, or the contact already left the roster — nothing to cascade. */
  | { readonly kind: "no_op" }
  /** Fire `optOut(source='m39_revocation_cascade')` on the contact and run the opted-out side effects. */
  | { readonly kind: "cascade_opt_out"; readonly contactId: BereavedContactId };

/**
 * §2.6 — M39 is the source of truth for consent; M16 does not gate-keep, it cascades. The audit reason on
 * the resulting opt-out row is `consent_revoked_via_m39`, which is how a surveyor tells a survivor's own
 * decision apart from a consent-record administrative action.
 *
 * A contact that is already `opted_out` / `deceased` / `ineligible_post_review` is a no-op: cascading again
 * would stamp a second opt-out row and re-fire `contact_opted_out` on every M39 redelivery.
 */
export function decideConsentRevocationCascade(
  facts: ConsentRevocationFacts,
): ConsentRevocationAction {
  if (facts.contactId === null || facts.contactStatus === null) return { kind: "no_op" };
  if (facts.contactStatus !== "active" && facts.contactStatus !== "proposed") {
    return { kind: "no_op" };
  }
  return { kind: "cascade_opt_out", contactId: facts.contactId };
}

// ── D6 — the plan-level close evaluation that runs after any contact leaves the roster ────────────────

/** Whether the plan must now close as `closed_declined` (§2.3 / D6). */
export function decidePlanCloseOnRoster(
  planStatus: BereavementPlanStatus,
  contactStatuses: ReadonlyArray<BereavedContactStatus>,
): boolean {
  if (planStatus !== "active") return false;
  return shouldCloseAsDeclined(contactStatuses);
}
