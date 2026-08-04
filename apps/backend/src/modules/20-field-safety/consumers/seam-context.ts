// apps/backend/src/modules/20-field-safety/consumers/seam-context.ts — M20-T04 (§4.4, §4.2, §7.1, §7.7).
//
// The IO half of the M17 / M18 / M5 bindings: resolve the facts the pure deciders in this directory and
// the §4.2 supervisor board need, through the M1 seam registry, and hand them over as plain data. Keeping
// the reads here is what lets `planVisitCadence` / `decideEvvCheckIn` / `decideVisitNoShow` be pure
// functions with no DB, no clock and no seam — the M15/M16/M19/M21 shape.
//
// THE FAIL DIRECTION IS SET PER READ, AND TWO OF THE THREE MUST NOT COLLAPSE TO NULL.
//
//   • The visit read-back behind a materializer returns `null` on both "no such visit" and "the seam
//     threw": both mean "no tenancy anchor", the decider cannot materialize without one either way, and
//     distinguishing them to the caller would leak whether another tenant's visit exists.
//
//   • The live-awareness reads do NOT get that treatment. "She is between visits" and "M17 did not
//     answer" render identically on a board that collapses both to null, and one of them is the board
//     lying to a supervisor who asked whether everyone is OK. Both reads are three-valued
//     (`in_visit`/`no_visit`/`unknown`, `location`/`none`/`unknown`) so the §5 screens can render the
//     third state — the M19-T08 three-state banner rule, which exists because an empty safety surface
//     reads as "everyone is fine".
//
// THE MINIMUM-NECESSARY PATIENT PROJECTION IS A DIFFERENT TYPE, NOT A FILTERED OBJECT. M5's
// `PatientReader.findById` returns the whole `PatientIdentity` — MRN, external MRNs, last name, date of
// birth, sometimes SSN last-4. §4.4 gives M20 exactly one field of it: the first name on a board row. The
// projection therefore happens in `readPatientFirstName`, which returns a `string | null`, so the wide
// identity has no path to the dashboard composer and no later refactor can widen the board by reaching
// for a field that is simply not in scope (the M19-T07 vendor-projection rule).
//
// M18's COORDINATES STOP HERE. `EvvLocationDto` carries lat/lng/accuracy; `SafetyLastKnownLocationDto`
// carries a source and an age and NOTHING ELSE. That is not incidental: rendering the board must never
// touch `safety.sos.read_coords` or trip the §8.2 warn-severity coordinate-read audit, and the surest way
// to guarantee that is for the coordinates never to exist on the far side of this function.
import type {
  EvvLocationDto,
  IsoInstant,
  MembershipId,
  OrgId,
  PatientId,
  SafetyLastKnownLocationDto,
  SafetyLocationSource,
  VisitId,
} from "@wardenx/types";
import {
  getEvvLocationProvider,
  getPatientReader,
  getVisitAssignmentReader,
  getVisitReader,
} from "../seams/consumed";
import type { SafetyVisitAnchors } from "./schedule-plan";

/** §4.2 — where a clinician is, or the admission that M20 does not know. */
export type SafetyLiveVisitRead =
  | { readonly kind: "in_visit"; readonly visitId: VisitId; readonly patientId: PatientId }
  | { readonly kind: "no_visit" }
  | { readonly kind: "unknown"; readonly reason: string };

/** §4.2 — when M20 last heard from a clinician, or the admission that it cannot say. */
export type SafetyLastKnownLocationRead =
  | { readonly kind: "location"; readonly location: SafetyLastKnownLocationDto }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly reason: string };

/** M17's `VisitDto` narrowed to the anchors a `safety_check_in_schedule` row needs (`./schedule-plan`). */
export function visitAnchorsFrom(visit: {
  readonly id: VisitId;
  readonly organizationId: OrgId;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly patientId: PatientId;
  readonly assignedMembershipId: MembershipId;
  readonly scheduledStartedAt: IsoInstant;
  readonly scheduledEndedAt: IsoInstant;
}): SafetyVisitAnchors {
  return {
    visitId: visit.id,
    organizationId: visit.organizationId,
    providerEntityId: visit.providerEntityId,
    locationId: visit.locationId,
    clinicianMembershipId: visit.assignedMembershipId,
    patientId: visit.patientId,
    scheduledStartedAt: visit.scheduledStartedAt,
    scheduledEndedAt: visit.scheduledEndedAt,
  };
}

/**
 * Read the visit an M17 trigger names back through `VisitReader`, narrowed to the safety anchors.
 *
 * An `m17.visit.*` payload is a TRIGGER, not a data feed: it carries no `organization_id`, no
 * `provider_entity_id` and no `location_id`, and every `safety_check_in_schedule` row needs all three NOT
 * NULL. So the materializer materializes from this read, never from the event body.
 */
export async function readVisitAnchors(
  orgId: OrgId,
  visitId: VisitId,
): Promise<SafetyVisitAnchors | null> {
  try {
    const visit = await getVisitReader().visitForEncounter(orgId, visitId);
    return visit === null ? null : visitAnchorsFrom(visit);
  } catch {
    return null;
  }
}

/** §4.2 — "where is this clinician right now?", with the outage kept distinct from the answer. */
export async function readCurrentVisitForClinician(
  orgId: OrgId,
  membershipId: MembershipId,
): Promise<SafetyLiveVisitRead> {
  try {
    const visit = await getVisitAssignmentReader().currentVisitForClinician(orgId, membershipId);
    return visit === null
      ? { kind: "no_visit" }
      : { kind: "in_visit", visitId: visit.id, patientId: visit.patientId };
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : "VisitAssignmentReader read failed",
    };
  }
}

/**
 * Project one M18 EVV sample into the board's coordinate-free staleness DTO.
 *
 * SOURCE IS INFERRED, BECAUSE `EvvLocationDto` CANNOT SAY. `SafetyLocationSource` distinguishes
 * `evv_check_in` from `evv_check_out`, and M18's DTO carries an event id, a visit id, coordinates and a
 * capture instant — no event kind. Rather than widen a published M18 contract from inside M20 (or invent
 * a fourth source value that means "M18, unspecified", which would make the board vaguer for every
 * tenant), the kind is inferred from a fact M20 already reads on the same row: if the sample belongs to
 * the visit the clinician is in RIGHT NOW, the last EVV event for it was her arrival; otherwise she has
 * left. The one case that lands wrong is a visit M17 completed without an EVV check-out, where a stale
 * arrival is labelled a departure — a wrong LABEL on a correct timestamp, on a badge that gates nothing.
 *
 * `ageMinutes` floors at zero: a device clock running ahead of the server would otherwise render as a
 * negative age, and "we last heard from her in −3 minutes" is worse than useless on a safety board.
 */
export function lastKnownLocationFrom(
  sample: EvvLocationDto,
  nowIso: IsoInstant,
  currentVisitId: VisitId | null,
): SafetyLastKnownLocationDto {
  const source: SafetyLocationSource =
    currentVisitId !== null && sample.visitId === currentVisitId ? "evv_check_in" : "evv_check_out";
  const ageMinutes = Math.max(
    0,
    Math.round((Date.parse(nowIso) - Date.parse(sample.capturedAt)) / 60_000),
  );
  return { source, sampledAt: sample.capturedAt, ageMinutes };
}

/** §4.4 — M18's last-known-location surface for one clinician, coordinate-free (see the header). */
export async function readLastKnownLocation(input: {
  readonly orgId: OrgId;
  readonly membershipId: MembershipId;
  readonly nowIso: IsoInstant;
  readonly currentVisitId: VisitId | null;
}): Promise<SafetyLastKnownLocationRead> {
  try {
    const sample = await getEvvLocationProvider().lastKnownLocationForClinician(
      input.orgId,
      input.membershipId,
    );
    return sample === null
      ? { kind: "none" }
      : {
          kind: "location",
          location: lastKnownLocationFrom(sample, input.nowIso, input.currentVisitId),
        };
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : "EvvLocationProvider read failed",
    };
  }
}

/**
 * The whole shift's samples in one read, keyed by membership — what the §4.2 board uses instead of N
 * per-clinician calls.
 *
 * The outage is still a distinct value: `null` means M18 did not answer, and every row on the board then
 * renders its location cell as unknown, rather than as "we have never heard from any of them".
 */
export async function readOrgShiftLocations(
  orgId: OrgId,
): Promise<ReadonlyMap<MembershipId, EvvLocationDto> | null> {
  try {
    const samples = await getEvvLocationProvider().lastKnownLocationsForOrgShift(orgId);
    const byMembership = new Map<MembershipId, EvvLocationDto>();
    for (const sample of samples) {
      const existing = byMembership.get(sample.membershipId);
      // M18 documents this as "the most recent event within 12h" per clinician, but a seam that returned
      // two rows for one membership would otherwise silently take whichever came last in the array.
      if (
        existing === undefined ||
        Date.parse(sample.capturedAt) > Date.parse(existing.capturedAt)
      ) {
        byMembership.set(sample.membershipId, sample);
      }
    }
    return byMembership;
  } catch {
    return null;
  }
}

/**
 * §4.4 — the ONLY patient fact M20 reads: the first name on a board row.
 *
 * A failed or empty read returns `null` and the board renders the row without a patient name. It does not
 * throw: a clinician's safety row must not disappear because M5 was slow, and the name is the least
 * load-bearing field on it.
 */
export async function readPatientFirstName(
  orgId: OrgId,
  patientId: PatientId,
): Promise<string | null> {
  try {
    const patient = await getPatientReader().findById({ organizationId: orgId, id: patientId });
    return patient === null ? null : patient.firstName;
  } catch {
    return null;
  }
}
