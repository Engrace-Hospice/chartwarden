// apps/backend/__tests__/m3-inorg-predicate.test.ts — the M3-base `inOrg` ABAC predicate.
//
// Modules composed on `inOrg` as if it existed — M30's abac-predicates.ts says "`inOrg` is excluded — it
// is the M3-base predicate", its permission-keys.ts says "the route also passes the M3-base `inOrg`
// predicate" — but nothing registered it. The registry fails closed on an unknown name, so all 15 `inOrg`
// guards across 7 M30 route files denied unconditionally and those endpoints were unreachable by anyone,
// with every gate and unit suite green. It surfaced only when the Quality screens were run against a real
// server.
//
// These tests pin what the predicate asserts AND what it does not: it is the cheap org-scoping
// precondition, never a substitute for RLS.
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AbacContext,
  type AbacTarget,
  abacRegistry,
  resetAuthorizationContract,
} from "@wardenx/auth";
import { M3_IN_ORG_PREDICATE } from "../src/modules/03-authorization/index";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

function context(organizationId: string | undefined): AbacContext {
  return {
    correlationId: "c",
    userId: "u-1",
    organizationId: organizationId ?? "",
    providerEntityIds: [],
    locationIds: [],
    roles: [],
    attributes: {},
    ip: "",
    userAgent: "",
    startTime: 0,
  } as unknown as AbacContext;
}

async function evaluate(ctx: AbacContext, target: AbacTarget): Promise<boolean> {
  // Intrinsic: seeded into the registry on install, so there is nothing to register first.
  return !!(await abacRegistry.evaluate(M3_IN_ORG_PREDICATE, ctx, target));
}

describe("M3 base ABAC predicate — inOrg", () => {
  beforeEach(() => {
    resetAuthorizationContract();
  });

  it("is INTRINSIC — present in the registry with no module registration", () => {
    // Seeded from M3_INTRINSIC_PREDICATES, beside provider_entity_scope / location_scope, so it is
    // live before any module boots. That is what stops a missing base predicate from silently
    // bricking every route that composes on it.
    expect(abacRegistry.has("inOrg")).toBe(true);
  });

  it("allows a COLLECTION route, where the target carries no org", async () => {
    // `defaultTarget` hands requireAbac the route PARAMS, so a list route's target is {}. This is the
    // case that was denying every M30 list endpoint.
    await expect(evaluate(context(ORG_A), {})).resolves.toBe(true);
  });

  it("denies an actor with no resolved organization (fail-closed)", async () => {
    await expect(evaluate(context(undefined), {})).resolves.toBe(false);
  });

  it("allows a target naming the actor's OWN organization", async () => {
    await expect(evaluate(context(ORG_A), { organizationId: ORG_A })).resolves.toBe(true);
    await expect(evaluate(context(ORG_A), { orgId: ORG_A })).resolves.toBe(true);
  });

  it("DENIES a target naming a different organization — the case worth having", async () => {
    // Catches a handler that threads an org id in from a body or a path instead of the session.
    await expect(evaluate(context(ORG_A), { organizationId: ORG_B })).resolves.toBe(false);
    await expect(evaluate(context(ORG_A), { orgId: ORG_B })).resolves.toBe(false);
  });

  it("ignores an ill-typed or empty target org rather than trusting it", async () => {
    // An empty string or a non-string is not a cross-tenant assertion — fall through to the
    // collection case and let RLS scope the rows, rather than denying a well-formed request.
    await expect(evaluate(context(ORG_A), { organizationId: "" })).resolves.toBe(true);
    await expect(
      evaluate(context(ORG_A), { organizationId: 42 as unknown as string }),
    ).resolves.toBe(true);
  });

  it("does NOT claim row-level tenancy — a same-org target says nothing about the rows", async () => {
    // Documents the boundary in an executable place: inOrg is the precondition, RLS is the control
    // (proven per module in packages/db/migrations/__tests__/*.live.test.ts). A reader who mistakes
    // this predicate for tenant isolation would under-protect a new route.
    await expect(evaluate(context(ORG_A), { incidentId: "any-id-at-all" })).resolves.toBe(true);
  });
});
