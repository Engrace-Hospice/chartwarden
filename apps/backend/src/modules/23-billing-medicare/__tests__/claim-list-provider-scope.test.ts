import type { FastifyRequest } from "fastify";
/**
 * M23 §4.7 — the claim LIST's provider scoping (`resolveClaimProviderScope`).
 *
 * REGRESSION: `GET /api/v1/billing/claims` used to carry
 * `PROVIDER_SCOPE("billing.claim.read", targetProviderFromQuery)`. That is a PER-ROW predicate —
 * `provider_entity_billing_scope` resolves ONE resource's ProviderEntity and asks whether the actor is
 * scoped to it. On an unfiltered list there is no such resource, so `targetProviderFromQuery` produced
 * `providerEntityId: ""`, `resolveBillingScopeFacts` returned null, and the predicate denied at its
 * `if (!facts) return false` — BEFORE `inProviderScope`'s org-wide-role bypass could run. Because the
 * guard sets `notFoundOnDeny: true`, that denial surfaced as a **404 for every caller**, org admins
 * included, and the Claim Workbench screen reported it as an unbound read seam.
 *
 * The rule this restores: a per-row predicate cannot gate a collection — collections FILTER, point-reads
 * gate. `GET /claims/:id` keeps its per-row `CLAIM_CASELOAD` gate; the list narrows rows instead.
 */
import { describe, expect, it } from "vitest";
import { resolveClaimProviderScope } from "../routes/claims.routes";

/** A request carrying just the assembled context fields the resolver reads. */
function req(ctx: {
  roles?: readonly string[];
  providerEntityIds?: readonly string[];
  actorKind?: string;
}): FastifyRequest {
  return {
    context: {
      organizationId: "org-1",
      userId: "user-1",
      roles: ctx.roles ?? [],
      providerEntityIds: ctx.providerEntityIds ?? [],
      attributes: ctx.actorKind ? { actorKind: ctx.actorKind } : {},
    },
  } as unknown as FastifyRequest;
}

describe("resolveClaimProviderScope (M23 claim-list authorization narrowing)", () => {
  it("does NOT restrict an org-wide billing role", () => {
    expect(resolveClaimProviderScope(req({ roles: ["org_admin"] }))).toBeUndefined();
    expect(resolveClaimProviderScope(req({ roles: ["compliance_officer"] }))).toBeUndefined();
  });

  it("does NOT restrict a system principal (the M25/M26 service-to-service seam calls)", () => {
    expect(resolveClaimProviderScope(req({ actorKind: "system" }))).toBeUndefined();
  });

  it("narrows a scoped actor to exactly their ProviderEntities", () => {
    const scope = resolveClaimProviderScope(
      req({ roles: ["billing_manager"], providerEntityIds: ["pe-1", "pe-2"] }),
    );
    expect(scope).toEqual(["pe-1", "pe-2"]);
  });

  it("narrows a scoped, PE-less actor to the empty set (TASK-013: providerEntityIds is now assembled)", () => {
    // `bootstrap/plugins/authenticate.ts` now stamps `providerEntityIds` from the actor's real
    // `ActorEnrichment` (membership.defaultProviderEntityId) — an empty array is a real fact (this
    // membership carries no default PE), not "the fact was never assembled", so it correctly narrows
    // to zero claims for a non-org-wide role instead of leaving the list unrestricted.
    expect(resolveClaimProviderScope(req({ roles: ["billing_manager"] }))).toEqual([]);
  });

  it("never reads the provider from the query string (authorization is server-derived)", () => {
    const r = req({ roles: ["billing_manager"], providerEntityIds: ["pe-1"] });
    (r as unknown as { query: unknown }).query = { providerEntityId: "pe-999-not-mine" };
    // The caller's ?providerEntityId= is a DISPLAY filter applied separately and ANDed with this scope,
    // so naming someone else's provider can only ever narrow to the empty set, never widen.
    expect(resolveClaimProviderScope(r)).toEqual(["pe-1"]);
  });
});
