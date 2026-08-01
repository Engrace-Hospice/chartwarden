// Module 32 — §4.1 / §6 gate order, §3.2.4/§3.2.13/W8 routing, §3.2.9/D7/W2 token cap (M32-T04).
//
// The three pure rules the invocation pipeline is built from. Each test below pins a decision that
// would otherwise be a comment, and every rule with a plausible opposite (local_only falling back to
// cloud, an unconfigured budget reading as unlimited, a cheaper gate pre-empting a safety one) has the
// opposite asserted too.

import { describe, expect, it } from "vitest";

import {
  AI_ROUTABLE_HEALTH_STATUSES,
  AI_TOKEN_SOFT_CAP_DEFAULT_RATIO,
  aiInvocationGateRecordsLedgerRow,
  aiPreferredKindOrder,
  aiTokenBudgetFor,
  aiTokenCapRefuses,
  aiTokenCapStateFor,
  aiTokenCapWindowFor,
  aiTokenSoftCapCrossedBy,
  evaluateAiInvocationGates,
  resolveAiRoute,
} from "../src/index";
import type {
  AiBackendRoutingRow,
  AiInvocationGateFacts,
  AiRouteResolutionInput,
  AiRoutingCapabilitySnapshot,
} from "../src/index";

const T0 = "2026-08-15T12:00:00.000Z";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────

function backend(overrides: Partial<AiBackendRoutingRow> & { backendKey: string }): AiBackendRoutingRow {
  return {
    backendId: `id-${overrides.backendKey}`,
    kind: "cloud",
    isActive: true,
    lastHealthStatus: "healthy",
    zdrStatus: "enabled",
    modelVersionPin: `${overrides.backendKey}-pin`,
    supportedModalities: ["text"],
    ...overrides,
  };
}

const CLOUD = backend({ backendKey: "anthropic-claude-opus-4-7" });
const CLOUD_FALLBACK = backend({ backendKey: "anthropic-claude-haiku-4-5" });
const LOCAL = backend({
  backendKey: "local-llama-3.1-8b-instruct",
  kind: "local",
  zdrStatus: "not_applicable",
});

function registry(...rows: AiBackendRoutingRow[]): ReadonlyMap<string, AiBackendRoutingRow> {
  return new Map(rows.map((r) => [r.backendKey, r]));
}

const capability: AiRoutingCapabilitySnapshot = {
  defaultBackendKey: CLOUD.backendKey,
  allowedBackendKeys: [CLOUD.backendKey, CLOUD_FALLBACK.backendKey, LOCAL.backendKey],
  fallbackChainKeys: [CLOUD_FALLBACK.backendKey, LOCAL.backendKey],
  tenantOverrideAllowed: true,
  requiredModality: null,
};

function route(overrides: Partial<AiRouteResolutionInput> = {}) {
  return resolveAiRoute({
    capability,
    routingPreference: "prefer_cloud",
    override: null,
    backends: registry(CLOUD, CLOUD_FALLBACK, LOCAL),
    ...overrides,
  });
}

// ── §3.2.4 / §3.2.13 / W8 routing ─────────────────────────────────────────────────────────────────

describe("resolveAiRoute — the chain, the preference and the health filter", () => {
  it("serves the capability's default as the primary with reason 'default'", () => {
    const resolved = route();
    expect(resolved.servable?.backendKey).toBe(CLOUD.backendKey);
    expect(resolved.servable?.decision).toBe("primary");
    expect(resolved.servable?.reason).toBe("default");
    expect(resolved.refusal).toBeNull();
  });

  it("copies the registry's model pin onto the route — the ledger records the model that ran", () => {
    expect(route().servable?.modelVersionPin).toBe(`${CLOUD.backendKey}-pin`);
  });

  it("walks to the next link when the primary is unhealthy, and calls it a vendor outage", () => {
    const resolved = route({
      backends: registry(backend({ ...CLOUD, lastHealthStatus: "unhealthy" }), CLOUD_FALLBACK, LOCAL),
    });
    expect(resolved.servable?.backendKey).toBe(CLOUD_FALLBACK.backendKey);
    expect(resolved.servable?.decision).toBe("fallback_1");
    // `cost_cap_fallback` exists to be distinguishable from this; a health skip must not claim it.
    expect(resolved.servable?.reason).toBe("vendor_outage_fallback");
  });

  it("routes to a degraded backend but never to an unprobed one", () => {
    expect(AI_ROUTABLE_HEALTH_STATUSES).toEqual(["healthy", "degraded"]);
    expect(
      route({ backends: registry(backend({ ...CLOUD, lastHealthStatus: "degraded" })) }).servable
        ?.backendKey,
    ).toBe(CLOUD.backendKey);
    // `unknown` is registered-but-never-probed. D17 gates a local_only opt-in on `healthy`, so routing
    // must not be more permissive than the opt-in that authorised it.
    expect(
      route({ backends: registry(backend({ ...CLOUD, lastHealthStatus: "unknown" })) }).servable,
    ).toBeNull();
  });

  it("skips an inactive backend even when its recorded health is green", () => {
    expect(
      route({ backends: registry(backend({ ...CLOUD, isActive: false })) }).servable,
    ).toBeNull();
  });

  it("W8 — local_only never reaches cloud, even when every local backend is down", () => {
    const resolved = route({
      routingPreference: "local_only",
      backends: registry(CLOUD, CLOUD_FALLBACK, backend({ ...LOCAL, lastHealthStatus: "unhealthy" })),
    });
    // W8.3 verbatim: the Anthropic backend is not contacted under any circumstance.
    expect(resolved.servable).toBeNull();
    expect(resolved.refusal?.cause).toBe("no_healthy_backend");
    // And the ledger names the LOCAL backend, not the cloud default — a row saying "anthropic" for a
    // local_only tenant would be a false entry in the record built to be read as true.
    expect(resolved.ledgerRoute?.backendKey).toBe(LOCAL.backendKey);
  });

  it("W8 — local_only with no local backend in the chain resolves to nothing at all", () => {
    const resolved = route({
      routingPreference: "local_only",
      backends: registry(CLOUD, CLOUD_FALLBACK),
    });
    expect(resolved.servable).toBeNull();
    expect(resolved.refusal?.cause).toBe("no_backend_under_routing_preference");
    // No truthful route exists, so no row can be written — the pipeline reports that rather than
    // inventing a backend.
    expect(resolved.ledgerRoute).toBeNull();
  });

  it("prefer_local reorders rather than filters — a cloud backend still serves when local is down", () => {
    expect(aiPreferredKindOrder("prefer_local")).toEqual(["local", "cloud"]);
    const healthy = route({ routingPreference: "prefer_local" });
    expect(healthy.servable?.backendKey).toBe(LOCAL.backendKey);
    const localDown = route({
      routingPreference: "prefer_local",
      backends: registry(CLOUD, CLOUD_FALLBACK, backend({ ...LOCAL, lastHealthStatus: "unhealthy" })),
    });
    expect(localDown.servable?.kind).toBe("cloud");
  });

  it("a null preference (no opt-in on record) keeps the capability's own chain order", () => {
    // NOT the same as `prefer_cloud`, which would reorder cloud-first on behalf of a tenant who has
    // expressed nothing. Here the capability's declared default leads.
    const localFirst: AiRoutingCapabilitySnapshot = {
      ...capability,
      defaultBackendKey: LOCAL.backendKey,
      fallbackChainKeys: [CLOUD.backendKey],
    };
    expect(
      resolveAiRoute({
        capability: localFirst,
        routingPreference: null,
        override: null,
        backends: registry(CLOUD, LOCAL),
      }).servable?.backendKey,
    ).toBe(LOCAL.backendKey);
    expect(
      resolveAiRoute({
        capability: localFirst,
        routingPreference: "prefer_cloud",
        override: null,
        backends: registry(CLOUD, LOCAL),
      }).servable?.backendKey,
    ).toBe(CLOUD.backendKey);
  });

  it("an active override wins and is labelled `tenant_override`", () => {
    const resolved = route({
      override: { backendKeyPreference: LOCAL.backendKey, effectiveAt: T0, expiresAt: null },
      routingPreference: "prefer_cloud",
    });
    expect(resolved.servable?.backendKey).toBe(LOCAL.backendKey);
    expect(resolved.servable?.reason).toBe("tenant_override");
  });

  it("an override outside the allowed set REFUSES rather than falling back to the default", () => {
    const resolved = route({
      override: { backendKeyPreference: "local-mistral-7b-instruct", effectiveAt: T0, expiresAt: null },
    });
    // Silently serving the cloud default would do the one thing a `tenant_sovereignty` override exists
    // to prevent.
    expect(resolved.servable).toBeNull();
    expect(resolved.ledgerRoute).toBeNull();
    expect(resolved.refusal?.cause).toBe("override_outside_allowed_set");
  });

  it("an override on a capability that forbids overrides refuses instead of being ignored", () => {
    const resolved = route({
      capability: { ...capability, tenantOverrideAllowed: false },
      override: { backendKeyPreference: LOCAL.backendKey, effectiveAt: T0, expiresAt: null },
    });
    expect(resolved.refusal?.cause).toBe("override_forbidden_by_capability");
  });

  it("de-duplicates the chain so a repeated default does not push a real fallback to fallback_2", () => {
    const resolved = route({
      capability: {
        ...capability,
        fallbackChainKeys: [CLOUD.backendKey, CLOUD_FALLBACK.backendKey],
      },
      backends: registry(backend({ ...CLOUD, lastHealthStatus: "unhealthy" }), CLOUD_FALLBACK),
    });
    expect(resolved.servable?.decision).toBe("fallback_1");
  });

  it("drops a chain key the capability does not allow", () => {
    const resolved = route({
      capability: { ...capability, allowedBackendKeys: [LOCAL.backendKey] },
      routingPreference: "prefer_cloud",
    });
    expect(resolved.servable?.backendKey).toBe(LOCAL.backendKey);
  });

  it("filters on modality when the capability declares one", () => {
    const embedder = backend({
      backendKey: "local-bge-small-en",
      kind: "local",
      zdrStatus: "not_applicable",
      supportedModalities: ["embedding"],
    });
    const resolved = resolveAiRoute({
      capability: {
        defaultBackendKey: CLOUD.backendKey,
        allowedBackendKeys: [CLOUD.backendKey, embedder.backendKey],
        fallbackChainKeys: [embedder.backendKey],
        tenantOverrideAllowed: false,
        requiredModality: "embedding",
      },
      routingPreference: null,
      override: null,
      backends: registry(CLOUD, embedder),
    });
    expect(resolved.servable?.backendKey).toBe(embedder.backendKey);
  });

  it("sets zdr_confirmed from the registry, which is what makes a refused row satisfiable", () => {
    // §3.2.8's CHECK refuses an `anthropic-%` row without `zdr_confirmed`. The value is knowable from
    // the registry without dispatching — which is exactly why a gate-refused call can carry a true one.
    expect(route().ledgerRoute?.zdrConfirmed).toBe(true);
    expect(
      route({ routingPreference: "local_only" }).ledgerRoute?.zdrConfirmed,
    ).toBe(false);
  });
});

// ── §3.2.9 / D6 / D7 / W2 token cap ───────────────────────────────────────────────────────────────

describe("token cap", () => {
  it("derives the soft cap at the 80% §1.1 states", () => {
    expect(AI_TOKEN_SOFT_CAP_DEFAULT_RATIO).toBe(0.8);
    expect(aiTokenBudgetFor(1_000).softCapTokens).toBe(800);
    expect(aiTokenBudgetFor(1_000, 500).softCapTokens).toBe(500);
  });

  it("windows on the UTC calendar month, half-open, matching the partition", () => {
    expect(aiTokenCapWindowFor(T0)).toEqual({
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
    });
    // December rolls the year rather than producing month 12.
    expect(aiTokenCapWindowFor("2026-12-31T23:59:59.000Z").end).toBe("2027-01-01T00:00:00.000Z");
    // The boundary instant belongs to the NEXT window, so one accrual is never charged to two caps.
    expect(aiTokenCapWindowFor("2026-09-01T00:00:00.000Z").start).toBe("2026-09-01T00:00:00.000Z");
  });

  it("breaches AT the cap, not past it", () => {
    const budget = aiTokenBudgetFor(1_000);
    expect(aiTokenCapStateFor({ spentTokens: 799, budget })).toBe("within");
    expect(aiTokenCapStateFor({ spentTokens: 800, budget })).toBe("soft_breached");
    expect(aiTokenCapStateFor({ spentTokens: 999, budget })).toBe("soft_breached");
    expect(aiTokenCapStateFor({ spentTokens: 1_000, budget })).toBe("hard_breached");
  });

  it("an unconfigured budget is its own state — and it refuses, it does not mean unlimited", () => {
    const state = aiTokenCapStateFor({ spentTokens: 0, budget: null });
    expect(state).toBe("budget_unconfigured");
    expect(state).not.toBe("hard_breached");
    // Both refuse; only `hard_breached` is a spend incident worth an alert (see token-cap.ts).
    expect(aiTokenCapRefuses("budget_unconfigured")).toBe(true);
    expect(aiTokenCapRefuses("hard_breached")).toBe(true);
    expect(aiTokenCapRefuses("soft_breached")).toBe(false);
    expect(aiTokenCapRefuses("within")).toBe(false);
  });

  it("W1.7 — the soft-cap alert fires on the accrual that CROSSES, not on every call after it", () => {
    const budget = aiTokenBudgetFor(1_000);
    expect(
      aiTokenSoftCapCrossedBy({ spentTokensBefore: 790, accruedTokens: 20, budget }),
    ).toBe(true);
    expect(
      aiTokenSoftCapCrossedBy({ spentTokensBefore: 810, accruedTokens: 20, budget }),
    ).toBe(false);
    expect(
      aiTokenSoftCapCrossedBy({ spentTokensBefore: 790, accruedTokens: 20, budget: null }),
    ).toBe(false);
  });
});

// ── §6 / §4.1 gate order ──────────────────────────────────────────────────────────────────────────

const passing: AiInvocationGateFacts = {
  aiFullEnabled: true,
  lifecycleState: "APPROVED",
  killSwitchActive: false,
  tenantOptInRequired: true,
  tenantOptInStatus: "active",
  tenantPilotEnrollment: false,
  clinicianOptedOut: false,
  tokenCapState: "within",
  phiMinimization: { permitted: true, detail: "" },
  route: route(),
};

/** Every gate failing at once. Which reason surfaces IS the order. */
const allFailing: AiInvocationGateFacts = {
  ...passing,
  aiFullEnabled: false,
  lifecycleState: "PROPOSED",
  killSwitchActive: true,
  tenantOptInStatus: "opted_out",
  clinicianOptedOut: true,
  tokenCapState: "hard_breached",
  phiMinimization: { permitted: false, detail: "smuggled field" },
  route: route({ backends: registry() }),
};

describe("evaluateAiInvocationGates — the §6 order, pinned", () => {
  it("dispatches when every gate clears", () => {
    const decision = evaluateAiInvocationGates(passing);
    expect(decision.dispatch).toBe(true);
    if (decision.dispatch) expect(decision.route.backendKey).toBe(CLOUD.backendKey);
  });

  it("reports the gates in §6 order when they all fail, one peeled off at a time", () => {
    const order: { facts: AiInvocationGateFacts; gate: string }[] = [
      { facts: allFailing, gate: "ai_full_flag" },
      { facts: { ...allFailing, aiFullEnabled: true }, gate: "lifecycle" },
      {
        facts: { ...allFailing, aiFullEnabled: true, lifecycleState: "APPROVED" },
        gate: "kill_switch",
      },
      {
        facts: {
          ...allFailing,
          aiFullEnabled: true,
          lifecycleState: "APPROVED",
          killSwitchActive: false,
        },
        gate: "tenant_opt_in",
      },
      {
        facts: {
          ...allFailing,
          aiFullEnabled: true,
          lifecycleState: "APPROVED",
          killSwitchActive: false,
          tenantOptInStatus: "active",
        },
        gate: "clinician_opt_out",
      },
      {
        facts: {
          ...allFailing,
          aiFullEnabled: true,
          lifecycleState: "APPROVED",
          killSwitchActive: false,
          tenantOptInStatus: "active",
          clinicianOptedOut: false,
        },
        gate: "token_cap",
      },
      {
        facts: {
          ...allFailing,
          aiFullEnabled: true,
          lifecycleState: "APPROVED",
          killSwitchActive: false,
          tenantOptInStatus: "active",
          clinicianOptedOut: false,
          tokenCapState: "within",
        },
        gate: "phi_minimization",
      },
      {
        facts: {
          ...allFailing,
          aiFullEnabled: true,
          lifecycleState: "APPROVED",
          killSwitchActive: false,
          tenantOptInStatus: "active",
          clinicianOptedOut: false,
          tokenCapState: "within",
          phiMinimization: { permitted: true, detail: "" },
        },
        gate: "routing",
      },
    ];

    for (const { facts, gate } of order) {
      const decision = evaluateAiInvocationGates(facts);
      expect(decision.dispatch).toBe(false);
      if (!decision.dispatch) expect(decision.gate).toBe(gate);
    }
  });

  it("a cost guardrail never pre-empts a safety or consent refusal", () => {
    const decision = evaluateAiInvocationGates({
      ...passing,
      killSwitchActive: true,
      tokenCapState: "hard_breached",
    });
    expect(decision.dispatch).toBe(false);
    if (!decision.dispatch) expect(decision.unavailable.reason).toBe("kill_switch_active");
  });

  it("W9 — a PROPOSED capability answers `lifecycle_state_below_approved` and names the state", () => {
    const decision = evaluateAiInvocationGates({ ...passing, lifecycleState: "PROPOSED" });
    expect(decision.dispatch).toBe(false);
    if (!decision.dispatch) {
      expect(decision.unavailable.reason).toBe("lifecycle_state_below_approved");
      expect(decision.unavailable.currentState).toBe("PROPOSED");
    }
  });

  it("a consent refusal does NOT disclose the platform's governance state", () => {
    const decision = evaluateAiInvocationGates({ ...passing, clinicianOptedOut: true });
    expect(decision.dispatch).toBe(false);
    if (!decision.dispatch) expect(decision.unavailable.currentState).toBeUndefined();
  });

  it("W2 — a hard cap refuses without dispatching, and stamps the ledger `cost_cap_fallback`", () => {
    const decision = evaluateAiInvocationGates({ ...passing, tokenCapState: "hard_breached" });
    expect(decision.dispatch).toBe(false);
    if (!decision.dispatch) {
      expect(decision.unavailable.reason).toBe("token_hard_cap_reached");
      // D7's distinction: the ledger must tell a cap fallback from a vendor outage.
      expect(decision.ledgerRoute?.reason).toBe("cost_cap_fallback");
      expect(decision.ledgerRoute?.backendKey).toBe(CLOUD.backendKey);
    }
  });

  it("an unconfigured budget refuses with the same reason but a different detail", () => {
    const decision = evaluateAiInvocationGates({ ...passing, tokenCapState: "budget_unconfigured" });
    expect(decision.dispatch).toBe(false);
    if (!decision.dispatch) {
      expect(decision.unavailable.reason).toBe("token_hard_cap_reached");
      expect(decision.detail).toContain("no monthly token budget is configured");
    }
  });

  it("a smuggled chart-context field is its own reason, not a vendor outage", () => {
    const decision = evaluateAiInvocationGates({
      ...passing,
      phiMinimization: { permitted: false, detail: "unexpected property 'patientName'" },
    });
    expect(decision.dispatch).toBe(false);
    if (!decision.dispatch) {
      expect(decision.unavailable.reason).toBe("phi_minimization_failure");
      expect(decision.detail).toContain("patientName");
    }
  });

  it("every gate but `ai.full` writes the §164.528 ledger row", () => {
    // W2.4 and W9.3 both require a row for a refused call; the flag is a deployment posture with no
    // tenant, patient or capability decision behind it.
    expect(aiInvocationGateRecordsLedgerRow("ai_full_flag")).toBe(false);
    for (const gate of [
      "lifecycle",
      "kill_switch",
      "tenant_opt_in",
      "clinician_opt_out",
      "token_cap",
      "phi_minimization",
      "routing",
    ] as const) {
      expect(aiInvocationGateRecordsLedgerRow(gate)).toBe(true);
    }
  });

  it("the `ai.full` refusal carries no ledger route even when one was resolvable", () => {
    const decision = evaluateAiInvocationGates({ ...passing, aiFullEnabled: false });
    expect(decision.dispatch).toBe(false);
    if (!decision.dispatch) {
      expect(decision.unavailable.reason).toBe("phase_1_capability_shell");
      expect(decision.ledgerRoute).toBeNull();
    }
  });
});
