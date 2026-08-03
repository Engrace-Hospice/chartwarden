// apps/backend/src/modules/09-assessments/capture-siting.ts — resolve the §3.3 capture SITING
// (`provider_entity_id`/`location_id`) an assessment insert denormalizes at record-time.
//
// SOURCE OF TRUTH. The siting is the capture's ADMISSION anchor — the `admissionId` every
// record/correct already carries — whose PE/location live on the M6-owned `admission` row. M9 may not
// import M6's schema (architecture §11), so the resolution goes through the published M6 seam:
// `getSeam("AdmissionStatusReader").getAdmissionSummary(admissionId)` (the M6 Drizzle store answers
// real rows under the consumer's ambient request context / RLS).
//
// WHAT THE SEAM CAN AND CANNOT ANSWER (verified against @wardenx/types §4.7):
//   · provider_entity_id — carried by AdmissionSummary → resolved here.
//   · location_id — carried by NO published seam today. AdmissionSummary and AdmissionCensusEntry
//     expose only providerEntityId; the M5 patient spine has a `location_id` column but PatientIdentity
//     (the only M5 read seam) carries neither PE nor location. Extending AdmissionSummary is an
//     M6 + @wardenx/types change outside this module. Until a seam carries it, `location_id` stays
//     NULL — the row is deliberately UNSITED for location rather than an invented value.
//
// FALLBACK. When the seam cannot answer — deny-stub (NotImplementedError), unregistered seam
// (SeamError), unknown/cross-tenant admission (AdmissionNotFoundError / RLS-empty), a draft admission
// whose PE is still null (M6's AdmissionSeamDataGapError), or no ambient request scope
// (withOrgContextFromRequest throws) — the resolver returns the UNSITED sentinel instead of
// propagating: recording clinical data must never be blocked by a reporting denormalization, and a
// NULL siting is the honest "could not resolve" (the M9 seam's latest-read then names the gap loudly
// via AssessmentSeamDataGapError — fail-closed downstream, never fabricated here).
//
// TENANT/PATIENT GUARD. The summary's organizationId/patientId must match the caller's — a mismatch
// (caller sent another patient's admission id) resolves UNSITED rather than mis-siting the row.
import type { AdmissionSummary } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";

/** The resolved (nullable) siting pair an insert denormalizes onto `clinical_assessment`. */
export interface ResolvedCaptureSiting {
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

/** The documented "could not resolve — leave the row unsited" outcome (never an invented siting). */
export const UNSITED_CAPTURE: ResolvedCaptureSiting = { providerEntityId: null, locationId: null };

/** Port the route service resolves siting through (seam-backed in prod; injectable for tests). */
export interface AssessmentSitingResolver {
  resolve(
    organizationId: string,
    patientId: string,
    admissionId: string,
  ): Promise<ResolvedCaptureSiting>;
}

/**
 * The production resolver over M6's published `AdmissionStatusReader` seam (lazy `getSeam` per call —
 * boot order safe). See the file header for the exact chain + why `locationId` is always null today.
 */
export function createSeamAssessmentSitingResolver(): AssessmentSitingResolver {
  return {
    async resolve(organizationId, patientId, admissionId) {
      let summary: AdmissionSummary;
      try {
        summary = await getSeam("AdmissionStatusReader").getAdmissionSummary(admissionId);
      } catch {
        return UNSITED_CAPTURE; // seam absent/denying/gapped or admission unknown — stay unsited
      }
      if (summary.organizationId !== organizationId || summary.patientId !== patientId) {
        return UNSITED_CAPTURE; // an admission that is not this org's/patient's never sites the row
      }
      // task-11 — AdmissionSummary now carries the admission's location anchor (optional field;
      // honestly null until activation sites the admission).
      return { providerEntityId: summary.providerEntityId, locationId: summary.locationId ?? null };
    },
  };
}
