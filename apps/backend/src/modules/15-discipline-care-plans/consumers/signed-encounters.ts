// apps/backend/src/modules/15-discipline-care-plans/consumers/signed-encounters.ts — M15-T03 (§2.2.4, §2.3).
//
// M15 CONSUMES M8's §4.7 `SignedEncountersReader` to make two §2.3 rules real rather than advisory:
//
//   • an `aide_supervisory_visit.source_encounter_id` must reference an M8 encounter AUTHORED BY THE
//     SUPERVISING RN on this patient, in the same organization (§2.3). Without the check, an agency could
//     satisfy 42 CFR §418.76(h) by pointing at any visit — including the aide's own — and the survey
//     record would say a supervision happened that never did;
//   • a `discipline_assessment.source_encounter_id` must reference a SIGNED encounter on this patient
//     (§2.3) — a psychosocial assessment attached to a draft or another patient's visit is a charting
//     error the reader catches before the row exists.
//
// The reader returns SIGNED digests only (its name is its contract), so presence in the window IS the
// signed check. FAIL-CLOSED: an unreachable seam throws and the write never happens; a miss returns
// `false`, which the pure guards turn into `INVALID_ENCOUNTER_REFERENCE` (422).
import type { EncounterId, IsoInstant, MembershipId, PatientId } from "@wardenx/types";
import { getSignedEncountersReader } from "../seams/index";

/**
 * How far back the encounter lookup windows. The reader's only lookup is "signed encounters for this
 * patient since T", so M15 asks for a window wide enough to contain the referenced visit: 90 days covers
 * the longest supervisory cadence (14 days) plus M8's late-entry tiers, without pulling an admission's
 * whole history for a single id check.
 */
export const ENCOUNTER_LOOKBACK_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** The window start for a lookup anchored at `at`. */
function lookbackFrom(at: IsoInstant): IsoInstant {
  return new Date(Date.parse(at) - ENCOUNTER_LOOKBACK_DAYS * MS_PER_DAY).toISOString();
}

/** What the supervisory-visit reference check decides over (§2.2.4). */
export interface SupervisoryEncounterRef {
  readonly orgId: string;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  /** The plan's supervising RN — the encounter must be the one THEY signed (§2.3). */
  readonly supervisingRnMembershipId: MembershipId;
  /** The attested supervisory instant; the lookup window ends here. */
  readonly supervisoryAt: IsoInstant;
}

/**
 * §2.3 — whether `encounterId` is a signed encounter on this patient authored by the supervising RN. The
 * result feeds `SupervisoryVisitFacts.sourceEncounterValid`; the pure guard raises the 422.
 */
export async function isSupervisoryEncounterValid(ref: SupervisoryEncounterRef): Promise<boolean> {
  const digests = await getSignedEncountersReader().signedEncountersForPatientSince(
    ref.orgId,
    ref.patientId,
    lookbackFrom(ref.supervisoryAt),
  );
  const match = digests.find((d) => d.encounterId === ref.encounterId);
  if (match === undefined) return false;
  // The supervision is the RN's own documented visit — the aide's encounter can never evidence it.
  return match.signedByMembershipId === ref.supervisingRnMembershipId && match.discipline === "rn";
}

/** What the assessment reference check decides over (§2.3). */
export interface AssessmentEncounterRef {
  readonly orgId: string;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  /** The assessment's `captured_at`; the lookup window ends here. */
  readonly capturedAt: IsoInstant;
}

/**
 * §2.3 — whether a discipline assessment's `source_encounter_id` is a signed encounter on this patient.
 * Feeds `DisciplineAssessmentEvent.sign.sourceEncounterValid`; pass `null` there when the assessment
 * references no encounter (legal — e.g. a telephonic psychosocial follow-up).
 */
export async function isAssessmentEncounterValid(ref: AssessmentEncounterRef): Promise<boolean> {
  const digests = await getSignedEncountersReader().signedEncountersForPatientSince(
    ref.orgId,
    ref.patientId,
    lookbackFrom(ref.capturedAt),
  );
  return digests.some((d) => d.encounterId === ref.encounterId);
}
