// packages/hearthnote/__tests__/layer2.test.ts — M8-T05 (spec §2.6 "Layer 2", architecture §10.5.3).
// The flag-gated deny-stub: Phase-1 always falls back to Layer 1, and the eligibility ladder is real.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEARTHNOTE_FLAGS,
  type Layer2TenantEligibility,
  enhanceNarrative,
  evaluateLayer2Eligibility,
} from "../src/index";

const LAYER1 = "Reason for Visit\nRoutine scheduled visit per care plan.";

const ALL_ELIGIBLE: Layer2TenantEligibility = {
  tenantEnabled: true,
  clinicianOptedOut: false,
  encounterTypeOptedIn: true,
  baaExecuted: true,
  tokenBudgetAvailable: true,
};

describe("DEFAULT_HEARTHNOTE_FLAGS", () => {
  it("ships Layer 2 OFF in Phase 1", () => {
    expect(DEFAULT_HEARTHNOTE_FLAGS.layer2).toBe(false);
  });
});

describe("enhanceNarrative — Phase-1 deny-stub", () => {
  it("returns flag-disabled and the Layer-1 fallback when the platform flag is OFF", () => {
    const out = enhanceNarrative({
      layer1: LAYER1,
      flags: DEFAULT_HEARTHNOTE_FLAGS,
      eligibility: ALL_ELIGIBLE,
    });
    expect(out.enhanced).toBe(false);
    expect(out.reason).toBe("kill_switch_active");
    expect(out.final).toBe(LAYER1);
    expect(out.layer1).toBe(LAYER1);
  });

  it("never mutates the narrative even when every per-tenant gate passes (flag still OFF)", () => {
    const out = enhanceNarrative({ layer1: LAYER1, flags: { layer2: false }, eligibility: ALL_ELIGIBLE });
    expect(out.final).toBe(out.layer1);
  });
});

describe("evaluateLayer2Eligibility — the §2.6 ladder", () => {
  it("the platform flag is the outermost gate", () => {
    expect(evaluateLayer2Eligibility(false, ALL_ELIGIBLE)).toBe("kill_switch_active");
  });

  it("surfaces the first failing per-tenant gate in priority order", () => {
    expect(evaluateLayer2Eligibility(true, { ...ALL_ELIGIBLE, tenantEnabled: false })).toBe(
      "tenant_flag_off",
    );
    expect(evaluateLayer2Eligibility(true, { ...ALL_ELIGIBLE, clinicianOptedOut: true })).toBe(
      "clinician_opted_out",
    );
    expect(evaluateLayer2Eligibility(true, { ...ALL_ELIGIBLE, encounterTypeOptedIn: false })).toBe(
      "encounter_type_excluded",
    );
    expect(evaluateLayer2Eligibility(true, { ...ALL_ELIGIBLE, baaExecuted: false })).toBe(
      "baa_not_executed",
    );
    expect(evaluateLayer2Eligibility(true, { ...ALL_ELIGIBLE, tokenBudgetAvailable: false })).toBe(
      "token_budget_exceeded",
    );
  });

  it("returns 'eligible' only when the flag is on and every gate passes", () => {
    expect(evaluateLayer2Eligibility(true, ALL_ELIGIBLE)).toBe("eligible");
  });
});
