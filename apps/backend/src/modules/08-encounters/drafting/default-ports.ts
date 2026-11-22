// apps/backend/src/modules/08-encounters/drafting/default-ports.ts — the seam-backed half of the draft ports, wired
// from the M1 registry (S1 PR C2a). Each seam is resolved at CALL time, so registration order is irrelevant and an
// unregistered or deny-stubbed seam fails inside the guarded read as `DRAFT_UNAVAILABLE`.
//
// The store-backed half (`DraftStorePorts`: time zone, previous visit, vitals, removed links, stored selections)
// is supplied by PR C2b over the M8 tables: `{ ...defaultDraftPorts(), ...storePorts }`.
import type {
  AdmissionId,
  ElectionPeriodId,
  IsoInstant,
  LocalDate,
  PatientId,
} from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
// M8 `dependsOn` M7: the SAME per-actor Part 2 decision the care-plan reader store applies to its `{ actor }`
// audience (M39 `evaluateForInternalAccess`, then the §7.6 RN-case-manager carve-out where no release names
// others), so the draft never disagrees with the care plan about who may read SUD content.
import {
  defaultInternalSudAccessChecker,
  sudDisclosureAllowedForActor,
} from "../../07-care-plan/index";
import { getCarePlanReader } from "../seams/index";
import { seamWoundReader } from "../wound-reader";
import type { DraftSeamPorts } from "./ports";

/** The `callerModule` token M8 identifies itself with on M39's evaluation audit (M7's own reads carry "m7"). */
const CONSENT_CALLER_MODULE = "m8";

/** M39's consent type for the advance directive acknowledgment (`packages/consent` kinds); only its presence is read, never its content. */
const ADVANCE_DIRECTIVE_CONSENT_TYPE = "advance_directive_acknowledgment";

/**
 * The M8-side structural projection of M39's `ConsentEvaluator.evaluate` (the one arm the draft consumes besides the Part 2 verdict);
 * the registry hands the seam over opaquely, as M22 and M12 read it (no import of M39's package into M8).
 */
interface ConsentEvaluationPort {
  evaluate(args: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly consentType: string;
    readonly asOf: string;
    /** Was the record in force at `asOf` (judged from its own end instant), not is it active now; the visit's instant is in the past. */
    readonly historical: boolean;
    readonly sessionContext: { readonly sessionClass: string };
    readonly callerModule: string;
  }): Promise<{ readonly allowed: boolean; readonly consentRecordId?: string }>;
}

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
    // S4 (social-work and chaplain visits): M15's own plan as of the visit instant. M15 resolves the per-viewer Part 2 verdict itself, from the
    // session identity handed over here (roles and membership), and answers `redacted` when it withheld anything (`readDisciplinePlan`).
    disciplinePlanAsOf: (organizationId, patientId, admissionId, kind, viewer, asOf) =>
      getSeam("DisciplinePlanReader").planElementsAsOf(
        organizationId,
        patientId as PatientId,
        admissionId as AdmissionId,
        kind,
        { roles: viewer.roles, membershipId: viewer.membershipId },
        asOf as IsoInstant,
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
    // S2b (RN admission visit): M12's orders as of the visit instant, M5's roster on the service date, M39's acknowledgment as of the visit
    // instant. Each answers by its own dates, so the as-of cut (VN-D11) is theirs; none returns content the draft must not state.
    activeMedicationsAsOf: (organizationId, patientId, asOf) =>
      getSeam("MedicationOrderProvider").getMedicationsAsOf(organizationId, patientId, asOf),
    caregiversOn: (organizationId, patientId, on) =>
      getSeam("PatientCaregiverRosterReader").caregiversOn(organizationId, patientId, on),
    advanceDirectiveAcknowledgment: async ({ organizationId, patientId, asOf }) => {
      const verdict = await (getSeam("ConsentEvaluator") as ConsentEvaluationPort).evaluate({
        organizationId,
        patientId,
        consentType: ADVANCE_DIRECTIVE_CONSENT_TYPE,
        asOf,
        // A note is signed after the visit: a record revoked, renewed or expired (the patient's death) in between was still on file then.
        historical: true,
        sessionContext: { sessionClass: "staff" },
        callerModule: CONSENT_CALLER_MODULE,
      });
      return verdict.allowed && verdict.consentRecordId !== undefined
        ? { consentRecordId: verdict.consentRecordId }
        : null;
    },
    recordedWounds: (query) => seamWoundReader.woundsForEncounter(query),
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
