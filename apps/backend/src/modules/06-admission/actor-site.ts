// apps/backend/src/modules/06-admission/actor-site.ts — the site a patient created from a referral is stamped
// with: the creating actor's ONE default provider entity (and location), and only when the actor really has
// exactly one. An actor with several sites and no clear default, or none (an org-wide admin / intake user),
// leaves the patient unsited — a stamp must never be an arbitrary pick from a multi-site list.
import type { AbacContext } from "@chartwarden/auth";

/** A site to stamp on a new patient: the provider entity, and the location when the actor has exactly one. */
export interface ActorSite {
  readonly providerEntityId: string;
  readonly locationId: string | null;
}

export function soleSiteOf(
  ctx: Pick<AbacContext, "providerEntityIds" | "locationIds">,
): ActorSite | null {
  if (ctx.providerEntityIds.length !== 1) return null;
  const [providerEntityId] = ctx.providerEntityIds;
  if (!providerEntityId) return null;
  return {
    providerEntityId,
    locationId: ctx.locationIds.length === 1 ? (ctx.locationIds[0] ?? null) : null,
  };
}
