// apps/backend/src/modules/15-discipline-care-plans/volunteer/effective-status.ts — M15-T04 (§7.4 / §4.4).
//
// The 42 CFR §418.78(b) effective-status computation — the exact value M17's pre-schedule gate consumes
// through the LOCKED `VolunteerComplianceProvider` seam (`packages/types/src/scheduling.ts`, bound live in
// M15-T05) and the ABAC `volunteer_compliance_active` predicate evaluates at `volunteer_assignment` INSERT.
//
// Two properties this file exists to guarantee:
//
//   • **A MISSING gate fails, exactly like an expired one.** The blocking set is enumerated from
//     `BLOCKING_VOLUNTEER_GATE_KINDS` and every kind with no clearing row is reported as failing. Deriving
//     the answer from the rows that happen to exist would let a volunteer with no TB screening on file
//     read as compliant — the precise 418.78 citation the gate exists to prevent.
//   • **Unresolvable input denies.** §8.7 / M15-F11: the fail-CLOSED posture is architectural. The caller
//     that cannot load the gate rows passes `null`, and `effectiveStatusFor` answers `isActive:false`
//     with the sentinel `service_unavailable` failing gate rather than throwing an ambiguity the
//     scheduler might read as a pass.
//
// PURE — gate rows and `now` are injected; the Drizzle read + the seam registration land in M15-T05/T06.
import { BLOCKING_VOLUNTEER_GATE_KINDS } from "@wardenx/discipline-plans";
import type {
  IsoInstant,
  MembershipId,
  VolunteerComplianceStatus,
  VolunteerGateKind,
} from "@wardenx/types";
import { type VolunteerGateFacts, isGateClearing } from "./gates";

/**
 * §8.7 — the sentinel `failingGates` entry for the degraded path. It is deliberately NOT a
 * `VolunteerGateKind`: the caller must be able to tell "this volunteer is missing their TB screening"
 * apart from "we could not find out", and the M36 alert copy differs for each.
 */
export const GATE_STORE_UNAVAILABLE = "service_unavailable" as const;

/**
 * §7.4 / §4.4 — the volunteer's effective compliance status. `gates` is every
 * `volunteer_compliance_gate` row for the membership (current AND historical — the derivation picks the
 * clearing ones), or `null` when the store could not be read.
 *
 * `expiring_soon` counts as clearing: the 30-day lead-in alerts the coordinator, it does not strand a
 * volunteer who is still credentialed today (§2.2.6).
 */
export function effectiveStatusFor(
  membershipId: MembershipId,
  gates: ReadonlyArray<VolunteerGateFacts> | null,
  now: IsoInstant,
): VolunteerComplianceStatus {
  if (gates === null) {
    return { membershipId, isActive: false, failingGates: [GATE_STORE_UNAVAILABLE] };
  }
  const clearing = new Set<VolunteerGateKind>(
    gates.filter((g) => g.volunteerMembershipId === membershipId && isGateClearing(g, now)).map(
      (g) => g.gateKind,
    ),
  );
  const failingGates = BLOCKING_VOLUNTEER_GATE_KINDS.filter((kind) => !clearing.has(kind));
  return { membershipId, isActive: failingGates.length === 0, failingGates };
}

/**
 * §7.5 — whether a gate event changed the volunteer's effective status. The watcher uses it to emit
 * `m15.volunteer.assignment_inactivated` (and, on renewal, to surface "this volunteer is bookable again")
 * only on an actual edge, not on every nightly pass over an already-inactive volunteer.
 */
export function statusEdge(
  before: VolunteerComplianceStatus,
  after: VolunteerComplianceStatus,
): "none" | "deactivated" | "reactivated" {
  if (before.isActive === after.isActive) return "none";
  return after.isActive ? "reactivated" : "deactivated";
}
