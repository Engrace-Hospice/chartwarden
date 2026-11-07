// M24 route actor: the route-kit actor plus the GAP-145 provider-entity scope the list reads narrow to
// (server-assembled by M2, never from the request; an empty set sees nothing).
import { type ContextCarrier, type RouteActor, actorOf } from "@chartwarden/shared/route-kit";

export interface M24Actor extends Pick<RouteActor, "organizationId" | "userId" | "roles"> {
  readonly providerEntityIds?: readonly string[];
}

export function m24ActorOf(request: ContextCarrier): RouteActor & M24Actor {
  return { ...actorOf(request), providerEntityIds: request.context?.providerEntityIds ?? [] };
}
