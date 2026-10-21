// apps/backend/src/modules/03-authorization/abac-predicates.ts — M3-T07 (spec §4.2.1).
//
// The `step_up_recent` predicate M3 OWNS and registers into its own named-predicate registry at
// boot. `requireStepUp(opKey)` (packages/auth · require-abac.ts) is a thin `requireAbac` over this
// name, carrying the operation key as the target. Every high-PHI route's step-up ceremony resolves
// through here — so the freshness decision has ONE home.
//
// The resolver delegates to M2's published `SessionContextResolver` seam (§4.7) for BOTH halves of the
// decision — the session's `lastStepUpAt`/`lastStepUpFactor` (a typed contract, never a direct read of
// the M1-owned `session` table) and the effective policy for the operation, which is the platform floor
// `STEP_UP_POLICY` tightened by the tenant's `tenant_step_up_policy_override` row (§4.3.2, D9) — then to
// the pure `isStepUpRecent` decision (packages/auth · step-up.ts). Fail-closed throughout: no session id
// on the request, no org, or a missing/stale/non-qualifying step-up all deny — the whole resolution is
// `stepUpFreshFor` (apps/backend/src/bootstrap/step-up.ts), shared with the routes that need the same
// answer as a BOOLEAN rather than as a guard (F-028). Registered once,
// idempotently (the registry is single-owner / no-clear, so re-boot in tests is idempotent via
// `registerPredicateIdempotent`).
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@chartwarden/auth";
import { STEP_UP_FLOOR_KEY, stepUpFreshFor } from "../../bootstrap/index";

/** The single predicate name M3 owns for the step-up ceremony (the §4.2.1 freshness gate). */
export const M3_STEP_UP_PREDICATE = "step_up_recent";

/**
 * The operation key used when a caller gates on `step_up_recent` WITHOUT naming an operation
 * (a bare `requireAbac(_, "step_up_recent")` rather than `requireStepUp(opKey)`). No tenant row
 * can carry this key — `tenant_step_up_policy_override.operation_key` is written by the tenant's
 * own configuration — so it resolves to the platform floor, which is the correct reading of an
 * unnamed operation: unconfigurable, therefore un-tightenable, therefore the floor.
 */
export const M3_STEP_UP_FLOOR_KEY = STEP_UP_FLOOR_KEY;

/** The M3-BASE org-scoping predicate name. The predicate itself is INTRINSIC — seeded into every
 *  registry from `@chartwarden/auth` (`M3_INTRINSIC_PREDICATES`), beside provider_entity_scope /
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
  registerPredicateIdempotent(
    M3_STEP_UP_PREDICATE,
    async (context: AbacContext, target: AbacTarget) => {
      // AC-03 — the per-operation tightening is ON the live path. `requireStepUp(opKey)` puts the
      // operation key in the target, M2 resolves `tenant_step_up_policy_override` for it, and the
      // result is the floor INTERSECTED/MIN'd with the tenant's row. An unkeyed call resolves the
      // floor. The resolution itself lives in `stepUpFreshFor` (bootstrap/step-up.ts) so that this
      // predicate and the routes that need the same answer as a BOOLEAN (for a pure domain guard,
      // where a preHandler cannot express it) cannot drift apart — F-028, which found three routes
      // answering it from a client-supplied `x-step-up` header instead.
      return stepUpFreshFor(
        {
          organizationId: context.organizationId,
          sessionId:
            typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null,
          operationKey:
            typeof target.operationKey === "string" ? target.operationKey : M3_STEP_UP_FLOOR_KEY,
        },
        now,
      );
    },
  );
}
