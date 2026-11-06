// apps/backend/src/modules/16-bereavement/routes/actor.ts — the M16 route actor: the route-kit actor plus
// the M31 portal account a bereaved-family session carries.
//
// §4.1 routes 14 / 15 are reachable by the bereaved person's OWN M31 session, so the actor carries
// `portalAccountId` for the `portal_self_service` gate — and a portal session carries no workforce
// membership, which is why {@link writeActorOf} would reject it. The two portal-self routes therefore use
// {@link mutatingActorOf}, which permits a portal session and leaves `membershipId` null so the opt-out row
// records `recorded_by_user_id = NULL` exactly as §3.3.8 specifies for the self-service path.
import {
  type ContextCarrier,
  type RouteActor,
  type WriteActor,
  actorOf as kitActorOf,
  writeActorOf as kitWriteActorOf,
} from "@chartwarden/shared/route-kit";

/** The M31 portal account behind a bereaved-family session; null for staff (§4.8 `portal_self_service`). */
interface PortalFacet {
  readonly portalAccountId: string | null;
}

/** The READ-route actor (the services and predicates read neither the actor kind nor step-up). */
export type M16ReadActor = Omit<RouteActor, "actorKind" | "stepUpRecent"> & PortalFacet;
/** The mutating actor: `membershipId` stays nullable so the portal-self routes can use it. */
export type M16MutatingActor = M16ReadActor & Pick<RouteActor, "stepUpRecent">;
/** The staff write actor — a guaranteed membership. */
export type M16WriteActor = M16MutatingActor & Pick<WriteActor, "membershipId">;

const portalOf = (request: ContextCarrier): PortalFacet => {
  const id = request.context?.attributes?.portalAccountId;
  return { portalAccountId: typeof id === "string" && id.length > 0 ? id : null };
};

export function actorOf(request: ContextCarrier): M16MutatingActor {
  return { ...kitActorOf(request), ...portalOf(request) };
}

/** Permits a portal session (no membership) — see the module header. */
export const mutatingActorOf = actorOf;

export function writeActorOf(request: ContextCarrier): M16WriteActor {
  return { ...kitWriteActorOf(request), ...portalOf(request) };
}
