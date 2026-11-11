// apps/backend/src/modules/25-remittance/routes/actor.ts — the M25 actor: the route kit's actor plus the
// SERVER-DERIVED provider-entity scope (GAP-073 / GAP-148). `undefined` = unrestricted (an org-wide oversight
// role or the service principal); an array restricts the actor to exactly those ProviderEntities, and an
// EMPTY array matches nothing (fail-closed). Never read off the body/query.
import {
  type ContextCarrier,
  type RouteActor,
  actorOf as kitActorOf,
  writeActorOf as kitWriteActorOf,
} from "@chartwarden/shared/route-kit";
import { BROAD_DENIAL_SCOPE_ROLES } from "../abac-predicates";

export type M25ReadActor = Pick<RouteActor, "organizationId" | "userId" | "roles"> & {
  readonly providerEntityScope?: readonly string[];
};
export type M25WriteActor = M25ReadActor &
  Pick<RouteActor, "stepUpRecent"> & { readonly membershipId: string };

function providerEntityScopeOf(
  request: ContextCarrier,
  actor: RouteActor,
): readonly string[] | undefined {
  if (actor.actorKind === "system") return undefined;
  if (BROAD_DENIAL_SCOPE_ROLES.some((r) => actor.roles.includes(r))) return undefined;
  return request.context?.providerEntityIds ?? [];
}

export function actorOf(request: ContextCarrier): M25ReadActor {
  const actor = kitActorOf(request);
  const { organizationId, userId, roles } = actor;
  return {
    organizationId,
    userId,
    roles,
    providerEntityScope: providerEntityScopeOf(request, actor),
  };
}

export function writeActorOf(request: ContextCarrier): M25WriteActor {
  const actor = kitWriteActorOf(request);
  const { organizationId, userId, roles, membershipId, stepUpRecent } = actor;
  return {
    organizationId,
    userId,
    roles,
    membershipId,
    stepUpRecent,
    providerEntityScope: providerEntityScopeOf(request, actor),
  };
}
