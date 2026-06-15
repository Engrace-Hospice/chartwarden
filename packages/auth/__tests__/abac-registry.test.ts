/**
 * M3-T07 — ABAC predicate registry (M3 spec §4.2, §4.2.1).
 *
 * Accept criterion: "unit test registering + resolving a named predicate." The registry is
 * the seam every later module's `requireAbac` resolves through: modules register predicates
 * BY NAME; the contract's `AbacEvaluator` dispatches to them. These prove register + resolve,
 * DENY BY DEFAULT on an unknown name (a missing predicate is a deny, not an allow — §2.2),
 * single-owner names, the M3-intrinsic scope predicates, and the boot install over the
 * contract seam (so `requireAbac` goes live without leaving an unresolved consumer).
 */
import type { HttpRequestContext } from "@wardenx/types";
import { ForbiddenError } from "@wardenx/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AbacContext,
  type GuardRequest,
  createPredicateRegistry,
  locationScope,
  providerEntityScope,
  registerAbacRegistry,
  requireAbac,
  resetAbacRegistry,
  resetAuthorizationContract,
} from "../src/index";

function makeContext(overrides: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: "org-1",
    userId: "user-1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
    ...overrides,
  };
}

function makeRequest(
  contextOverrides: Partial<HttpRequestContext> = {},
  params: unknown = {},
): GuardRequest {
  return {
    context: {
      correlationId: "corr-1",
      userId: "user-1",
      organizationId: "org-1",
      providerEntityIds: [],
      locationIds: [],
      roles: [],
      attributes: {},
      ip: "127.0.0.1",
      userAgent: "vitest",
      startTime: 0,
      ...contextOverrides,
    },
    params,
  };
}

beforeEach(() => {
  resetAuthorizationContract();
});

describe("createPredicateRegistry — register + resolve", () => {
  it("resolves a registered named predicate against context + target", async () => {
    const registry = createPredicateRegistry({});
    registry.register("is_self", (ctx, target) => target.userId === ctx.userId);

    expect(registry.has("is_self")).toBe(true);
    expect(await registry.evaluate("is_self", makeContext(), { userId: "user-1" })).toBe(true);
    expect(await registry.evaluate("is_self", makeContext(), { userId: "user-2" })).toBe(false);
  });

  it("supports an async (seam-backed) predicate", async () => {
    const registry = createPredicateRegistry({});
    registry.register("async_allow", async () => true);
    expect(await registry.evaluate("async_allow", makeContext(), {})).toBe(true);
  });

  it("DENIES BY DEFAULT on an unregistered predicate (a missing predicate is a deny, §2.2)", async () => {
    const registry = createPredicateRegistry({});
    expect(registry.has("never_registered")).toBe(false);
    // Fail closed by returning false — never throws (a throw would surface as 500, not 403).
    expect(await registry.evaluate("never_registered", makeContext(), {})).toBe(false);
  });

  it("treats predicate names as single-owner (re-registering throws)", () => {
    const registry = createPredicateRegistry({});
    registry.register("dup", () => true);
    expect(() => registry.register("dup", () => false)).toThrow(/already registered/);
  });

  it("seeds M3 intrinsic predicates by default and lists registered names", () => {
    const registry = createPredicateRegistry();
    expect(registry.names()).toEqual(
      expect.arrayContaining(["provider_entity_scope", "location_scope"]),
    );
  });
});

describe("M3 intrinsic predicates (§4.2) — context-assembled, fail closed", () => {
  it("provider_entity_scope: true only when the target PE is in the actor's PE scope", () => {
    const ctx = makeContext({ providerEntityIds: ["pe-1", "pe-2"] });
    expect(providerEntityScope(ctx, { providerEntityId: "pe-2" })).toBe(true);
    expect(providerEntityScope(ctx, { providerEntityId: "pe-9" })).toBe(false);
    expect(providerEntityScope(ctx, {})).toBe(false); // no target PE → deny
  });

  it("location_scope: true only when the target location is in the actor's location scope", () => {
    const ctx = makeContext({ locationIds: ["loc-1"] });
    expect(locationScope(ctx, { locationId: "loc-1" })).toBe(true);
    expect(locationScope(ctx, { locationId: "loc-2" })).toBe(false);
    expect(locationScope(ctx, {})).toBe(false);
  });
});

describe("registerAbacRegistry — installs the evaluator into the contract", () => {
  it("flips requireAbac from deny-default to real named-predicate resolution", async () => {
    const registry = createPredicateRegistry({});
    registry.register("on_caseload", (_ctx, target) => target.id === "patient-9");
    registerAbacRegistry(registry);

    // Predicate true → allow.
    await expect(
      requireAbac("encounter.read", "on_caseload")(makeRequest({}, { id: "patient-9" })),
    ).resolves.toBeUndefined();
    // Predicate false → 403.
    await expect(
      requireAbac("encounter.read", "on_caseload")(makeRequest({}, { id: "patient-1" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Unknown predicate → still fails closed (403), never 500.
    await expect(
      requireAbac("encounter.read", "unknown_predicate")(makeRequest({}, { id: "patient-9" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("resetAbacRegistry restores the fail-closed default (every predicate denies)", async () => {
    const registry = createPredicateRegistry({});
    registry.register("always", () => true);
    registerAbacRegistry(registry);
    resetAbacRegistry();
    await expect(
      requireAbac("encounter.read", "always")(makeRequest({}, { id: "patient-9" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
