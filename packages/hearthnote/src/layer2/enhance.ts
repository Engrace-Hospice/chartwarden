// packages/hearthnote/src/layer2/enhance.ts — M8-T05 (spec §2.6 "Layer 2", architecture §10.5.3).
//
// Layer 2 (LLM enhancement) built BEHIND the `hearthnote.layer2` flag, which is OFF in Phase 1. This is a
// deny-stub: the real call dispatches to `packages/ai-platform`'s `narrativeEnhancement` capability (M32,
// Wave H) — M8 never imports `@anthropic-ai/sdk` directly (vendor-adapter mandate, architecture §25.14).
// Until that lands, `enhanceNarrative` evaluates the §2.6 eligibility ladder, never leaves the process,
// and returns the Layer-1 narrative verbatim as the deterministic fallback (architecture §1458). Every
// function is pure; the eligibility ladder is the real T09/Wave-F logic, shipped and tested now.
import type { Layer2EligibilityReason } from "@chartwarden/types";

/** The HearthNote platform feature flags. `layer2` is the Phase-1 global kill (default OFF). */
export interface HearthnoteFlags {
  /** Master switch for the Layer-2 LLM path. Phase 1: OFF — see {@link DEFAULT_HEARTHNOTE_FLAGS}. */
  readonly layer2: boolean;
}

/** Phase-1 defaults: Layer 2 disabled platform-wide until M32's BAA+ZDR path is wired. */
export const DEFAULT_HEARTHNOTE_FLAGS: HearthnoteFlags = { layer2: false } as const;

/** The per-tenant / per-clinician / per-encounter-type Layer-2 gates (§2.6, evaluated at finalize-time). */
export interface Layer2TenantEligibility {
  /** Tenant has opted into Layer 2 (M2 tenant flag). */
  readonly tenantEnabled: boolean;
  /** Authoring clinician has opted OUT (M2 per-clinician override). */
  readonly clinicianOptedOut: boolean;
  /** This encounter type is in the tenant's Layer-2 opt-in set. */
  readonly encounterTypeOptedIn: boolean;
  /** The vendor BAA is executed (M08-F01 / ADR-0012 D4). */
  readonly baaExecuted: boolean;
  /** Tenant token budget has headroom (M32 enforces the cap; here it is an injected fact). */
  readonly tokenBudgetAvailable: boolean;
}

/**
 * Evaluate the §2.6 eligibility ladder. Returns the FIRST failing reason in priority order, or
 * `"eligible"` when every gate passes. `platformEnabled` (the `hearthnote.layer2` flag) is the outermost
 * gate: when off — as in Phase 1 — the result is always `"kill_switch_active"`.
 */
export function evaluateLayer2Eligibility(
  platformEnabled: boolean,
  t: Layer2TenantEligibility,
): Layer2EligibilityReason {
  if (!platformEnabled) return "kill_switch_active";
  if (!t.tenantEnabled) return "tenant_flag_off";
  if (t.clinicianOptedOut) return "clinician_opted_out";
  if (!t.encounterTypeOptedIn) return "encounter_type_excluded";
  if (!t.baaExecuted) return "baa_not_executed";
  if (!t.tokenBudgetAvailable) return "token_budget_exceeded";
  return "eligible";
}

/** The Layer-2 request: the Layer-1 narrative + the flags + the per-tenant eligibility facts. */
export interface EnhanceRequest {
  /** The deterministic Layer-1 narrative (the ground truth and the fallback). */
  readonly layer1: string;
  readonly flags: HearthnoteFlags;
  readonly eligibility: Layer2TenantEligibility;
}

/**
 * The outcome of a Layer-2 attempt. In Phase 1 only the `enhanced: false` arm is reachable (the deny-stub
 * always falls back to Layer 1); the `enhanced: true` shape is reserved for when M32 wires the real call.
 */
export type Layer2Outcome = {
  /** Phase 1: always false — no enhancement was applied. */
  readonly enhanced: false;
  /** Why Layer 2 did not run (the eligibility-ladder verdict). */
  readonly reason: Layer2EligibilityReason;
  /** The Layer-1 narrative, preserved verbatim. */
  readonly layer1: string;
  /** The narrative the encounter uses — identical to `layer1` while the deny-stub is in force. */
  readonly final: string;
};

/**
 * Layer-2 deny-stub. Computes the eligibility verdict (using the platform flag as the outer gate) and
 * returns the Layer-1 narrative unchanged. It never calls an LLM and never imports a vendor SDK — the
 * real dispatch to M32's `narrativeEnhancement` lands in Wave H. Pure.
 */
export function enhanceNarrative(req: EnhanceRequest): Layer2Outcome {
  const reason = evaluateLayer2Eligibility(req.flags.layer2, req.eligibility);
  return { enhanced: false, reason, layer1: req.layer1, final: req.layer1 };
}
