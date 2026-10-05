// apps/backend/src/modules/31-portal/routes/staff-visit-scope.ts — M31 (adjacent to GAP-094): the STAFF
// telehealth routes are authorized against the visit's STORED patient, never against "any in-org visit id".
//
// Before this, `P(...) + ABAC_IN_ORG` let ANY holder of `telehealth.join_clinician` mint a vendor participant
// token (and lazily mint a room) for any in-org visit — i.e. join any patient's live video visit. The rule
// is the platform's `caseload_or_scope` idiom (the M29 `lab_observation_patient_caseload_or_scope` shape):
//
//   allow  ⇐  the actor holds an org-wide role (`hasOrgWideScope(roles)`, no seam read), OR
//             the actor IS the visit's assigned clinician (`assignedMembershipId === actor.membershipId`), OR
//             the visit's patient is on the actor's M5 caseload (`getSeam("CaseloadProvider").isInCaseload`).
//   deny   ⇐  everything else — absent visit, another org's visit, not-yours, an unreadable store/seam. ALL of
//             these are ONE `NotFoundError`, so a foreign, absent and not-yours visit are indistinguishable.
//
// This is a plain guard (not a registered ABAC predicate) on purpose: `requireAbac` carries the break-glass
// bypass, and these routes mint a vendor token / mutate lifecycle — a break-glass READ grant must not become a
// way into a live video visit. It runs as a route preHandler AND is re-asserted by each handler (backstop).
// Every fact is server-derived (`request.context` via `actorOf`, the visit row via the M31 store).
import { hasOrgWideScope } from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import type { M17VisitRoomReaderPort } from "../telehealth/room-mint";
import { type M31Actor, actorOf } from "./actor";
import type { PortalOwnedTableOps } from "./store";

const NOT_FOUND_MESSAGE = "telehealth visit not found";

/** The two stored facts the staff scope decides over. */
export interface StaffVisitFacts {
  readonly patientId: string;
  readonly assignedMembershipId: string | null;
}

export interface StaffVisitScopeDeps {
  readonly store: Pick<PortalOwnedTableOps, "telehealthById">;
  /** The M17 visit reader — present only when the lazy room mint is bound (join-only fallback). */
  readonly visitReader?: M17VisitRoomReaderPort;
}

/**
 * The visit's stored facts: the `telehealth_visit` row first; for the lazy-mint join only, the M17 visit the
 * id names (so the scope is decided BEFORE any room is minted). `null` ⇒ absent / not this org.
 */
async function loadVisitFacts(
  deps: StaffVisitScopeDeps,
  actor: M31Actor,
  visitId: string,
  allowM17Fallback: boolean,
): Promise<StaffVisitFacts | null> {
  const row = await deps.store.telehealthById(actor.organizationId, visitId);
  if (row) return { patientId: row.patientId, assignedMembershipId: row.assignedMembershipId };
  if (!allowM17Fallback || !deps.visitReader) return null;
  const m17 = await deps.visitReader.visitForOrg(actor.organizationId, visitId);
  if (!m17 || m17.organizationId !== actor.organizationId) return null;
  return { patientId: m17.patientId, assignedMembershipId: m17.assignedMembershipId };
}

async function actorMayAccess(actor: M31Actor, facts: StaffVisitFacts): Promise<boolean> {
  if (hasOrgWideScope(actor.roles)) return true;
  if (actor.membershipId !== null && actor.membershipId === facts.assignedMembershipId) return true;
  const onCaseload = await getSeam("CaseloadProvider").isInCaseload({
    organizationId: actor.organizationId,
    userId: actor.userId,
    patientId: facts.patientId,
  });
  return onCaseload === true;
}

/**
 * Throws the single indistinguishable 404 unless the actor may act on the visit `visitId` (see the file
 * banner). Any store/seam failure denies. Returns the stored facts so a caller can reuse them.
 */
export async function assertStaffMayAccessVisit(
  deps: StaffVisitScopeDeps,
  actor: M31Actor,
  visitId: string,
  opts: { readonly allowM17Fallback?: boolean } = {},
): Promise<StaffVisitFacts> {
  let facts: StaffVisitFacts | null = null;
  let allowed = false;
  try {
    facts = await loadVisitFacts(deps, actor, visitId, opts.allowM17Fallback === true);
    allowed = facts !== null && (await actorMayAccess(actor, facts));
  } catch {
    allowed = false;
  }
  if (!allowed || facts === null) throw new NotFoundError(NOT_FOUND_MESSAGE);
  return facts;
}

/** The route-layer preHandler (the handler re-asserts with {@link assertStaffMayAccessVisit}). */
export const staffVisitScopeGuard =
  (deps: StaffVisitScopeDeps, opts: { readonly allowM17Fallback?: boolean } = {}) =>
  async (request: FastifyRequest): Promise<void> => {
    const { visitId } = request.params as { visitId: string };
    await assertStaffMayAccessVisit(deps, actorOf(request), visitId, opts);
  };
