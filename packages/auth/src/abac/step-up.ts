// @chartwarden/auth · abac — the `step_up_recent` freshness/factor decision (M3-T07; spec §4.2.1).
//
// `requireStepUp(opKey)` (require-abac.ts) is a thin `requireAbac` over the `step_up_recent`
// predicate. The predicate itself is registered at boot by M3 (apps/backend/src/modules/
// 03-authorization/abac-predicates.ts), closing over M2's published `SessionContextResolver`
// seam to read the session's `lastStepUpAt`/`lastStepUpFactor`. THIS file is the pure decision
// the predicate delegates to, so the freshness math has one tested home and the boot wiring stays
// a thin adapter (seam read → this function).
//
// FAIL CLOSED (§2.2): a session with no step-up, a non-qualifying factor (SMS — see STEP_UP_POLICY),
// a future-dated stamp (clock skew), or an expired window all deny. The platform-floor policy
// (`STEP_UP_POLICY`, @chartwarden/types leaf) is the baseline; tenants may only TIGHTEN it per-operation
// via M2's override resolver (M2-T05) — never loosen — so applying the floor here is the safe default.
import type { SessionStepUpFields, StepUpPolicy } from "@chartwarden/types";

/**
 * Whether a session's step-up state satisfies `policy` as of `nowMs`. Pure — the boot-registered
 * `step_up_recent` predicate resolves the state via the seam and calls this. Fail-closed on any
 * missing/non-qualifying/expired/future input.
 */
export function isStepUpRecent(
  state: SessionStepUpFields | null,
  policy: StepUpPolicy,
  nowMs: number,
): boolean {
  if (!state || state.lastStepUpAt === null || state.lastStepUpFactor === null) return false;
  if (!policy.qualifyingFactors.includes(state.lastStepUpFactor)) return false;
  const ageMs = nowMs - state.lastStepUpAt.getTime();
  if (ageMs < 0) return false; // future-dated stamp (clock skew) → fail closed
  return ageMs <= policy.defaultMaxAgeSec * 1000;
}
