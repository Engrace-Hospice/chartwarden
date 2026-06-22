// apps/backend/src/modules/13-emar/seams/m31-caregiver-attested-portal.ts — M13-T09 the M31
// caregiver-attested-portal forward seam (DENY-STUB; §2.9 D10 / §1.3 "Consumed by 31 — caregiver-attested
// administration capture via M31's portal session calling M13's recordCaregiverAttestedAdministration route").
//
// M31 (Patient/Family Portal) is a later-wave module. M13 already OWNS both halves of the caregiver-attested
// contract today: the `POST /administrations/caregiver-attested` route (the write surface M31 posts to) ships in
// M13-T08/T09, and the `MedicationAdministrationProvider.getPortalAdministrationSummary` read seam (the
// lay-language, SUD-redacted summary M31 renders) ships in M13-T07. What is NOT built is M31's authenticated
// caregiver portal SESSION — the thing that proves a logged-in family caregiver is bound to a specific patient.
// Until M31 locks, M13 declares that consumer-facing CONTRACT here and ships a pure DENY-STUB so the binding
// point is documented and type-checked without creating a cross-module coupling:
//   • NO entry in the M1 seam registry (SeamContracts) — wiring lands with M31.
//   • NO `dependsOn` edge in the manifest — M31 is not a dependency; M13 merely exposes the surfaces M31 will
//     call/pull when it locks (forward seam, same inert pattern as M12's M28 FHIR-publisher deny-stub). M13's
//     `dependsOn` is unchanged.
// The Phase-1 caregiver route trusts its `{patientId}` body (M31 is the only authorized caller, gated by the
// `administration.caregiver_record` permission on the portal-session principal); this resolver is the forward
// seam that, at M31 lock, lets M13 VERIFY that the posting session is bound to the claimed patient. The deny-stub
// returns `{ bound: false }` so any premature caller fails closed rather than trusting an unverified session.

/** The result of resolving an M31 caregiver portal session: the bound patient when M31 is live, or a deny. */
export type CaregiverPortalSessionResolution =
  | { readonly bound: true; readonly patientId: string; readonly caregiverDisplayName: string }
  | { readonly bound: false; readonly reason: "M31_NOT_BOUND" };

/**
 * The forward-seam M31 implements to resolve an authenticated caregiver portal session to its bound patient.
 * M13 OWNS the caregiver-attested write route + the portal-summary read seam; M31 provides the session
 * resolver at its lock. Until then {@link denyStubCaregiverPortalSessionResolver} stands in.
 */
export interface CaregiverPortalSessionResolver {
  resolve(
    organizationId: string,
    caregiverSessionId: string,
  ): Promise<CaregiverPortalSessionResolution>;
}

/**
 * The Phase-1 DENY-STUB resolver: M31 is not built, so every resolve fails closed with `M31_NOT_BOUND`. Pure —
 * no I/O. Swapped for M31's real session resolver when M31 registers its seam; the caregiver route keeps
 * trusting its `{patientId}` body (the permission-gated portal principal) until then.
 */
export const denyStubCaregiverPortalSessionResolver: CaregiverPortalSessionResolver = {
  async resolve() {
    return { bound: false, reason: "M31_NOT_BOUND" };
  },
};
