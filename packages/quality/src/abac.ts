// @wardenx/quality — M30 HQRP & Quality: the ABAC predicate-NAME catalog (§4.7, §6.7).
//
// The named ABAC predicates M30 surfaces reference. Routes refer to a predicate by string, never
// inlining its logic; the predicate IMPLEMENTATIONS (pure `(actor, resource, context) => boolean`
// resolvers over injected ports) are BACKEND-phase work — they land where the composition root
// registers them into M3's named-predicate registry (`m3.predicateRegistry.declare(30, ...)`), the
// M33 `abac-predicates.ts` precedent. P2a ships only the NAME catalog (no implementations, no Fastify).
//
// Truth conditions (for the implementer, from §4.7):
//   - inOrg                — `actor.orgId === resource.orgId` (RE-USED from the M3 base set; listed
//                            here because M30 surfaces reference it). M3 owns its registration.
//   - incidentVisibility   — read iff (a) `incident.read` AND kind ≠ allegation_of_abuse, OR
//                            (b) `incident.abuse_review` AND kind = allegation_of_abuse, OR
//                            (c) actor ∈ {reportedBy ∪ assignedTo}.
//   - ownsIncident         — `actor.id ∈ {incident.reportedByUserId, incident.assignedToUserId}`.
//   - assignedToIncident   — `actor.id === incident.assignedToUserId`.
//   - abuseAllegationAccess— role Compliance Officer OR Administrator OR explicit `incident.abuse_review`.
//   - capVerifyAuthority   — role QAPI Coordinator OR Compliance Officer AND `actor.id ≠
//                            incident.assignedToUserId` (separation-of-duties; M30-F03 / ADR-0022).
//   - ownsQapiProject      — `actor.id === qapi_project.led_by_user_id` OR holds `qapi.admin`.
//   - qapiCloseAuthority   — two-actor: caller ∈ {QAPI Coordinator, Medical Director} AND the second
//                            co-signer is the OTHER role (D12 / V-11).
//   - ownsSraCycle         — `actor.id === sra_cycle.owner_user_id` OR holds `sra.admin`.
//   - sraCloseAuthority    — two-actor: Security Officer + Compliance Officer co-sign (D12 / V-12).
//   - assignedToMortality  — `actor.id === mortality_review.assigned_to_user_id`.

/**
 * The §4.7 ABAC predicate NAMES M30 surfaces reference. In a later phase the backend registers M30's
 * OWN predicates into M3 and asserts every name referenced by a route guard is declared. `inOrg` is the
 * RE-USED M3 base predicate (included so M30's surface inventory is self-describing; M3 owns its
 * registration).
 */
export const M30_ABAC_PREDICATES = [
  "inOrg",
  "incidentVisibility",
  "ownsIncident",
  "assignedToIncident",
  "abuseAllegationAccess",
  "capVerifyAuthority",
  "ownsQapiProject",
  "qapiCloseAuthority",
  "ownsSraCycle",
  "sraCloseAuthority",
  "assignedToMortality",
] as const;

/** Union of the M30 ABAC predicate names (§4.7). */
export type M30AbacPredicate = (typeof M30_ABAC_PREDICATES)[number];
