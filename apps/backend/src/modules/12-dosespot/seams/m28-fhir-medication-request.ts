// apps/backend/src/modules/12-dosespot/seams/m28-fhir-medication-request.ts — M12-T09 the M28 FHIR
// `MedicationRequest` forward seam (DENY-STUB; M12 §1.3 / §2.10 "Consumed by 28 — FHIR `MedicationRequest`
// projection").
//
// M28 (FHIR / External Interfaces) is a Wave-H module. M12 already OWNS the data projection — the
// `MedicationOrderProvider.asFhirMedicationRequest` seam method (M12-T07) returns the opaque
// `FhirMedicationRequestPayload`. When M28 lands it will PUBLISH that projection to its FHIR resource store /
// `$everything` bundle / external survey surface. Until then M12 declares the consumer-facing CONTRACT here and
// ships a pure DENY-STUB so the binding point is documented and type-checked without creating a cross-module
// coupling:
//   • NO entry in the M1 seam registry (SeamContracts) — wiring lands with M28.
//   • NO `dependsOn` edge in the manifest — M28 is not a dependency; M12 merely exposes the projection M28
//     will pull when it locks (forward seam, same inert pattern as M11's OrderPdfRenderer). M12's `dependsOn`
//     ([1,5,11,38,40]) is unchanged.
// The deny-stub returns `{ available: false }` so any premature caller fails closed rather than publishing a
// partial resource. The FHIR projection itself is the M12-owned `FhirMedicationRequestPayload`
// (packages/types/src/dosespot.ts) — M28 maps it to its FHIR server representation, M12 never imports M28.

/** Result of an M28 publish request: the FHIR resource ref when M28 is bound, or a deny when it is not (Wave H). */
export type FhirMedicationRequestPublishResult =
  | { readonly available: true; readonly resourceRef: string }
  | { readonly available: false; readonly reason: "M28_NOT_BOUND" };

/**
 * The forward-seam M28 implements to publish a `MedicationRequest` FHIR resource. M12 OWNS the projection
 * (the {@link import("@wardenx/types").FhirMedicationRequestPayload} returned by its MedicationOrderProvider);
 * M28 provides the publisher at its lock. Until then {@link denyStubFhirMedicationRequestPublisher} stands in.
 */
export interface FhirMedicationRequestPublisher {
  publish(
    organizationId: string,
    medicationOrderId: string,
  ): Promise<FhirMedicationRequestPublishResult>;
}

/**
 * The Phase-1 DENY-STUB publisher: M28 is not built (Wave H), so every publish fails closed with `M28_NOT_BOUND`.
 * Pure — no I/O. Swapped for M28's real publisher when M28 registers its seam.
 */
export const denyStubFhirMedicationRequestPublisher: FhirMedicationRequestPublisher = {
  async publish() {
    return { available: false, reason: "M28_NOT_BOUND" };
  },
};
