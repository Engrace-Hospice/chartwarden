// apps/backend/src/modules/20-field-safety/routes/actor.ts — M20-T06 route actor binding.
//
// The org/actor binding for every M20 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M15/M16/M19/M21/M24/M26
// routes/actor.ts precedent). No handler reads an org id or an acting membership id off the wire.
//
// THE ACTING MEMBERSHIP IS THE WHOLE ATTRIBUTION STORY IN THIS MODULE. Every column M20 stamps is a
// MEMBERSHIP — `safety_check_in.posted_by_membership_id`, `safety_sos_alert.posted_by_membership_id` /
// `acknowledged_by_membership_id` / `resolved_by_membership_id`, `safety_incident
// .reported_by_membership_id`, `safety_acknowledgment.acknowledged_by_membership_id`,
// `safety_incident.osha_reportable_signed_off_by_membership_id`. §8.3's repudiation controls ARE those
// columns: an SOS whose raiser a caller could name is an SOS a hostile actor could raise as somebody
// else, and an OSHA sign-off whose signer a body could set is a state filing signed by a name that never
// agreed to it.
//
// THERE IS EXACTLY ONE MEMBERSHIP ID A CALLER MAY SUPPLY, and it is
// `affectedClinicianMembershipId` on the incident CREATE — §2.2.3's supervisor-opens-on-behalf-of path,
// which is why that column exists separately from `reported_by_membership_id` at all. It is gated by
// `incident_subject_or_supervisor`, so naming somebody else requires the supervisor arm.
//
// NO VENDOR / PORTAL SESSION CLASS APPEARS HERE. M20 has no external-actor surface (§4.1's Auth column is
// `staff` on all twenty-nine rows) and §5.3 leaves the portal variants to M31. A session class field would
// be a branch nothing takes, and the M19 shape — where the class picks the ABAC predicate — would invite
// one to be added without the predicate that makes it safe.
import {
  actorOf as routeActorOf,
  writeActorOf as routeWriteActorOf,
} from "@chartwarden/shared/route-kit";
import { ForbiddenError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";

/** The READ-route actor: org + user + roles + the scope facts the §4.7 predicates compare against. */
export interface M20ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The actor's ACTIVE M2 membership (null on a session that carries none — e.g. a system principal). */
  readonly membershipId: string | null;
  readonly roles: readonly string[];
  readonly providerEntityIds: readonly string[];
  readonly locationIds: readonly string[];
}

/** M20's view of the route-kit actor: plus the PE scope the write anchor needs, or 401. */
export function actorOf(request: FastifyRequest): M20ReadActor {
  const { organizationId, userId, membershipId, roles, locationIds } = routeActorOf(request);
  return {
    organizationId,
    userId,
    membershipId,
    roles,
    providerEntityIds: request.context?.providerEntityIds ?? [],
    locationIds,
  };
}

/** The write actor: the read actor plus a guaranteed membership and the step-up flag. */
export interface M20WriteActor extends M20ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (M2 SESSION_POLICY). */
  readonly stepUpRecent: boolean;
}

/**
 * Extract the WRITE actor: 401 without a session, 403 without a membership.
 *
 * EVERY M20 route mutation goes through this. There is no anonymous or system-principal write path on the
 * HTTP surface: the §4.8 crons and the consumers reach M20 through their own workers, and those attribute
 * their state-history rows to the SYSTEM (`transitioned_by_membership_id IS NULL`, §3.3) rather than to a
 * human. A route with no membership behind it could satisfy neither arm honestly — it would write a
 * clinician attestation nobody made, or a supervisor acknowledgment nobody gave.
 */
export function writeActorOf(request: FastifyRequest): M20WriteActor {
  const { membershipId, stepUpRecent } = routeWriteActorOf(request);
  return { ...actorOf(request), membershipId, stepUpRecent };
}

/**
 * The single ProviderEntity a write is anchored to.
 *
 * Every M20 PHI table carries `provider_entity_id NOT NULL` (§3.3 / the three-column rule), and M20 has
 * no route that takes one in a body. The anchor is therefore the actor's own PE scope, and a session that
 * carries exactly one is the ordinary case (M2 assembles `providerEntityIds` from the membership's
 * `default_provider_entity_id` plus any grants).
 *
 * A session with NO PE is refused rather than defaulted: `provider_entity_id` is the column M36 routes the
 * SOS fan-out on (§4.5) and the column the §4.3 metrics roll up by, so a row anchored to a guessed PE
 * would page the wrong supervisors and land in the wrong CCN's numbers. A session with SEVERAL is
 * refused too, for the sharper version of the same reason — picking the first would be a coin flip
 * recorded as a fact.
 */
export function providerEntityOf(actor: M20ReadActor, preferred?: string | null): string {
  if (preferred != null && preferred.length > 0) {
    if (!actor.providerEntityIds.includes(preferred)) {
      throw new ForbiddenError(
        "this session is not scoped to the named provider entity; safety rows are anchored to the actor's own scope",
      );
    }
    return preferred;
  }
  if (actor.providerEntityIds.length === 1) return actor.providerEntityIds[0] as string;
  throw new ForbiddenError(
    actor.providerEntityIds.length === 0
      ? "this session carries no provider-entity scope; an M20 safety row cannot be anchored (§3.3)"
      : "this session spans several provider entities; name the one this safety row belongs to",
  );
}
