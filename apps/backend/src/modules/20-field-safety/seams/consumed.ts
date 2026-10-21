// apps/backend/src/modules/20-field-safety/seams/consumed.ts — the seams M20 CONSUMES (M20-T04, §4.4).
//
// Architecture §25.15: M20 never imports M5's, M17's, M18's or M19's Drizzle schema. Every cross-module
// fact the cadence materializer, the EVV bracket consumers, the supervisor live-awareness board and the
// D14 after-hours union need is resolved through the M1 boot-registered seam registry and handed to the
// pure deciders in `../consumers` as plain data.
//
// Resolving through `getSeam` is why M20's manifest `dependsOn` carries M1 (the registry lives in
// `apps/backend/src/bootstrap`, which is M1 code); M17 is already an M20 dependency per the manifest, and
// M5 / M18 / M19 need NO edge — the CONTRACT types are leaf `@chartwarden/types` (ADR-0005 D1/D2) and the
// binding is runtime. This is the same shape M15-T03 / M16-T03 / M19-T04 / M21-T04 each use.
//
// THREE OF §4.4's METHOD NAMES DO NOT EXIST ON THE PUBLISHED CONTRACTS. @chartwarden/types already recorded
// them at M20-T01; this file is where each is RESOLVED, because a re-declared seam is a permanently
// unbound one (the M15/M17 `VolunteerComplianceProvider` precedent):
//
//   • §4.4 `OnCallProvider.currentOnCallForProviderEntity(providerEntityId, asOf)` — M19 published
//     `currentOnCallActors(orgId, providerEntityId, asOfIso)` returning a union DISCRIMINATED on
//     membership-vs-external_vendor. M20 binds to M19's name and handles the vendor arm explicitly in
//     `../consumers/m19-after-hours`, where it is visible rather than silently dropped.
//
//   • §4.4 `VisitAssignmentReader.upcomingVisitsForClinician` — M17 published
//     `activeVisitsForMembershipOnDate(orgId, membershipId, date)` and nothing named `upcoming*`. That
//     read is only ever used for "which visits does this clinician still owe check-ins for today", which
//     the day-scoped read answers, so M20 binds to it and filters by instant on its own side.
//
//   • §4.4 `PatientAddressReader.geocodedAddressFor` — NO SUCH SEAM EXISTS anywhere on the platform. M5
//     publishes `PatientReader` / `PatientCoverageReader`, neither of which returns a geocoded address,
//     and M17's `VisitDto` carries `patientAddressId` (an opaque id) with no coordinates. The D12
//     pre-visit high-risk-area evaluation therefore has NO address source, and M20-T04 does NOT invent
//     one: there is no accessor for it below, `../consumers` has no polygon evaluator, and the
//     `m20.high-risk-area-evaluator.bullmq` queue stays unbuilt until an owner publishes coordinates.
//     Fail-closed means the pre-visit advisory is ABSENT, never guessed — a polygon evaluated against a
//     coordinate M20 made up would tell a clinician a house is safe.
import type {
  EvvLocationProvider,
  OnCallProvider,
  PatientReader,
  PortalVisitReader,
  VisitAssignmentReader,
  VisitReader,
} from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";

/**
 * M20 CONSUMES M17's §4.3 `VisitReader` — the read-back behind every visit-anchored safety row.
 *
 * An `m17.visit.published` / `.assigned` / `.completed` / `.no_show_detected` event is a TRIGGER, not a
 * data feed (the M16-T03 / M19-T04 finding): none of those payloads carries the `organization_id`,
 * `provider_entity_id` and `location_id` that every `safety_check_in_schedule` row needs NOT NULL, nor the
 * scheduled start/end the D2 cadence is computed from. So the consumers read the visit back and materialize
 * from the READ, never from the payload.
 */
export function getVisitReader(): VisitReader {
  return getSeam("VisitReader");
}

/**
 * M20 CONSUMES M17's §4.3 `PortalVisitReader.upcomingForPatient` for ONE purpose: resolving a decedent's upcoming
 * visit ids (GAP-135). `safety_check_in_schedule` carries no patient column and `m5.patient.deceased` names no visits,
 * so this is the only published patient -> visits read. Only `visitId` is used; the lay-language fields are ignored.
 */
export function getUpcomingVisitReader(): PortalVisitReader {
  return getSeam("PortalVisitReader");
}

/**
 * M20 CONSUMES M17's §4.3 `VisitAssignmentReader` — `currentVisitForClinician`, the "where is this
 * clinician right now" read the §4.2 supervisor board is built on, and `activeVisitsForMembershipOnDate`
 * for the day's outstanding obligations (see the header on the `upcoming*` name).
 *
 * The read is DEGRADABLE and its failure is NOT the same value as its empty answer: "she is between
 * visits" and "M17 did not answer" render identically on a board that collapses both to null, and one of
 * them means the board is lying. `../consumers/seam-context` returns the three-valued read that keeps
 * them apart.
 */
export function getVisitAssignmentReader(): VisitAssignmentReader {
  return getSeam("VisitAssignmentReader");
}

/**
 * M20 CONSUMES M18's §4.3 `EvvLocationProvider` — binding it is what closes M18's Wave-F
 * last-known-location deny-stub (Wave P2-2 acceptance #2).
 *
 * M20 reads it ONLY to answer "when did we last hear from her, and how" — the DTO M20 builds from it
 * (`SafetyLastKnownLocationDto`) carries a timestamp and a source and NO coordinates, so rendering the
 * board never touches `safety.sos.read_coords` and never trips the §8.2 warn-severity coordinate-read
 * audit. M18's lat/lng stop at this boundary.
 */
export function getEvvLocationProvider(): EvvLocationProvider {
  return getSeam("EvvLocationProvider");
}

/**
 * M20 CONSUMES M19's §4.3 `OnCallProvider` — the D14 after-hours parallel recipient set (§7.5). Binding
 * it is what REPLACES the Phase-1 SOS degraded fallback (Wave P2-2 acceptance #3).
 *
 * FAIL POSTURE (M19 states it on the seam and M20 must not soften it): a failure here means "we cannot
 * tell you who is on call", which is NOT "nobody is on call". Catching the throw into `[]` would make a
 * registry outage indistinguishable from a real coverage gap and would silently drop the on-call rotation
 * out of a 3 a.m. SOS. `../consumers/m19-after-hours` returns `unavailable` as a VALUE the alert layer
 * branches on, and the tenant emergency number (M20-F01) is what that branch falls back to.
 */
export function getOnCallProvider(): OnCallProvider {
  return getSeam("OnCallProvider");
}

/**
 * M20 CONSUMES M5's §4.8 `PatientReader` — the patient FIRST NAME on the supervisor board, and nothing
 * else (§4.4 "minimum-necessary").
 *
 * `findById` returns the whole `PatientIdentity`: MRN, external MRNs, last name, date of birth, and
 * optionally SSN last-4. A supervisor asking "is everyone OK?" needs none of that. The minimum-necessary
 * projection is therefore applied at the READ boundary in `../consumers/seam-context` and is a different
 * TYPE, not a filtered object (the M19-T07 vendor-projection rule) — the full identity never reaches the
 * dashboard composer, so no later refactor can widen the board by accident.
 */
export function getPatientReader(): PatientReader {
  return getSeam("PatientReader");
}
