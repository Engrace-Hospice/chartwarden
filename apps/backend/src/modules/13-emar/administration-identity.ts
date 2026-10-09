// apps/backend/src/modules/13-emar/administration-identity.ts — pure adapter: M12's administration context
// (`MedicationOrderProvider.getAdministrationContext`) -> the identity facts M13 files an administration under
// (`EmarMedicationOrderPort.administrationIdentity`). Kept out of `index.ts` so it is unit-testable.
import type { MedicationOrderDto } from "@wardenx/types";

type AdministrationContext = {
  readonly order: MedicationOrderDto;
  readonly allowAdministration: boolean;
  readonly blockedReasons: readonly string[];
};

export function toAdministrationIdentity(ctx: AdministrationContext) {
  const sig = ctx.order.sigStructured;
  const policy = sig.ivContinuousPolicy;
  const dose =
    typeof sig.doseQuantity === "number" &&
    sig.doseQuantity > 0 &&
    typeof sig.doseUnit === "string" &&
    sig.doseUnit.trim().length > 0
      ? { amount: sig.doseQuantity, unit: sig.doseUnit }
      : null;
  return {
    patientId: ctx.order.patientId,
    admissionId: ctx.order.admissionId,
    drugName: ctx.order.drugName,
    route: ctx.order.route,
    // GAP-020 -- the order facts the §5.11 five-rights check and the §2.9 BCMA scan are verified against.
    // A non-positive / unit-less sig dose (the projection's neutral empty) is "unknown", never "zero".
    doseAmount: dose ? dose.amount : null,
    doseUnit: dose ? dose.unit : null,
    rxnormRxcui: ctx.order.rxnormRxcui ?? null,
    ndc: ctx.order.ndc ?? null,
    // GAP-021 -- the order's PRN minimum interval (absent = no minimum stated).
    prnMinimumIntervalMinutes: sig.prnMinimumIntervalMinutes ?? null,
    // No wristband payload digest is on file for any patient (no column, no M5 seam), so the wrong_patient
    // BCMA arm has no on-file value to compare against. Null is honest: it is "not on file", not "matches".
    patientWristbandPayloadDigest: null,
    ivContinuousPolicy: policy ? { minRate: policy.minRate, maxRate: policy.maxRate } : null,
    allowAdministration: ctx.allowAdministration,
    blockedReasons: ctx.blockedReasons,
    // GAP-005 — M12's order is the authority on "is this a controlled substance?".
    medClass: ctx.order.medClass,
    isControlledSubstance: ctx.order.isControlledSubstance,
    // GAP-036 follow-up — the 42 CFR Part 2 flag, snapshotted onto every administration row so the portal
    // redaction and the M28 FHIR gate see it. FAIL CLOSED: an order that does not state the flag (anything but
    // an explicit `false`) is treated as SUD-treatment — over-redacting a MAR line is recoverable, leaking a
    // Part 2 administration is not.
    isSudTreatment: ctx.order.isSudTreatment !== false,
  };
}
