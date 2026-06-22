// @wardenx/dosespot — §2.2 D2 medication-order lifecycle state machine (M12-T03). Pure, IO-free.
//
// M12 extends M11's seven-state order machine to cover the DoseSpot transmission outcomes
// (`signed → queued_for_transmission → transmitted → ack_received | nack_received → active`) and the EPCS
// controlled-substance branch (`pending_signature → epcs_identity_pending → signed`). The §2.2 graph:
//
//   draft ─requestSignature→ pending_signature ─sign→ signed ─enqueueTransmission→ queued_for_transmission
//     │                          │  │  │  └signControlled→ epcs_identity_pending ─completeSecondFactor→ signed
//     │                          │  │  └recordVerbal→ verbal_pending ─sign→ signed / ─expire→ expired_unsigned
//     │                          │  └withdraw→ discontinued                (epcs_identity_pending
//     └discardDraft→ discontinued└                                          ─secondFactorFailed→ pending_signature)
//   queued_for_transmission ─transmissionSucceeded→ transmitted ─pharmacyAck→ ack_received ─activate→ active
//     └transmissionExhausted→ transmission_failed   transmitted ─pharmacyNack→ nack_received ─discontinue→ …
//   active ─complete→ completed ;  active ─discontinue→ discontinued
//   {pending_signature|epcs_identity_pending|queued_for_transmission|active} ─cascadeDiscontinue→ discontinued (D13)
//
// Pure transition function (the M11/M8 convention): it validates the event is legal from the current state
// (nothing transitions on a string match), runs the enumerated §2.2 guards (failures raise the precise code
// via MedicationOrderStateError), and returns the new state + the in-transaction side-effect list — INCLUDING
// the §2.8 D14 `sign_via_m11` / `record_verbal_via_m11` descriptors that name M11's `OrderSignatureProvider`
// calls the service binds at run time. No IO; every fact a guard needs (data complete, allergy/consent
// passed, IAL2 verified, deadline reached, actor authority) is resolved upstream and passed in. The EPCS
// requirement is read from the `@wardenx/dosespot` §2.1 `MED_CLASS_CATALOG`, not re-derived inline.
import type {
  MedClass,
  MedicationOrderStatus,
  MedicationOrderDiscontinuationReason,
  EpcsSecondFactorType,
} from "@wardenx/types";
import { MED_CLASS_CATALOG } from "../classes/catalog";
import { type MedicationOrderSideEffect, type MedicationOrderTransitionResult, result } from "./effects";
import { MedicationOrderStateError, require_ } from "./errors";

export type MedicationOrderState = MedicationOrderStatus;

/**
 * §2.4 / §2.1 — does signing this order route through the EPCS `epcs_identity_pending` branch? Controlled
 * substances always; compounded only when the runtime `data.contains_controlled` flag is set (the catalog's
 * `controlledByDataFlag`); standard never. Read from the catalog so adding a class is one PR (§2.1).
 */
export function isEpcsRequired(medClass: MedClass, containsControlled: boolean): boolean {
  const meta = MED_CLASS_CATALOG[medClass];
  if (meta.schedulesRequiringEpcs.length === 0) return false;
  return meta.controlledByDataFlag ? containsControlled : true;
}

/** The §2.2 medication-order lifecycle events. Per-event facts are resolved upstream and injected as data. */
export type MedicationOrderEvent =
  | {
      readonly type: "requestSignature";
      readonly medClass: MedClass;
      /** §2.2 — the runtime `data.contains_controlled` flag (compounded only); ignored for other classes. */
      readonly containsControlled: boolean;
      /** §2.2 — the per-class required `data` fields are complete (per-class TypeBox lands M12-T08). */
      readonly requiredDataComplete: boolean;
      /** §2.2 — the prescribing discipline is eligible for this med class (`prescriber_eligible`, §4.7). */
      readonly prescriberEligible: boolean;
      /** §2.2 — the allergy / interaction check has passed. */
      readonly allergyCheckPassed: boolean;
      /** §2.2 / §7.8 — the SUD-treatment-medication consent gate is satisfied (true if the med is not SUD). */
      readonly sudConsentSatisfied: boolean;
      /** §2.2 / §2.4 D18 — the tenant's `epcs_certification_status='certified'` (controlled only). */
      readonly tenantEpcsCertified: boolean;
    }
  | {
      readonly type: "discardDraft";
      /** §2.2 — the actor is the drafter or a supervisor. */
      readonly actorMayDiscard: boolean;
      /** §2.2 — the draft is referenced by another `medication_order` (e.g. `replaces_medication_order_id`). */
      readonly hasExternalReferences: boolean;
    }
  | {
      readonly type: "sign";
      readonly medClass: MedClass;
      readonly containsControlled: boolean;
      /** §2.2 — `signer_eligible` (M11 seam) — the signing discipline may sign this order. */
      readonly signerEligible: boolean;
      /** §2.2 — the signer is the named ordering physician (or, only outside the verbal flow, a proxy). */
      readonly signerIsOrderingPhysician: boolean;
    }
  | {
      readonly type: "signControlled";
      readonly medClass: MedClass;
      readonly containsControlled: boolean;
      /** §2.4 / §4.7 — `dea_schedule_authorized[:schedule]` passes for the prescriber. */
      readonly deaScheduleAuthorized: boolean;
      /** §2.4 §1311.115 — the prescriber's `ial2_status='verified'`. */
      readonly prescriberIal2Verified: boolean;
      /** §2.2 / §2.4 D18 — the tenant's `epcs_certification_status='certified'`. */
      readonly tenantEpcsCertified: boolean;
    }
  | {
      readonly type: "completeSecondFactor";
      /** §2.4 §1311.116 — the 2FA challenge completed within the 60s window. */
      readonly challengeCompletedInTime: boolean;
      /** §2.4 §1311.116 — the second-factor type the EPCS challenge used (recorded on the signature). */
      readonly secondFactorType: EpcsSecondFactorType;
    }
  | {
      readonly type: "secondFactorFailed";
      /** §2.4 §1311.116 — the 2FA challenge failed or timed out (audited; order returns to pending). */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "recordVerbal";
      readonly medClass: MedClass;
      readonly containsControlled: boolean;
      /** §2.3 — the recording actor is RN+ holding `prescribing.verbal.record`. */
      readonly recorderEligible: boolean;
      /** §2.3 — the named prescriber is present on the order. */
      readonly namedPrescriberPresent: boolean;
      /** §2.3 — the recording RN attested to the verbal communication (denylisted free text). */
      readonly attestationRecorded: boolean;
    }
  | {
      readonly type: "withdraw";
      /** §2.2 — the actor is the drafter, supervisor, or signer. */
      readonly actorMayWithdraw: boolean;
    }
  | {
      readonly type: "expire";
      /** §2.2 — fired by M11's verbal-timer worker via the M11→M12 backref consumer (not a human actor). */
      readonly isSystemActor: boolean;
      /** §2.2 — `now() >= verbal_order.deadline_at`. */
      readonly deadlineReached: boolean;
    }
  | {
      readonly type: "enqueueTransmission";
      /** §2.2 — fired by the post-sign system hook (not a human actor). */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "transmissionSucceeded";
      /** §2.2 — fired by the `dosespot.transmit_newrx` worker (DoseSpot returned 2xx). */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "transmissionExhausted";
      /** §2.2 — fired by the worker after the retry budget is exhausted. */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "pharmacyAck";
      /** §2.2 — fired by the webhook handler on a `ScriptStatusUpdate` ack (not a human actor). */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "pharmacyNack";
      /** §2.2 — fired by the webhook handler on a `ScriptStatusUpdate` reject. */
      readonly isSystemActor: boolean;
      /** §4.9 — the pharmacy's rejection reason (drives the M36 nack alert). */
      readonly rejectionReason: string;
    }
  | {
      readonly type: "activate";
      /** §2.2 — the immediate `ack_received → active` system transition (no other gate). */
      readonly isSystemActor: boolean;
    }
  | {
      readonly type: "complete";
      /** §2.2 — the one-shot completion criterion is met OR no refills remain and renewal is declined. */
      readonly criterionMet: boolean;
    }
  | {
      readonly type: "discontinue";
      readonly reason: MedicationOrderDiscontinuationReason;
    }
  | {
      readonly type: "cascadeDiscontinue";
      /** §2.2 D13 — fired by the `m6.admission.discharged` consumer (system actor). */
      readonly isSystemActor: boolean;
    };

export type MedicationOrderTransition = MedicationOrderTransitionResult<
  MedicationOrderState,
  MedicationOrderEvent["type"]
>;

/** The legal §2.2 transition graph (from → events accepted). Guards are checked separately. */
export const MEDICATION_ORDER_GRAPH: Readonly<
  Record<MedicationOrderState, ReadonlyArray<MedicationOrderEvent["type"]>>
> = {
  draft: ["requestSignature", "discardDraft"],
  pending_signature: ["sign", "signControlled", "recordVerbal", "withdraw", "cascadeDiscontinue"],
  epcs_identity_pending: ["completeSecondFactor", "secondFactorFailed", "cascadeDiscontinue"],
  verbal_pending: ["sign", "signControlled", "expire", "cascadeDiscontinue"],
  signed: ["enqueueTransmission"],
  queued_for_transmission: ["transmissionSucceeded", "transmissionExhausted", "cascadeDiscontinue"],
  transmitted: ["pharmacyAck", "pharmacyNack", "transmissionExhausted"],
  ack_received: ["activate"],
  nack_received: ["discontinue"],
  active: ["complete", "discontinue", "cascadeDiscontinue"],
  completed: [],
  discontinued: [],
  transmission_failed: [],
  expired_unsigned: [],
};

/**
 * The genesis of a medication order: a `draft` row (§2.2). There is no prior state, so this is a factory,
 * not a transition — the §2.1 authoring guard (`prescriber_eligible`) is composed by the service before this
 * runs. Returns the §2.8 side-effect list the service executes inside the create transaction (audit + the
 * `m12.medication_order.draft_created` outbox event). When the draft is minted from an M11/M32 extraction
 * the service swaps the event for `m12.medication_order.draft_created_from_extraction`.
 */
export function planDraftCreation(fromExtraction = false): ReadonlyArray<MedicationOrderSideEffect> {
  return [
    { kind: "audit" },
    {
      kind: "outbox",
      event: fromExtraction
        ? "m12.medication_order.draft_created_from_extraction"
        : "m12.medication_order.draft_created",
    },
  ];
}

/** The always-emitted sign effects: the M11 sign-seam call + the M12 `signed` outbox event (§2.2 / §4.4). */
function signEffects(
  secondFactorType: EpcsSecondFactorType | undefined,
  extra: ReadonlyArray<MedicationOrderSideEffect>,
): ReadonlyArray<MedicationOrderSideEffect> {
  return [
    { kind: "sign_via_m11", signatureKind: "signature", ...(secondFactorType ? { secondFactorType } : {}) },
    { kind: "set_timestamp", field: "signed_at" },
    { kind: "bump_version" },
    { kind: "audit" },
    { kind: "outbox", event: "m12.medication_order.signed" },
    ...extra,
  ];
}

/** The discontinuation effects shared by `withdraw` / `discontinue` / `cascadeDiscontinue` (§2.2 / §2.12). */
function discontinueEffects(
  reason: MedicationOrderDiscontinuationReason,
): ReadonlyArray<MedicationOrderSideEffect> {
  return [
    { kind: "write_discontinuation", reason },
    { kind: "set_timestamp", field: "discontinued_at" },
    { kind: "bump_version" },
    { kind: "audit" },
    { kind: "outbox", event: "m12.medication_order.discontinued" },
  ];
}

/**
 * Apply a medication-order lifecycle event (§2.2 D2). Throws {@link MedicationOrderStateError}
 * `ILLEGAL_MEDICATION_ORDER_TRANSITION` if the event is not accepted from `from`, or the specific §2.2 guard
 * code on a guard failure. Returns the new state + the ordered side-effect list the service runs in the
 * order's optimistic-locked tx (including the §2.8 D14 M11-seam invocations).
 */
export function transitionMedicationOrder(
  from: MedicationOrderState,
  event: MedicationOrderEvent,
): MedicationOrderTransition {
  if (!MEDICATION_ORDER_GRAPH[from].includes(event.type)) {
    throw new MedicationOrderStateError(
      "ILLEGAL_MEDICATION_ORDER_TRANSITION",
      `medication order cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "requestSignature": {
      require_(
        event.requiredDataComplete,
        "MEDICATION_ORDER_REQUIRED_DATA_INCOMPLETE",
        "the medication order's per-class required data is not complete",
      );
      require_(event.prescriberEligible, "PRESCRIBER_NOT_ELIGIBLE", "the prescribing discipline may not author this medication class");
      require_(event.allergyCheckPassed, "ALLERGY_CHECK_NOT_PASSED", "the allergy / interaction check has not passed");
      require_(event.sudConsentSatisfied, "SUD_CONSENT_REQUIRED", "the SUD-treatment-medication consent gate is not satisfied");
      if (isEpcsRequired(event.medClass, event.containsControlled)) {
        require_(
          event.tenantEpcsCertified,
          "EPCS_NOT_CERTIFIED",
          "controlled-substance prescribing requires the tenant to be DEA EPCS-certified (D18)",
        );
      }
      return result(from, event.type, "pending_signature", [
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.signature_requested" },
      ]);
    }

    case "discardDraft": {
      require_(event.actorMayDiscard, "DISCARD_NOT_PERMITTED", "only the drafter or a supervisor may discard a draft");
      require_(
        !event.hasExternalReferences,
        "MEDICATION_ORDER_HAS_EXTERNAL_REFERENCES",
        "the draft is referenced by another medication order and cannot be discarded",
      );
      // A draft was never visible to chart consumers (§2.2): no downstream outbox event.
      return result(from, event.type, "discontinued", [{ kind: "audit" }]);
    }

    case "sign": {
      // §2.2 — a controlled order MUST take the EPCS `signControlled` path, never the standard `sign`.
      require_(
        !isEpcsRequired(event.medClass, event.containsControlled),
        "SIGN_REQUIRES_EPCS",
        "a controlled-substance order must be signed through the EPCS path (signControlled)",
      );
      require_(event.signerEligible, "SIGNER_NOT_ELIGIBLE", "the signing discipline is not eligible to sign this medication order");
      if (from === "verbal_pending") {
        // §2.3 — the verbal follow-up signer must be the named prescriber; no on-behalf shortcuts (CMS).
        require_(
          event.signerIsOrderingPhysician,
          "VERBAL_SIGNER_NOT_NAMED_PRESCRIBER",
          "the verbal follow-up signature must be applied by the named ordering prescriber",
        );
        return result(from, event.type, "signed", signEffects(undefined, [
          { kind: "outbox", event: "m12.medication_order.verbal_received" },
        ]));
      }
      // from pending_signature — standard (non-EPCS) sign.
      require_(
        event.signerIsOrderingPhysician,
        "SIGNER_NOT_ORDERING_PHYSICIAN",
        "the signer is neither the named ordering physician nor an authorized proxy",
      );
      return result(from, event.type, "signed", signEffects(undefined, []));
    }

    case "signControlled": {
      require_(
        isEpcsRequired(event.medClass, event.containsControlled),
        "NOT_CONTROLLED_FOR_EPCS",
        "signControlled is only valid for controlled-substance orders (use sign)",
      );
      require_(
        event.tenantEpcsCertified,
        "EPCS_NOT_CERTIFIED",
        "controlled-substance prescribing requires the tenant to be DEA EPCS-certified (D18)",
      );
      require_(event.deaScheduleAuthorized, "DEA_SCHEDULE_NOT_AUTHORIZED", "the prescriber is not authorized for this DEA schedule");
      require_(
        event.prescriberIal2Verified,
        "EPCS_PRESCRIBER_NOT_VERIFIED",
        "the prescriber's IAL2 identity proofing is not verified",
      );
      // Enter the EPCS 2FA challenge window; the signature itself is applied on completeSecondFactor.
      return result(from, event.type, "epcs_identity_pending", [{ kind: "audit" }]);
    }

    case "completeSecondFactor": {
      require_(
        event.challengeCompletedInTime,
        "EPCS_2FA_EXPIRED",
        "the EPCS two-factor challenge was not completed within the 60s window",
      );
      // §2.4 §1311.116 — the M11 sign-seam is invoked with the second-factor type populated.
      return result(from, event.type, "signed", signEffects(event.secondFactorType, []));
    }

    case "secondFactorFailed": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the EPCS 2FA-failure transition is a system-actor operation");
      return result(from, event.type, "pending_signature", [
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.epcs_2fa_failed" },
      ]);
    }

    case "recordVerbal": {
      // §2.3 D18 — controlled-substance verbal medication orders are Phase-1 feature-flag OFF.
      require_(
        !isEpcsRequired(event.medClass, event.containsControlled),
        "EPCS_VERBAL_NOT_PERMITTED",
        "controlled-substance verbal medication orders are not permitted in Phase 1 (D18)",
      );
      require_(event.recorderEligible, "VERBAL_RECORDER_NOT_ELIGIBLE", "the recording actor is not authorized to record verbal orders");
      require_(event.namedPrescriberPresent, "VERBAL_PRESCRIBER_REQUIRED", "a named prescriber is required on the medication order");
      require_(event.attestationRecorded, "VERBAL_ATTESTATION_REQUIRED", "a verbal-communication attestation is required");
      return result(from, event.type, "verbal_pending", [
        { kind: "record_verbal_via_m11" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.verbal_received" },
      ]);
    }

    case "withdraw": {
      require_(event.actorMayWithdraw, "WITHDRAW_NOT_PERMITTED", "only the drafter, supervisor, or signer may withdraw");
      return result(from, event.type, "discontinued", discontinueEffects("clinical_judgement"));
    }

    case "expire": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "only M11's verbal-timer worker may expire a verbal order");
      require_(event.deadlineReached, "VERBAL_DEADLINE_NOT_REACHED", "the verbal-order signature deadline has not been reached");
      // §2.3 step 6 — M12 has no parallel event name; the M36 high-severity alert is dispatched directly.
      return result(from, event.type, "expired_unsigned", [
        { kind: "set_timestamp", field: "expired_at" },
        { kind: "audit" },
        { kind: "alert", alert: "medication_order.verbal_expired_unsigned" },
      ]);
    }

    case "enqueueTransmission": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the post-sign enqueue is a system-actor operation");
      return result(from, event.type, "queued_for_transmission", [
        { kind: "write_transmission" },
        { kind: "set_send_state", state: "queued" },
        { kind: "enqueue_transmission_job" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.queued_for_transmission" },
      ]);
    }

    case "transmissionSucceeded": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the transmission-succeeded transition is a system-actor operation");
      return result(from, event.type, "transmitted", [
        { kind: "update_transmission", outcome: "succeeded" },
        { kind: "set_send_state", state: "transmitted" },
        { kind: "set_timestamp", field: "transmitted_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.transmitted" },
      ]);
    }

    case "transmissionExhausted": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the transmission-exhausted transition is a system-actor operation");
      return result(from, event.type, "transmission_failed", [
        { kind: "update_transmission", outcome: "failed" },
        { kind: "set_send_state", state: "failed" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.transmission_failed" },
        { kind: "alert", alert: "medication_order.transmission_failed" },
      ]);
    }

    case "pharmacyAck": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the pharmacy-ack transition is a webhook (system-actor) operation");
      return result(from, event.type, "ack_received", [
        { kind: "set_send_state", state: "acked" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.ack_received" },
      ]);
    }

    case "pharmacyNack": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the pharmacy-nack transition is a webhook (system-actor) operation");
      return result(from, event.type, "nack_received", [
        { kind: "set_send_state", state: "nacked" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.nack_received" },
        { kind: "alert", alert: "medication_order.nack_received" },
      ]);
    }

    case "activate": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the activate transition is a system-actor operation");
      // §2.2 — the downstream-relevant event: M13 eMAR may now record administrations against this order.
      return result(from, event.type, "active", [
        { kind: "set_timestamp", field: "activated_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.active" },
      ]);
    }

    case "complete": {
      require_(event.criterionMet, "COMPLETION_CRITERION_NOT_MET", "the one-shot / no-refill completion criterion is not met");
      return result(from, event.type, "completed", [
        { kind: "set_timestamp", field: "completed_at" },
        { kind: "audit" },
        { kind: "outbox", event: "m12.medication_order.completed" },
      ]);
    }

    case "discontinue": {
      // §2.12 — discontinuation is a command: a `medication_order_discontinuation` row is written in tx.
      return result(from, event.type, "discontinued", discontinueEffects(event.reason));
    }

    case "cascadeDiscontinue": {
      require_(event.isSystemActor, "NOT_SYSTEM_ACTOR", "the discharge-cascade is a system-actor operation");
      return result(from, event.type, "discontinued", discontinueEffects("admission_discharged"));
    }
  }
}
