// apps/backend/src/modules/13-emar/order-consistency.ts — the ORDER-consistency refusals both M13 backends
// share (the Drizzle service and the in-memory slice), so a unit test through the slice sees the same 422 a
// production caller does. The order is the authority: its class decides the witness (GAP-005), its patient
// decides which patient every other id on the write may name (GAP-004), and an order that does not resolve
// is refused rather than assumed.
import { type MedClass, ValidationError } from "@wardenx/types";

/** GAP-005 — the order decides; a body `medClass` may only agree with it. */
export function assertMedClassAgrees(
  bodyMedClass: string | undefined,
  orderMedClass: MedClass,
): void {
  if (bodyMedClass === undefined || bodyMedClass === orderMedClass) return;
  throw new ValidationError("medClass does not match the medication order", [
    {
      field: "medClass",
      code: "MED_CLASS_MISMATCH",
      message: `the order is ${orderMedClass}; the administration cannot be recorded as ${bodyMedClass}`,
    },
  ]);
}

/**
 * GAP-004 — every patient-bearing id on an administration must belong to the ORDER's patient. `emar.scope`
 * proves each one is in the caller's scope, not that they agree: a clinician with two caseload patients
 * could otherwise chart A's order against B's dose, IV session or comfort kit.
 */
export function assertOrderPatient(
  field: string,
  patientId: string | null | undefined,
  orderPatientId: string,
  message: string,
): void {
  if (patientId === orderPatientId) return;
  throw new ValidationError(`${field} does not match the medication order's patient`, [
    { field, code: "PATIENT_ORDER_MISMATCH", message },
  ]);
}

/** The order must resolve for M13 to know whether the D7 witness applies — unknown is refused, not assumed. */
export function unresolvedOrder(): ValidationError {
  return new ValidationError("the medication order for this administration is unresolvable", [
    {
      field: "medicationOrderId",
      code: "MEDICATION_ORDER_UNRESOLVED",
      message:
        "the medication order could not be read, so neither the patient nor whether a witness is required is known",
    },
  ]);
}
