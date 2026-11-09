// apps/backend/src/modules/31-portal/routes/actor.ts — M31-T07 route actor binding.
//
// The org/actor binding for every M31 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M19/M20 routes/actor.ts precedent). No
// handler reads an org id, an acting membership, a session class, or the portal account/patient anchor off
// the wire.
//
// TWO ANCHORS THE PORTAL SURFACE CARES ABOUT MORE THAN MOST:
//
//   portalAccountId — the account the portal session is bound to (`context.attributes.portalAccountId`).
//                     §8.3.1's threat (a) is a caregiver naming another account; sourcing it from the
//                     session makes the mismatch unrepresentable.
//   portalPatientId — the ONE patient the session is scoped to after select-patient
//                     (`context.attributes.sessionPatientId`). §8.3.1's threat (b) is a valid session
//                     naming another patient's id in the query string; the read services take the patient
//                     from HERE, never from `?patientId=`.
//                     The ATTRIBUTE is class-neutral because collaborator/funeral sessions are pinned to
//                     a patient too and M7 reads the same fact (F-030); this module's own field keeps the
//                     portal name, because every session that reaches an M31 route is a portal session.
//
// Both are set by M2 when it mints a portal session (the same posture as `membershipId` / `sessionClass`);
// until a real portal session carries them, the portal predicates fail CLOSED (403) — never fall back to a
// caller-supplied value.
import {
  type ContextCarrier,
  type RouteActor,
  actorOf as routeActorOf,
} from "@chartwarden/shared/route-kit";
import { ForbiddenError } from "@chartwarden/types";

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * The org-scoped actor every M31 route resolves from `request.context` (server-assembled): the kit actor
 * (whose `membershipId` is null on a portal session, which carries none) plus the portal anchors.
 */
export interface M31Actor extends RouteActor {
  /** The portal account the session is bound to (portal sessions only; null otherwise). */
  readonly portalAccountId: string | null;
  /** The M2 session id (`attributes.sessionId`, stamped by the authenticate hook); the portal mint's audit anchor. */
  readonly sessionId: string | null;
  /** The one patient the portal session is scoped to (null before select-patient / on staff). */
  readonly portalPatientId: string | null;
}

/** Extract the org-scoped actor from `request.context`, or 401 when unauthenticated / unbound. */
export function actorOf(request: ContextCarrier): M31Actor {
  const actor = routeActorOf(request);
  const attrs = request.context?.attributes ?? {};
  return {
    ...actor,
    portalAccountId: str(attrs.portalAccountId),
    sessionId: str(attrs.sessionId),
    portalPatientId: str(attrs.sessionPatientId),
  };
}

/** The portal session's account anchor. Absent ⇒ 403 (never "fall back to a request parameter", §8.3.1). */
export function portalAccountIdOf(actor: M31Actor): string {
  if (actor.portalAccountId === null) {
    throw new ForbiddenError(
      "this session carries no portal account anchor; portal routes are scoped by the session, not by a request parameter (§8.3.1)",
    );
  }
  return actor.portalAccountId;
}

/** The portal session's patient anchor. Absent ⇒ 403 (the select-patient step binds it, §8.3.1 / D2). */
export function portalPatientIdOf(actor: M31Actor): string {
  if (actor.portalPatientId === null) {
    throw new ForbiddenError(
      "this portal session carries no patient anchor; select a patient first (D2), and the read is scoped by the session, not by a query parameter (§8.3.1)",
    );
  }
  return actor.portalPatientId;
}

/** The M2 session id the portal access ran under (F-225). Absent ⇒ 403: a disclosure with no session anchor is refused. */
export function portalSessionIdOf(actor: M31Actor): string {
  if (actor.sessionId === null) {
    throw new ForbiddenError(
      "this portal session carries no session id; document access is refused",
    );
  }
  return actor.sessionId;
}
