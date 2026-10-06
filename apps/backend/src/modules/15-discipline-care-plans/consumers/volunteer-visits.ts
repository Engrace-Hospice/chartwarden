// apps/backend/src/modules/15-discipline-care-plans/consumers/volunteer-visits.ts — M15-T04 (§7.4 / §7.6).
//
// M15 CONSUMES M8's §4.7 `SignedEncountersReader` to feed the §418.78(e) ledger numerator: the signed
// `volunteer_visit` encounters on the patients a volunteer plan serves become `volunteer_hour_entry` rows
// on the nightly aggregator run (§7.4). Reading M8's `encounter` table directly would be the architecture
// §25.15 violation the seam exists to prevent.
//
// **Duration.** `SignedEncounterDigest.durationMinutes` is the M8 visit bracket in whole minutes, or `null`
// when the bracket is incomplete (GAP-044 added it to the contract). A null is passed through UNRESOLVED:
// `aggregateVolunteerHours` reports those candidates as `unresolvedDurationEncounterIds` instead of counting
// them as zero minutes, so the ledger is only ever as complete as the brackets M8 holds, and what was
// skipped is visible on every run.
import type { EncounterId, IsoInstant, MembershipId, PatientId } from "@wardenx/types";
import { getSignedEncountersReader } from "../seams/index";
import type { VolunteerVisitCandidate } from "../volunteer/hours";

/** M8's `serviceDate` is an org-local `YYYY-MM-DD`; the ledger's `occurred_at` is an instant. */
function serviceInstant(serviceDate: string): IsoInstant {
  return `${serviceDate}T00:00:00.000Z`;
}

/** One patient a volunteer plan covers, with the volunteer serving it (§2.2.5 assignment projection). */
export interface VolunteerServedPatient {
  readonly patientId: PatientId;
  readonly volunteerMembershipId: MembershipId;
}

/**
 * §7.6 — resolve the signed `volunteer_visit` encounters for the patients a set of assignments covers,
 * since `since`. Only encounters SIGNED BY the assigned volunteer count: another discipline's visit to
 * the same patient is not volunteer time, and counting it would inflate the CoP numerator.
 *
 * Each candidate carries the digest's `durationMinutes` (null = unresolved, reported by the aggregator).
 */
export async function resolveVolunteerVisitCandidates(args: {
  readonly orgId: string;
  readonly servedPatients: ReadonlyArray<VolunteerServedPatient>;
  readonly since: IsoInstant;
}): Promise<ReadonlyArray<VolunteerVisitCandidate>> {
  const reader = getSignedEncountersReader();
  const candidates: VolunteerVisitCandidate[] = [];
  const seen = new Set<EncounterId>();

  for (const served of args.servedPatients) {
    const digests = await reader.signedEncountersForPatientSince(
      args.orgId,
      served.patientId,
      args.since,
    );
    for (const d of digests) {
      if (d.encounterType !== "volunteer_visit" || d.discipline !== "volunteer") continue;
      if (d.signedByMembershipId !== served.volunteerMembershipId) continue;
      // A volunteer serving two patients on the same visit is not a thing, but two assignments can name
      // the same patient across plans — de-duplicate on the encounter so the minutes count once.
      if (seen.has(d.encounterId)) continue;
      seen.add(d.encounterId);
      candidates.push({
        encounterId: d.encounterId,
        volunteerMembershipId: served.volunteerMembershipId,
        // The SERVICE date, not `signedAt`: a 31-December visit signed on 2 January is volunteer time in
        // the fiscal year it was served, and bucketing on the signature would move it (§2.2.7).
        occurredAt: serviceInstant(d.serviceDate),
        durationMinutes: d.durationMinutes,
      });
    }
  }
  return candidates;
}
