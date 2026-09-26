// apps/backend/__tests__/ac-03-step-up-tighten-only.test.ts — AC-03: the per-tenant step-up
// tightening is ON the live path (M2 spec §4.3.2 D9; M3 §4.2.1).
//
// WHAT WAS WRONG. Two halves of one control, both absent. `tightenStepUpPolicy` existed and was
// unit-tested, and had ZERO production callers — M3's `step_up_recent` predicate evaluated the raw
// platform floor and never consulted `tenant_step_up_policy_override`, which no code has ever read
// or written. So the exposure ran the OPPOSITE way from "a tenant could loosen the floor": a tenant
// who TIGHTENED step-up for an operation had that configuration silently ignored. The other half —
// the `trg_tenant_step_up_tighten_only` trigger the resolver's comment asserted — did not exist in
// any of the 210 migrations; it lands in 0211 and is proven by the live suite.
//
// These tests run the REAL registered predicate through the REAL seam, because the bug was
// precisely that the pure function everyone tested was not on the path the request takes.
import {
  abacRegistry,
  createInMemorySessionContextStore,
  createInMemoryStepUpOverrideStore,
  createSessionContextResolver,
  tightenStepUpPolicy,
} from "@wardenx/auth";
import { STEP_UP_POLICY } from "@wardenx/types";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  M3_STEP_UP_PREDICATE,
  registerAuthorizationAbacPredicates,
} from "../src/modules/03-authorization/abac-predicates";

const ORG = "11111111-1111-4111-8111-111111ac0301";
const SESSION = "sess_ac03";
const OP = "erx.sign";
const NOW = new Date("2026-08-14T12:00:00Z");

/** A session that stepped up with TOTP `agoSec` ago — inside the floor's 300s window by default. */
function sessionStore(agoSec: number, factor: "webauthn" | "totp" = "totp") {
  return createInMemorySessionContextStore([
    {
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
      sessionId: SESSION,
      userId: "user_1",
      membershipId: "mem_1",
      organizationId: ORG,
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: new Date(NOW.getTime() - agoSec * 1000),
      lastStepUpFactor: factor,
    },
  ]).store;
}

/**
 * Wire the real seam + real predicate, then evaluate `step_up_recent` for `operationKey`.
 *
 * The predicate is registered into the SHARED `abacRegistry`, which is single-owner and never
 * cleared — the first closure registered under a name is the one every later test evaluates
 * (GAP-011). That is fine here and is in fact the point: every input this suite varies reaches the
 * predicate through `getSeam(...)`, which it resolves LAZILY at evaluation time, so re-registering
 * the seam per case does take effect. Only `now` is captured, and it is the same instant throughout.
 */
async function evaluate(opts: {
  agoSec: number;
  factor?: "webauthn" | "totp";
  override?: { qualifyingFactors: readonly ("webauthn" | "totp" | "sms")[]; maxAgeSec: number };
  operationKey?: string | undefined;
}): Promise<boolean> {
  registerSeam(
    "SessionContextResolver",
    createSessionContextResolver(
      sessionStore(opts.agoSec, opts.factor),
      opts.override
        ? createInMemoryStepUpOverrideStore({ [`${ORG}::${OP}`]: opts.override })
        : undefined,
    ),
  );
  registerAuthorizationAbacPredicates({ now: () => NOW.getTime() });
  return abacRegistry.evaluate(
    M3_STEP_UP_PREDICATE,
    {
      organizationId: ORG,
      userId: "user_1",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      attributes: { sessionId: SESSION },
    },
    opts.operationKey === undefined ? {} : { operationKey: opts.operationKey },
  );
}

describe("AC-03 — the tenant step-up tightening is on the live predicate path", () => {
  beforeEach(() => __resetSeamsForTest());

  it("with NO override the platform floor stands (TOTP inside 300s passes)", async () => {
    expect(await evaluate({ agoSec: 120, operationKey: OP })).toBe(true);
  });

  it("a tenant's WebAuthn-only tightening DENIES a TOTP step-up that the floor allows", async () => {
    // The regression this whole change exists for. Before, the predicate read the floor —
    // {webauthn,totp} — so this returned true and the tenant's configuration did nothing.
    expect(
      await evaluate({
        agoSec: 120,
        factor: "totp",
        override: { qualifyingFactors: ["webauthn"], maxAgeSec: 300 },
        operationKey: OP,
      }),
    ).toBe(false);
    // ...and the same tenant's WebAuthn session still passes: it TIGHTENED, it did not break.
    expect(
      await evaluate({
        agoSec: 120,
        factor: "webauthn",
        override: { qualifyingFactors: ["webauthn"], maxAgeSec: 300 },
        operationKey: OP,
      }),
    ).toBe(true);
  });

  it("a tenant's shorter freshness window DENIES a step-up the floor would still accept", async () => {
    expect(await evaluate({ agoSec: 120, operationKey: OP })).toBe(true); // floor: 300s
    expect(
      await evaluate({
        agoSec: 120,
        override: { qualifyingFactors: ["webauthn", "totp"], maxAgeSec: 60 },
        operationKey: OP,
      }),
    ).toBe(false);
  });

  it("the tightening is PER OPERATION — a different operation still resolves the floor", async () => {
    // The override is seeded for `erx.sign` only; a TOTP session gating on another operation is
    // unaffected. This is what makes the operation key load-bearing rather than decorative.
    expect(
      await evaluate({
        agoSec: 120,
        factor: "totp",
        override: { qualifyingFactors: ["webauthn"], maxAgeSec: 300 },
        operationKey: "chart.export",
      }),
    ).toBe(true);
  });

  it("an unkeyed gate resolves the floor rather than throwing or denying", async () => {
    // `requireAbac(_, "step_up_recent")` without `requireStepUp` puts no operationKey in the target.
    expect(await evaluate({ agoSec: 120, operationKey: undefined })).toBe(true);
  });

  it("a LOOSENING override grants the tenant nothing (both knobs)", async () => {
    // The trigger refuses such a row at write time; this proves that even if one reached the table
    // by a path that bypasses the trigger, the resolution cannot honor it.
    // SMS added → intersected away, so an SMS session still fails and TOTP still passes on the floor.
    expect(
      await evaluate({
        agoSec: 120,
        factor: "totp",
        override: { qualifyingFactors: ["webauthn", "totp", "sms"], maxAgeSec: 86_400 },
        operationKey: OP,
      }),
    ).toBe(true);
    // ...but the stretched window is NOT honored: 10 minutes is stale against the floor's 300s.
    expect(
      await evaluate({
        agoSec: 600,
        factor: "totp",
        override: { qualifyingFactors: ["webauthn", "totp", "sms"], maxAgeSec: 86_400 },
        operationKey: OP,
      }),
    ).toBe(false);
  });

  it("still fails closed with no session id on the request", async () => {
    registerSeam("SessionContextResolver", createSessionContextResolver(sessionStore(10)));
    registerAuthorizationAbacPredicates({ now: () => NOW.getTime() });
    expect(
      await abacRegistry.evaluate(
        M3_STEP_UP_PREDICATE,
        {
          organizationId: ORG,
          userId: "user_1",
          roles: [],
          providerEntityIds: [],
          locationIds: [],
          attributes: {},
        },
        { operationKey: OP },
      ),
    ).toBe(false);
  });
});

describe("AC-03 — tightenStepUpPolicy has ONE definition and it only narrows", () => {
  it("resolves the floor when the tenant has configured nothing", () => {
    expect(tightenStepUpPolicy(null)).toEqual({
      qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
      maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
    });
  });

  it("intersects factors and takes the min window, in both directions", () => {
    expect(
      tightenStepUpPolicy({ qualifyingFactors: ["webauthn", "sms"], maxAgeSec: 999_999 }),
    ).toEqual({ qualifyingFactors: ["webauthn"], maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec });
    expect(tightenStepUpPolicy({ qualifyingFactors: ["totp"], maxAgeSec: 30 })).toEqual({
      qualifyingFactors: ["totp"],
      maxAgeSec: 30,
    });
  });

  it("the app-module re-export IS the same function (no second copy to drift)", async () => {
    const m2 = await import("../src/modules/02-identity/policy/step-up-resolver");
    expect(m2.tightenStepUpPolicy).toBe(tightenStepUpPolicy);
  });
});
