// apps/backend/src/modules/08-encounters/drafting/default-ports.ts — the seam-backed half of the draft ports, wired
// from the M1 registry (S1 PR C2a). Each seam is resolved at CALL time, so registration order is irrelevant and an
// unregistered or deny-stubbed seam fails inside the guarded read as `DRAFT_UNAVAILABLE`.
//
// The store-backed half (`DraftStorePorts`: time zone, previous visit, vitals, removed links, stored selections)
// is supplied by PR C2b over the M8 tables: `{ ...defaultDraftPorts(), ...storePorts }`.
import type { AdmissionId, ElectionPeriodId, LocalDate, PatientId } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
// M8 `dependsOn` M7: the SAME per-actor Part 2 decision the care-plan reader store applies to its `{ actor }`
// audience (M39 `evaluateForInternalAccess`, then the §7.6 RN-case-manager carve-out where no release names
// others), so the draft never disagrees with the care plan about who may read SUD content.
import {
  defaultInternalSudAccessChecker,
  sudDisclosureAllowedForActor,
} from "../../07-care-plan/index";
import { getCarePlanReader } from "../seams/index";
import type { DraftSeamPorts } from "./ports";

/** The `callerModule` token M8 identifies itself with on M39's evaluation audit (M7's own reads carry "m7"). */
const CONSENT_CALLER_MODULE = "m8";

export function defaultDraftPorts(): DraftSeamPorts {
  // An M39 outage RETHROWS here (M7's own reads answer "no"): the draft fails closed as DRAFT_UNAVAILABLE instead of
  // quietly drafting a section short of content the viewer may be entitled to.
  const part2Checker = defaultInternalSudAccessChecker({
    callerModule: CONSENT_CALLER_MODULE,
    onError: "throw",
  });
  return {
    carePlanAsOf: (patientId, encounterType, discipline, admissionId, viewer, asOf) =>
      getCarePlanReader().relevantElementsAsOf(
        patientId as PatientId,
        encounterType,
        discipline,
        admissionId,
        viewer,
        asOf,
      ),
    scaleSeries: (patientId, scaleType, from, to) =>
      getSeam("ScaleSeriesProvider").series(patientId as PatientId, scaleType, from, to),
    medicationChangesBetween: (organizationId, patientId, from, to) =>
      getSeam("MedicationOrderProvider").getMedicationChangesBetween(
        organizationId,
        patientId,
        from,
        to,
      ),
    // S2 (recertification and face-to-face visits): M6's own readers. Each answers by date or by period, so the as-of cut (VN-D11) is
    // made in `inputs.ts`; none returns a narrative (VN-D32).
    electionPeriods: (admissionId) =>
      getSeam("ElectionPeriodReader").listPeriodsForAdmission(admissionId as AdmissionId),
    levelOfCareOn: (admissionId, on) =>
      getSeam("LevelOfCareReader").getLevelOfCareDays(admissionId as AdmissionId, {
        from: on as LocalDate,
        to: on as LocalDate,
      }),
    attestedFaceToFace: (periodId) =>
      getSeam("FaceToFaceReader").getAttestedF2fForPeriod(periodId as ElectionPeriodId),
    activeCertification: (periodId) =>
      getSeam("CertificationReader").getActiveCertification(periodId as ElectionPeriodId),
    part2DisclosureAllowed: ({ organizationId, patientId, viewer }) =>
      sudDisclosureAllowedForActor(
        {
          organizationId,
          patientId,
          roles: viewer.roles,
          membershipId: viewer.membershipId,
        },
        part2Checker,
      ),
  };
}
