// apps/backend/src/modules/15-discipline-care-plans/routes/actor.ts — the M15 extras on the route-kit actor.
//
// Request actors come from `@chartwarden/shared/route-kit` (`actorOf` / `writeActorOf`, server-assembled
// `request.context`, never the body). Every authored row is stamped with the server-assembled membership id —
// the §8.6 (S) spoofing control. This file only adds what M15 needs on top: the SYSTEM-actor marker the write
// service's caseload gate reads, and the system-principal lock on the `/internal/...` seam routes.
import type { PreHandler, RouteActor, WriteActor } from "@chartwarden/shared/route-kit";
import { ForbiddenError } from "@chartwarden/types";

/**
 * The SYSTEM-ACTOR marker — the one place it is defined. `"system"` exempts a caller from the write service's
 * caseload gate (a worker / outbox consumer / seam acting for the platform has no caseload). It is NEVER derived
 * from a request: the kit actors leave it unset, so only server-side code that calls {@link systemM15Actor} can
 * mint one. Absent ⇒ a human actor, gated.
 */
interface SystemMarker {
  readonly kind?: "system";
}

/** The READ-route actor (the kit {@link RouteActor}, plus the system marker). */
export type M15ReadActor = RouteActor & SystemMarker;

/** The MUTATING-route actor (the kit {@link WriteActor}, plus the system marker). */
export type M15WriteActor = WriteActor & SystemMarker;

/**
 * The §4.1 `/internal/...` seam routes (25–28) are SYSTEM-principal only. The permission keys are never
 * granted to a role template, and this guard is the second lock: a human session (any session whose actor
 * kind is not a system principal) is refused before the handler runs, so a leaked grant cannot turn the
 * seam surface into an un-caseloaded PHI read path.
 */
export function requireSystemPrincipal(): PreHandler {
  return async (request) => {
    const kind = request.context?.attributes?.actorKind;
    if (typeof kind !== "string" || !kind.startsWith("system")) {
      throw new ForbiddenError("this seam route is reachable by system principals only (§4.1)");
    }
  };
}

/**
 * Mint the explicit system actor for non-request callers (workers, consumers, live-suite fixtures that
 * drive the write service directly). It carries no roles and no locations — it is exempt from the caseload
 * gate by `kind`, not by an org-wide role — and must name the org plus the user / membership the authored
 * rows are attributed to. Never call this from a route handler.
 */
export function systemM15Actor(
  organizationId: string,
  attribution: { readonly userId: string; readonly membershipId: string },
): M15WriteActor {
  return {
    kind: "system",
    organizationId,
    userId: attribution.userId,
    membershipId: attribution.membershipId,
    roles: [],
    sessionClass: "staff",
    actorKind: "system",
    locationIds: [],
    stepUpRecent: false,
  };
}
