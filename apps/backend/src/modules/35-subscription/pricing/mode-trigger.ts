// apps/backend/src/modules/35-subscription/pricing/mode-trigger.ts — who TRIGGERED a system-made billing mode change.
//
// "A tenant that bills outside ChartWarden pays no billing percentage" is a system action (no operator writes it), but it is set off by a
// person: the tenant's own administrator choosing `outside`, or a platform operator doing it for the tenant. That person (an id, never a
// name) and the request's correlation id ride on the audit row, so the mode change joins the trail of the request that caused it. A sweep
// has no request and no person: `system`.
import type { ModeTrigger } from "./ports";

/** The ambient request context's shape this reads (the live `request.context`: `attributes.membershipId` is set by authenticate). */
export interface AmbientRequest {
  readonly organizationId: string;
  readonly userId: string;
  readonly correlationId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export const SYSTEM_TRIGGER: ModeTrigger = {
  kind: "system",
  userId: null,
  membershipId: null,
  correlationId: null,
};

/**
 * `ctx` is the ambient request context (undefined outside a request: a sweep or a worker). A request with no signed-in user is `system`
 * too. A signed-in request in the TARGET organisation is the tenant acting; one from another organisation (the platform's own) is a
 * platform operator acting for the tenant.
 */
export function modeTriggerOf(
  ctx: AmbientRequest | undefined,
  targetOrganizationId: string,
): ModeTrigger {
  if (!ctx || ctx.userId === "") {
    return { ...SYSTEM_TRIGGER, correlationId: ctx?.correlationId ?? null };
  }
  const membershipId = ctx.attributes?.membershipId;
  return {
    kind: ctx.organizationId === targetOrganizationId ? "tenant" : "platform",
    userId: ctx.userId,
    membershipId: typeof membershipId === "string" && membershipId !== "" ? membershipId : null,
    correlationId: ctx.correlationId ?? null,
  };
}
