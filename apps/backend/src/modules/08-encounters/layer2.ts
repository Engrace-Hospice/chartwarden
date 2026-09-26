// apps/backend/src/modules/08-encounters/layer2.ts — §2.6 D5 Layer-2 eligibility, resolved once (#123).
//
// D5 is a five-gate ladder and the module has always owned it: `@wardenx/hearthnote`'s
// `evaluateLayer2Eligibility` is pure, tested, and returns the FIRST failing gate in priority order —
// a REASON, not a boolean. Two places need that answer and used to disagree about it:
//
//   * `finalize` reifies it on `hearthnote_assembled_output.layer2_eligibility`, a NOT NULL enum whose
//     whole purpose is to record why Layer 2 did or did not run (#122).
//   * route 12 (`POST …/hearthnote/enhance`) decides whether to run at all — and used to skip the ladder
//     entirely, answering 200 with the ENCOUNTER's own id cast as a modification id (#123).
//
// Resolving it here means the row and the route cannot say different things about the same encounter.
//
// WHY NOT AN ABAC PREDICATE. The spec's §4.1 route table names a `layer2_eligible` predicate on route 12.
// No such predicate is registered anywhere in the codebase, and adding one would be the wrong shape
// twice: an ABAC boolean discards the reason, which is the only useful part of the answer; and with the
// platform flag off in Phase 1 it would deny every caller forever — a permanently dead endpoint, the
// exact failure `arch:abac-predicates` exists to prevent. The ladder in the service refuses with a
// reason a UI can render instead.
import {
  DEFAULT_HEARTHNOTE_FLAGS,
  type Layer2TenantEligibility,
  evaluateLayer2Eligibility,
} from "@wardenx/hearthnote";
import type { Layer2EligibilityReason } from "@wardenx/types";

/**
 * The per-tenant half of the D5 ladder, every gate at its DENY value.
 *
 * These are never consulted today: `DEFAULT_HEARTHNOTE_FLAGS.layer2` is false platform-wide in Phase 1
 * and the platform flag is the ladder's outermost gate, so it short-circuits on the first line. Binding
 * real facts means building the M2 tenant flag, the per-clinician `hearthnote.layer2_disable` preference
 * and the per-encounter-type opt-in set — none of which exist.
 *
 * They are written fail-closed rather than omitted so that if the platform flag is ever flipped on before
 * those readers land, the verdict degrades to `tenant_flag_off` — the next-truest statement — instead of
 * reporting `eligible` for a path that still cannot run.
 */
export const LAYER2_TENANT_FACTS_UNBOUND: Layer2TenantEligibility = {
  tenantEnabled: false,
  clinicianOptedOut: true,
  encounterTypeOptedIn: false,
  baaExecuted: false,
  tokenBudgetAvailable: false,
} as const;

/** The §2.6 D5 verdict for this platform, today. Phase 1: always `kill_switch_active`. */
export function resolveLayer2Eligibility(): Layer2EligibilityReason {
  return evaluateLayer2Eligibility(DEFAULT_HEARTHNOTE_FLAGS.layer2, LAYER2_TENANT_FACTS_UNBOUND);
}

/**
 * What route 12 answers. Only the `enhanced: false` arm exists, and that is deliberate: `Layer2Outcome`
 * in `@wardenx/hearthnote` is itself typed `enhanced: false` while the real M32 dispatch is unbuilt, so
 * publishing an `enhanced: true` arm would put a shape in the contract that no code path can produce —
 * the published API and the implementation agreeing with each other and both being wrong about what the
 * route does. The arm is added when Wave H can return it, and the compiler will require it then.
 */
export interface Layer2EnhanceOutcome {
  /** Phase 1: always false. An integrator reading the contract learns the feature is off from this. */
  readonly enhanced: false;
  /** The first D5 gate that refused, in the ladder's priority order. */
  readonly reason: Layer2EligibilityReason;
}
