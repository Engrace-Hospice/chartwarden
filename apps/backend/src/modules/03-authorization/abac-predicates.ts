// apps/backend/src/modules/03-authorization/abac-predicates.ts — M3-T07 (spec §4.2.1).
//
// The `step_up_recent` predicate M3 OWNS and registers into its own named-predicate registry at
// boot. `requireStepUp(opKey)` (packages/auth · require-abac.ts) is a thin `requireAbac` over this
// name, carrying the operation key as the target. Every high-PHI route's step-up ceremony resolves
// through here — so the freshness decision has ONE home.
//
// The resolver delegates to M2's published `SessionContextResolver` seam (§4.7) to read the session's
// `lastStepUpAt`/`lastStepUpFactor` (a typed contract, never a direct read of the M1-owned `session`
// table), then to the pure `isStepUpRecent` decision (packages/auth · step-up.ts) against the platform
// floor `STEP_UP_POLICY`. Fail-closed throughout: no session id on the request, no org, or a missing/
// stale/non-qualifying step-up all deny. Registered once, idempotently (the registry is single-owner /
// no-clear, so re-boot in tests is idempotent via `registerPredicateIdempotent`).
import {
  type AbacContext,
  type AbacTarget,
  isStepUpRecent,
  registerPredicateIdempotent,
} from "@wardenx/auth";
import { STEP_UP_POLICY } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";

/** The single predicate name M3 owns for the step-up ceremony (the §4.2.1 freshness gate). */
export const M3_STEP_UP_PREDICATE = "step_up_recent";

/** The M3-BASE org-scoping predicate name. The predicate itself is INTRINSIC — seeded into every
 *  registry from `@wardenx/auth` (`M3_INTRINSIC_PREDICATES`), beside provider_entity_scope /
 *  location_scope — so it is live before any module boots. Re-exported here as the name modules gate on. */
export const M3_IN_ORG_PREDICATE = "inOrg";

/**
 * Register M3's `step_up_recent` predicate into the registry (M3-T07; idempotent). Resolves the
 * session step-up state through M2's `SessionContextResolver` seam (lazily, at request time — the
 * seam is registered earlier in `wireModuleSeams`) and decides via the pure `isStepUpRecent`. Call
 * at boot inside `wireModuleSeams`, before `registerAbacRegistry()` installs the evaluator.
 *
 * `deps.now` is injectable for deterministic tests (defaults to wall-clock at evaluation time).
 */
export function registerAuthorizationAbacPredicates(deps: { now?: () => number } = {}): void {
  const now = deps.now ?? (() => Date.now());
  registerPredicateIdempotent(M3_STEP_UP_PREDICATE, async (context: AbacContext, _target: AbacTarget) => {
    const sessionId =
      typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null;
    if (!sessionId || !context.organizationId) return false; // fail-closed
    // The platform floor applies uniformly; per-operation tightening (target.operationKey →
    // tenant_step_up_policy_override) is M2-T05's resolver and layers on top once it lands.
    const state = await getSeam("SessionContextResolver").resolveStepUpState(
      { orgId: context.organizationId },
      sessionId,
    );
    return isStepUpRecent(state, STEP_UP_POLICY, now());
  });
}
