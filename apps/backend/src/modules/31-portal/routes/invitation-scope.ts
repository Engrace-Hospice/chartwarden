// apps/backend/src/modules/31-portal/routes/invitation-scope.ts — M31 GAP-093: the STAFF invitation routes
// are authorized against the PATIENT the invitation concerns, not "any in-org actor".
//
// `ABAC_IN_ORG` let any holder of `portal.invitation.issue` / `invite_bereaved` invite a caregiver to ANY
// in-org patient's chart — i.e. hand a stranger a portal grant request for a patient the clinician has no
// relationship with. The rule is the platform's SHARED `caseload_or_scope` predicate (M7 registers it; the
// M5 caseload, the org-wide scope roles and a session scope all resolve through it), composed here over a
// patient id this module RESOLVES rather than trusts:
//
//   issue            — the patient the invitation names (`body.patientId`): the invitation's subject, which
//                      is the very thing being authorized (an off-caseload id is refused, an absent one has no
//                      caseload row and is refused the same way).
//   invite-bereaved  — the patient(s) behind the ACCOUNT's grants, read server-side from the account id; the
//                      body's `bereavedContactId` is never consulted. EVERY granted patient must be in scope.
//
// Deny is ONE 404 for an off-caseload, absent, grantless or unreadable subject (the M31 staff-visit
// convention): the caller learns nothing about which patients exist. A missing patient id denies HERE —
// `caseload_or_scope` treats an id-less target as the collection case and would allow it. A predicate that
// throws (an unreadable M5 seam) is a deny, never a 500. Break-glass is a READ emergency grant and these
// routes mutate, so it never satisfies the guard (`breakGlassBypassable: false`).
import { requireAbac } from "@chartwarden/auth";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorOf } from "./actor";
import type { PortalOwnedTableOps } from "./store";

const NOT_FOUND_MESSAGE = "invitation subject not found";

/** Resolves the patient ids an invitation request concerns, from the request and server-side facts. */
export type InvitationPatientResolver = (request: FastifyRequest) => Promise<readonly string[]>;

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The patient the issue request names (the invitation's subject). */
export const patientFromBody: InvitationPatientResolver = async (request) => {
  const patientId = (request.body as { patientId?: unknown } | undefined)?.patientId;
  return isNonEmpty(patientId) ? [patientId] : [];
};

/** The patients behind a portal account's grants (active and revoked — a bereaved account's are revoked). */
export const patientsFromAccountGrants =
  (store: Pick<PortalOwnedTableOps, "grantsForAccount">): InvitationPatientResolver =>
  async (request) => {
    const { id } = request.params as { id: string };
    const grants = await store.grantsForAccount(actorOf(request).organizationId, id);
    return [...new Set(grants.map((g) => g.patientId))];
  };

/**
 * The route-layer guard AND the handler backstop (the handler calls it again before it acts). Throws the
 * single 404 unless the actor is in `caseload_or_scope` of EVERY resolved patient.
 */
export const invitationPatientScope =
  (action: string, resolve: InvitationPatientResolver) =>
  async (request: FastifyRequest, _reply?: FastifyReply): Promise<void> => {
    let patientIds: readonly string[];
    try {
      patientIds = await resolve(request);
    } catch {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }
    if (patientIds.length === 0 || !patientIds.every(isNonEmpty)) {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }
    for (const patientId of patientIds) {
      try {
        await requireAbac(action, "caseload_or_scope", {
          getTarget: () => ({ patientId }),
          notFoundOnDeny: true,
          breakGlassBypassable: false,
        })(request);
      } catch (error) {
        // Preserve the guard's own 401/403/404; an unreadable predicate (a seam throw) is a deny.
        if (error instanceof ChartWardenError && error.statusCode < 500) throw error;
        throw new NotFoundError(NOT_FOUND_MESSAGE);
      }
    }
  };
