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
  type AbacTarget,
  DEVICE_ATTESTATION_ATTRIBUTE,
  type GuardRequest,
  createPredicateRegistry,
  deviceAttestationValid,
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

  // ARCH-001/002: the per-module boot idiom `if (abacRegistry.has(name)) continue;` silently
  // swallowed a cross-module name collision — M8/M9/M11 each registered a bare `cosigner_role_match`
  // and whichever booted first won, with no error, ever. `registerIdempotent` replaces that idiom:
  // a module re-registering its OWN (byte-identical) resolver on reboot stays silent, but a
  // DIFFERENT resolver claiming an already-used name now throws.
  describe("registerIdempotent — same-source reboot is silent, cross-module collision throws", () => {
    it("re-registering the identical predicate function under its own name is a no-op", () => {
      const registry = createPredicateRegistry({});
      const buildPredicate = () => async (_ctx: AbacContext, target: AbacTarget) =>
        target.id === "x";
      registry.registerIdempotent("m8.cosigner_role_match", buildPredicate());
      expect(() =>
        registry.registerIdempotent("m8.cosigner_role_match", buildPredicate()),
      ).not.toThrow();
      expect(registry.has("m8.cosigner_role_match")).toBe(true);
    });

    it("a DIFFERENT resolver registering an already-used name throws (the real collision)", () => {
      const registry = createPredicateRegistry({});
      registry.registerIdempotent(
        "cosigner_role_match",
        async (ctx: AbacContext, target: AbacTarget) => target.encounterId === ctx.userId,
      );
      expect(() =>
        registry.registerIdempotent(
          "cosigner_role_match",
          async (ctx: AbacContext, target: AbacTarget) => target.assessmentId === ctx.userId,
        ),
      ).toThrow(/DIFFERENT resolver/);
    });
  });

  it("seeds M3 intrinsic predicates by default and lists registered names", () => {
    const registry = createPredicateRegistry();
    expect(registry.names()).toEqual(
      expect.arrayContaining([
        "inOrg",
        "provider_entity_scope",
        "location_scope",
        "device_attestation_valid",
      ]),
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

// SecHardening §12.4 — the gate M33's bulk PHI drilldown export (and, per spec, M18/M20's
// field surfaces) add on top of RBAC + step-up. It is REGISTERED-AND-DENYING today rather than
// unregistered: no producer sets the attribute yet, and an unresolvable name denies identically
// but is indistinguishable from a typo — the failure mode that left M30's `inOrg` guards dead
// across 7 route files. `arch:abac-predicates` now fails the build on such a name.
describe("device_attestation_valid (§12.4) — deny-by-default when unresolved", () => {
  it("DENIES when no attestation rides on the context — today's state, for every caller", () => {
    // `applyRequestContext` hard-codes `attributes: {}` and M2 owns no attestation surface
    // (ADR-0023 D2), so this is what the bulk export actually evaluates on every request.
    expect(deviceAttestationValid(makeContext(), {})).toBe(false);
  });

  it("DENIES an attestation the platform did not mark valid", () => {
    const ctx = makeContext({ attributes: { deviceAttestation: { valid: false } } });
    expect(deviceAttestationValid(ctx, {})).toBe(false);
  });

  it("DENIES an ill-typed attestation rather than reading truthiness from it", () => {
    // "Attested" is a verdict, not a coercion: a string, a bare `true`, or a null must not pass.
    for (const raw of ["true", true, 1, null, [], { valid: "true" }, { valid: 1 }]) {
      const ctx = makeContext({ attributes: { deviceAttestation: raw } });
      expect(deviceAttestationValid(ctx, {})).toBe(false);
    }
  });

  it("ALLOWS only an explicit server-verified attestation", () => {
    const ctx = makeContext({
      attributes: {
        deviceAttestation: { valid: true, verifiedAt: "2026-07-30T12:00:00.000Z" },
      },
    });
    expect(deviceAttestationValid(ctx, {})).toBe(true);
  });

  it("ignores the TARGET — it is a property of the session's device, not of the row", () => {
    // A route must not be able to satisfy the device gate by shaping its target.
    const ctx = makeContext();
    expect(deviceAttestationValid(ctx, { deviceAttestation: { valid: true } })).toBe(false);
    expect(deviceAttestationValid(ctx, { valid: true })).toBe(false);
  });

  it("reads the documented attribute key, so the future producer has one place to set", () => {
    const ctx = makeContext({ attributes: { [DEVICE_ATTESTATION_ATTRIBUTE]: { valid: true } } });
    expect(deviceAttestationValid(ctx, {})).toBe(true);
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
