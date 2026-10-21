// @chartwarden/types · policy — the platform-floor `STEP_UP_POLICY` constant (M2-T04; M2
// spec §4.3.1, D9).
//
// Re-homed from the banned `packages/foundation/src/policy` per ADR-0005 D3 / M02-F03:
// this is a leaf-homed policy constant so every consumer (M2's step-up route + resolver,
// M3's `step_up_recent` predicate, M4's privileged-audit accounting) reads the SAME floor
// without a cross-module dependsOn edge. Tenants may TIGHTEN this floor per-operation via
// `tenant_step_up_policy_override` (intersect factors / min on maxAgeSec) — never loosen
// it; the override resolution itself is M2-T05 (apps/backend/src/modules/02-identity).
//
// `StepUpFactor` mirrors the M1-owned `step_up_factor` pgEnum
// (packages/db/src/enums.ts — `['webauthn','totp','sms']`). It is declared here as a
// literal union (not imported) because `packages/types` is a leaf with no app-specific
// dependencies; the DB enum remains the at-rest source of truth.

/** The MFA factor that satisfied a step-up (or login-MFA) challenge. */
export type StepUpFactor = "webauthn" | "totp" | "sms";

export interface StepUpPolicy {
  /** Platform-floor factors that qualify as step-up. SMS is intentionally absent. */
  readonly qualifyingFactors: readonly StepUpFactor[];
  /** Default freshness window in seconds (matches M3's `step_up_recent` default). */
  readonly defaultMaxAgeSec: number;
  /** Consecutive failed step-up attempts before forced session termination. */
  readonly lockoutThreshold: number;
  /** Window (seconds) in which lockout-threshold consecutive failures count. */
  readonly lockoutWindowSec: number;
}

/**
 * The platform floor (M2 spec §4.3.1 / D9). WebAuthn and TOTP qualify; SMS does not —
 * SMS is the D2 accessibility fallback and its cryptographic strength (no public-key
 * proof of possession, vulnerable to SIM swap) is below what step-up requires.
 */
export const STEP_UP_POLICY: StepUpPolicy = Object.freeze({
  qualifyingFactors: ["webauthn", "totp"] as const,
  defaultMaxAgeSec: 300,
  lockoutThreshold: 3,
  lockoutWindowSec: 60,
});
