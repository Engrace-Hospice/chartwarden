// @wardenx/dosespot — §2.3 verbal-medication-order workflow (M12-T03). Pure, IO-free.
//
// Per D3 the signature primitive — INCLUDING the verbal-order timer — is M11's responsibility. M12 has no
// parallel timer (§2.3 "Why M12 has no parallel timer"): it *uses* M11's `OrderSignatureProvider` primitive
// and otherwise stays out of the timer business, the same separation-of-concerns pattern as M9 ↔ M7. This
// module is the explicit M11-seam consumption surface: it maps M12 medication-order facts into the M11
// `RecordVerbalOrderInput` / `SignOrderTargetInput` payloads the service hands to the registered seam, and
// it enforces the §2.3 / D18 class gate (controlled-substance verbal orders are Phase-1 feature-flag OFF).
//
// The non-controlled verbal flow (§2.3 steps 1-6):
//   1. RN drafts the medication order (med_class='standard').
//   2. RN requests signature → pending_signature (the machine's `requestSignature`).
//   3. RN records the verbal → the machine's `recordVerbal` emits `record_verbal_via_m11`; the service calls
//      M11 `recordVerbalOrder({ targetKind:'medication_order' })`; M11 inserts the `verbal_order` row with
//      `deadline_at = received_at + 48h` (or the tenant-tightened window per M11 D3).
//   4. The order is active for clinical execution during the window (M13 may administer); M36 DMs the prescriber.
//   5. The prescriber signs from the inbox → the machine's `sign` emits `sign_via_m11`; on success the row
//      transitions signed → … → active and the DoseSpot NewRx transmits.
//   6. If M11's worker flips the `verbal_order` to expired_unsigned, the M11→M12 backref consumer drives the
//      machine's `expire` transition and the M36 high-severity alert (M12-T08 wires the consumer).
import type {
  EpcsSecondFactorType,
  MedClass,
  RecordVerbalOrderInput,
  SignOrderTargetInput,
} from "@wardenx/types";
import { require_ } from "./errors";
import { isEpcsRequired } from "./medication-order-machine";

/** The M12 medication-order facts the §2.3 M11-seam payload builders read (no Drizzle row crosses here). */
export interface VerbalMedicationOrderFacts {
  readonly organizationId: string;
  readonly medicationOrderId: string;
  readonly medClass: MedClass;
  /** The runtime `data.contains_controlled` flag (compounded only). */
  readonly containsControlled: boolean;
  /** The recording RN's membership id (M11 attributes the verbal-receipt to this actor). */
  readonly recordingMembershipId: string;
  /** The M40 ExternalPhysician id of the named ordering prescriber (the eventual signer). */
  readonly orderingPhysicianMdmId: string;
  /** The verbal-communication attestation text (100-2000 chars; denylisted in audit). */
  readonly verbalAttestation: string;
  /** When the verbal order was received (ISO; M11 derives `deadline_at` from this). */
  readonly receivedAt: string;
}

/**
 * §2.3 / D18 — verbal medication orders are permitted only for non-controlled classes in Phase 1. Throws
 * `EPCS_VERBAL_NOT_PERMITTED` for any controlled order (the DEA emergency-exception path is Phase-2). Call
 * this before requesting M11's verbal primitive; the machine's `recordVerbal` repeats the guard as defense.
 */
export function assertVerbalAllowedForClass(medClass: MedClass, containsControlled: boolean): void {
  require_(
    !isEpcsRequired(medClass, containsControlled),
    "EPCS_VERBAL_NOT_PERMITTED",
    "controlled-substance verbal medication orders are not permitted in Phase 1 (D18)",
  );
}

/**
 * §2.3 step 3 — build the M11 `recordVerbalOrder` payload for this medication order. The `targetKind` is
 * pinned to `'medication_order'` so M11's `verbal_order` row + its verbal-timer worker treat the row
 * identically to a clinical-order verbal. Asserts the §2.3 / D18 class gate first.
 */
export function buildVerbalRecordInput(facts: VerbalMedicationOrderFacts): RecordVerbalOrderInput {
  assertVerbalAllowedForClass(facts.medClass, facts.containsControlled);
  return {
    organizationId: facts.organizationId,
    targetKind: "medication_order",
    targetId: facts.medicationOrderId,
    recordingMembershipId: facts.recordingMembershipId,
    orderingPhysicianMdmId: facts.orderingPhysicianMdmId,
    verbalAttestation: facts.verbalAttestation,
    receivedAt: facts.receivedAt,
  };
}

/** The signer facts the §2.3 step-5 (and the standard sign path) M11 `signOrderTarget` payload reads. */
export interface MedicationSignFacts {
  readonly organizationId: string;
  readonly medicationOrderId: string;
  readonly signerMembershipId: string;
  /** The signer's clinical discipline (`hospice_physician` / `medical_director` / `np` / `pa` — the §4.6
   * prescriber-only matrix the service already gates via `signerEligibleForMed`). REQUIRED by M11's leaf
   * `SignOrderTargetInput` so `order_signature.signer_discipline` records the real value: every M12 sign
   * route body carries `signerDiscipline` and threads it here — never a sentinel. */
  readonly signerDiscipline: string;
  /** ISO client timestamp; M11 records the authoritative server time. */
  readonly signedAtClient: string;
  /** Populated only on the EPCS controlled-substance path (§2.4 §1311.116). */
  readonly secondFactorType?: EpcsSecondFactorType;
  /** §2.3 — on-behalf signing is never permitted in the verbal follow-up flow (CMS); standard sign may use it. */
  readonly onBehalfOf?: string;
}

/**
 * §2.3 step 5 / §2.8 D14 — build the M11 `signOrderTarget` payload for a medication-order signature. The
 * machine's `sign` / `completeSecondFactor` transitions name `sign_via_m11`; the service calls this to shape
 * the seam input. `secondFactorContext` (the EPCS second-factor type) rides M11's `signatureContext`.
 */
export function buildSignTargetInput(facts: MedicationSignFacts): SignOrderTargetInput {
  const reasonParts: string[] = [];
  if (facts.secondFactorType) reasonParts.push(`epcs_second_factor=${facts.secondFactorType}`);
  const signatureContext: SignOrderTargetInput["signatureContext"] =
    facts.onBehalfOf || reasonParts.length > 0
      ? {
          ...(facts.onBehalfOf ? { onBehalfOf: facts.onBehalfOf } : {}),
          ...(reasonParts.length > 0 ? { reason: reasonParts.join("; ") } : {}),
        }
      : undefined;
  return {
    organizationId: facts.organizationId,
    targetKind: "medication_order",
    targetId: facts.medicationOrderId,
    signerMembershipId: facts.signerMembershipId,
    signerDiscipline: facts.signerDiscipline,
    signedAtClient: facts.signedAtClient,
    signatureKind: "signature",
    ...(signatureContext ? { signatureContext } : {}),
  };
}
