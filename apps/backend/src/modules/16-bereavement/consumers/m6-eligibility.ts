// apps/backend/src/modules/16-bereavement/consumers/m6-eligibility.ts — M16-T03 (§4.3.1, §2.6, D16, D18).
//
// M16's subscriber to Module 6's `m6.bereavement.eligible` — the handshake that CLOSES M6's bereavement
// outbox. M6 owns the RULE that a death discharge makes a patient bereavement-eligible (W-DC-01 / M6 D6);
// M16 owns the 13-month program. Neither imports the other: the whole contract is one outbox event name,
// read here as a STRING literal (`M16_SUBSCRIBED_EVENT_NAMES` in `@chartwarden/types` is the shared source of
// truth so an upstream rename breaks the build instead of orphaning this handler).
//
// PHASE-1 PURE DECISION CORE — the M7 `apply-idg-decision` precedent. What ships now is
// {@link decideEligibilityIntake}: given the parsed payload plus the facts the worker reads (the death fact
// resolved through M6's seams, an existing plan for the admission, the M5 patient-level opt-out flag), it
// returns the {@link EligibilityIntakeAction} descriptor. The live outbox binding + the transactional
// insert land with the §4.9 workers in M16-T06.
//
// THE TOCTOU DEFENCE, and why its fail direction is OPEN rather than closed. §4.3.1 re-reads
// `patient.bereavement_opt_out` inside the handler to close the window between M6's check and M16's insert.
// No published seam exposes that flag — M5's `PatientReader` returns identity, not directives — so the
// worker passes `patientOptOut: null` for "could not be determined". A null does NOT suppress the plan:
// M6's own rule already evaluated the flag one transaction earlier, the CoP 418.64(d) obligation is the
// default, and §2.6 gives the flip a complete post-hoc path (`m5.patient.bereavement_opt_out_changed` →
// `skipPerPatientOptOut` while the plan is `eligible`/`initiating`, → cosign-exempt `closeEarly` once it is
// live). Refusing to open a plan because a fact was unreadable would deny a grieving family a regulatory
// service to defend against a race the cascade already handles. An EXPLICIT `true` still skips.
import { applyCosignReceipt } from "@chartwarden/bereavement";
import type {
  AdmissionId,
  BereavementExternalSourceMetadata,
  IsoInstant,
  PatientId,
} from "@chartwarden/types";
import { BereavementStateError, checkDeathDateMatchesAdmission } from "../lifecycle/index";
import { type ResolvedDeathFact, externalSourceMetadataFor } from "./death-discharge";

/** The event name M16 subscribes to. String literal only — M16 never imports M6's catalog. */
export const M6_BEREAVEMENT_ELIGIBLE_EVENT = "m6.bereavement.eligible" as const;

/** The merged M6 payload (apps/backend/src/modules/06-admission/events-by-m6.ts). See
 *  ./death-discharge.ts for why the death instant is READ through a seam rather than taken from here. */
export interface M6BereavementEligiblePayload {
  readonly admissionId: AdmissionId;
  readonly patientId: PatientId;
  /** The instant M6's post-discharge eligibility rule cleared — NOT the instant of death. */
  readonly eligibleAt: IsoInstant;
}

/** Everything the worker reads before it can decide, surfaced as data so the decider stays pure. */
export interface EligibilityIntakeFacts {
  /** A `bereavement_plan` already exists for (org, admission) — `berv_plan_unique_admission`. */
  readonly existingPlan: boolean;
  /** The death fact resolved through M6's seams, or null when the census has none (fail-closed). */
  readonly deathFact: ResolvedDeathFact | null;
  /**
   * The M5 patient-level `bereavement_opt_out` directive. `null` = could not be determined (no seam
   * exposes it today) and is treated as "not opted out" — see the TOCTOU note in the file header.
   */
  readonly patientOptOut: boolean | null;
}

/** The effect the decider resolved for an `m6.bereavement.eligible` delivery. */
export type EligibilityIntakeAction =
  /** A redelivery for an admission that already has a plan — skip (the unique index is the backstop). */
  | { readonly kind: "idempotent_skip" }
  /**
   * D9 — the patient-level directive said no. NO plan row is written and no M36 channel opens; the worker
   * emits `m16.bereavement.plan_skipped_per_patient_opt_out`, which carries no `planId` precisely because
   * there is none.
   */
  | { readonly kind: "skip_per_patient_opt_out"; readonly deathDate: string | null }
  /** Insert the `eligible` plan row (D16 provenance stamped for an external-source death). */
  | {
      readonly kind: "open_plan";
      readonly patientId: PatientId;
      readonly admissionId: AdmissionId;
      readonly providerEntityId: string;
      readonly deathDate: string;
      readonly deathAt: IsoInstant;
      readonly externalSourceMetadata: BereavementExternalSourceMetadata | null;
    };

/**
 * §4.3.1 — decide what an `m6.bereavement.eligible` delivery does.
 *
 * ORDERING matters and follows §2.2's guard note verbatim: idempotency first, then the D9 opt-out (which is
 * checked BEFORE the death fact is required, so a survivor whose family declined the program does not
 * dead-letter on an unresolvable census row), then the fail-closed death-fact resolution, then the §2.5
 * death-date cross-check against M6's own discharge date.
 *
 * Throws `DEATH_FACT_UNRESOLVED` (422) when no death fact resolved and `BEREAVEMENT_DEATH_DATE_MISMATCH`
 * (422) when M6's two surfaces disagree — both dead-letter the delivery for a human rather than opening a
 * 13-month program on a guessed anchor.
 */
export function decideEligibilityIntake(
  payload: M6BereavementEligiblePayload,
  facts: EligibilityIntakeFacts,
): EligibilityIntakeAction {
  if (facts.existingPlan) return { kind: "idempotent_skip" };

  if (facts.patientOptOut === true) {
    return { kind: "skip_per_patient_opt_out", deathDate: facts.deathFact?.deathDate ?? null };
  }

  const fact = facts.deathFact;
  if (fact === null) {
    throw new BereavementStateError(
      "DEATH_FACT_UNRESOLVED",
      `no M6 death-discharge fact resolved for admission ${payload.admissionId}`,
    );
  }

  // §2.5 — M6's `DeathDischargeReader` death instant and its admission-level discharge date must agree.
  // A null `dischargedAt` is NOT a mismatch: M6 records the discharge date on its own schedule (W-DC-01
  // allows a late filing), and the census row is the authoritative death fact either way.
  if (fact.admissionDischargeDate !== null) {
    checkDeathDateMatchesAdmission(fact.deathDate, fact.admissionDischargeDate);
  }

  return {
    kind: "open_plan",
    patientId: fact.patientId,
    admissionId: payload.admissionId,
    providerEntityId: fact.providerEntityId,
    deathDate: fact.deathDate,
    deathAt: fact.deathAt,
    externalSourceMetadata: externalSourceMetadataFor(fact),
  };
}

// ── D18 — the `m6.discharge.cosigned` receipt that releases the external-source gate (§2.6) ────────────

/** The event name the D18 cosign receipt arrives on. String literal only. */
export const M6_DISCHARGE_COSIGNED_EVENT = "m6.discharge.cosigned" as const;

/** The cosign receipt payload M16 reads off `m6.discharge.cosigned`. */
export interface M6DischargeCosignedPayload {
  readonly sourceProposalId: string;
  readonly cosignedAt: IsoInstant;
  readonly medicalDirectorMembershipId: string;
}

/** What the `m6.discharge.cosigned` consumer does (§4.3.1 `receiveCosignAndReleaseGate`). */
export type CosignReceiptAction =
  /** No external-source plan is pending this proposal, or a redelivery of a cosign already applied. */
  | { readonly kind: "no_op" }
  /** Fire the plan machine's state-preserving `receiveCosign` with this metadata (D18). */
  | { readonly kind: "release_gate"; readonly metadata: BereavementExternalSourceMetadata };

/**
 * §4.3.1 / D18 — decide what a `m6.discharge.cosigned` delivery does to a matching external-source plan.
 * The applier in `@chartwarden/bereavement` IS the idempotency check: it returns null for a wrong proposal id
 * or an already-cosigned blob, so a redelivered receipt is a no-op rather than a second update stamping a
 * newer `cosignedAt` over the original attestation.
 */
export function decideCosignReceipt(
  externalSource: BereavementExternalSourceMetadata | null,
  payload: M6DischargeCosignedPayload,
): CosignReceiptAction {
  const metadata = applyCosignReceipt(externalSource, {
    sourceProposalId: payload.sourceProposalId,
    cosignedAt: payload.cosignedAt,
    medicalDirectorMembershipId: payload.medicalDirectorMembershipId,
  });
  return metadata === null ? { kind: "no_op" } : { kind: "release_gate", metadata };
}
