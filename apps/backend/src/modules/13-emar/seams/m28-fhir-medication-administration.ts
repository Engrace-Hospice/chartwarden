// apps/backend/src/modules/13-emar/seams/m28-fhir-medication-administration.ts — M13-T10 the M28 FHIR
// `MedicationAdministration` forward seam (DENY-STUB; M13 §1.3 / §2.12 "Consumed by 28 — `MedicationAdministration`
// R4 projection; M28 owns the HTTP surface").
//
// M28 (FHIR Gateway) is a Wave-H module. M13 already OWNS the data projection — the
// `MedicationAdministrationProvider.asFhirMedicationAdministration` mapping (the IV-continuous sequence composes
// into a single resource with an `effectivePeriod`; the reconciliation worksheet maps to a `List` with
// `mode='snapshot'`). When M28 lands it will PUBLISH that projection to its FHIR resource store / `$everything`
// bundle / external survey surface. Until then M13 declares the consumer-facing CONTRACT here and ships a pure
// DENY-STUB so the binding point is documented and type-checked without creating a cross-module coupling:
//   • NO entry in the M1 seam registry (SeamContracts) — wiring lands with M28.
//   • NO `dependsOn` edge in the manifest — M28 is not a dependency; M13 merely exposes the projection M28 will
//     pull when it locks (forward seam, same inert pattern as M12's FhirMedicationRequestPublisher). M13's
//     `dependsOn` ([1,12,36,38]) is unchanged.
// The deny-stub returns `{ available: false }` so any premature caller fails closed rather than publishing a
// partial resource. The §7.2 SUD read gate (42 CFR Part 2) is applied on M13's egress projection BEFORE this
// seam, so a SUD-flagged administration without a valid release is never handed to M28.

/** Result of an M28 publish request: the FHIR resource ref when M28 is bound, or a deny when it is not (Wave H). */
export type FhirMedicationAdministrationPublishResult =
  | { readonly available: true; readonly resourceRef: string }
  | { readonly available: false; readonly reason: "M28_NOT_BOUND" };

/**
 * The forward-seam M28 implements to publish a `MedicationAdministration` FHIR resource. M13 OWNS the projection
 * (the `MedicationAdministrationProvider.asFhirMedicationAdministration` mapping); M28 provides the publisher at
 * its lock. Until then {@link denyStubFhirMedicationAdministrationPublisher} stands in.
 */
export interface FhirMedicationAdministrationPublisher {
  publish(
    organizationId: string,
    administrationRecordId: string,
  ): Promise<FhirMedicationAdministrationPublishResult>;
}

/**
 * The Phase-1 DENY-STUB publisher: M28 is not built (Wave H), so every publish fails closed with
 * `M28_NOT_BOUND`. Pure — no I/O. Swapped for M28's real publisher when M28 registers its seam.
 */
export const denyStubFhirMedicationAdministrationPublisher: FhirMedicationAdministrationPublisher =
  {
    async publish() {
      return { available: false, reason: "M28_NOT_BOUND" };
    },
  };
