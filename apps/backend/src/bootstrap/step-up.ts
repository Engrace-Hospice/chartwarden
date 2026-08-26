// apps/backend/src/bootstrap/step-up.ts — the ONE server-side step-up freshness resolution (F-028).
//
// Three call shapes needed the same answer — "does this request carry a fresh, qualifying step-up?" —
// and three different mechanisms had grown to answer it:
//
//   1. `requireStepUp(opKey)` → M3's `step_up_recent` ABAC predicate → M2's `SessionContextResolver`
//      seam → the pure `isStepUpRecent` decision. Server-verified. CORRECT, and the one 8 modules use.
//   2. A service-level resolve through the same seam (M8 `resolveSignatureProvenance`, M14's
//      `per_patient_review_floor_clear` predicate). Server-verified. CORRECT.
//   3. `request.headers["x-step-up"] === "fresh"` (M14 adjourn, M17 visit start, M18 correct +
//      supervisor-override). A CLIENT-SUPPLIED STRING. Any authenticated caller who could reach the
//      route could satisfy the step-up requirement by typing the header — the ceremony was optional
//      for anyone who knew it existed. The M14 §4.7 predicate's own comment already called this out
//      as "a DIFFERENT, pre-existing shortcut this fix does not repeat"; F-028 removes it.
//
// Shapes 1 and 2 answer the same question and must not drift, so the decision lives HERE and both go
// through it: M3's predicate delegates to `stepUpFreshFor`, and a route that needs the boolean for a
// pure-domain guard (rather than a preHandler) calls `requestStepUpFresh`.
//
// Fail-closed at every branch: no session id, no org, no seam, a missing/stale/non-qualifying
// step-up, or a seam that throws all resolve to `false`. A route that needs the request REFUSED
// (rather than a boolean to hand a domain machine) mounts `requireStepUp(opKey)` as a preHandler,
// which fails closed the same way but as a 403.
import { isStepUpRecent } from "@wardenx/auth";
import { STEP_UP_POLICY } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { getSeam } from "./seams/registry";

/**
 * The operation key used when a caller gates on step-up freshness WITHOUT naming an operation.
 * No tenant row can carry this key (`tenant_step_up_policy_override.operation_key` is written by the
 * tenant's own configuration), so it resolves to the platform floor — the correct reading of an
 * unnamed operation: unconfigurable, therefore un-tightenable, therefore the floor.
 *
 * Re-exported by M3 as `M3_STEP_UP_FLOOR_KEY`, which is the name the spec (§4.2.1) uses.
 */
export const STEP_UP_FLOOR_KEY = "__unspecified__";

/**
 * Resolve the step-up state of one session against the effective policy for one operation.
 *
 * The effective policy is the platform floor `STEP_UP_POLICY` TIGHTENED by the tenant's
 * `tenant_step_up_policy_override` row (§4.3.2, D9) — resolved through M2's seam, never read off the
 * M1-owned `session` table directly. `isStepUpRecent` (packages/auth) is the pure decision; the
 * lockout knobs come from the floor unchanged because they are not per-operation.
 */
export async function stepUpFreshFor(
  input: {
    readonly organizationId: string | null | undefined;
    readonly sessionId: string | null | undefined;
    readonly operationKey?: string;
  },
  now: () => number = () => Date.now(),
): Promise<boolean> {
  const { organizationId, sessionId } = input;
  if (!sessionId || !organizationId) return false; // fail-closed
  const scope = { orgId: organizationId };
  const operationKey = input.operationKey ?? STEP_UP_FLOOR_KEY;
  try {
    const resolver = getSeam("SessionContextResolver");
    const [state, policy] = await Promise.all([
      resolver.resolveStepUpState(scope, sessionId),
      resolver.resolveStepUpPolicy(scope, operationKey),
    ]);
    return isStepUpRecent(
      state,
      {
        ...STEP_UP_POLICY,
        qualifyingFactors: policy.qualifyingFactors,
        defaultMaxAgeSec: policy.maxAgeSec,
      },
      now(),
    );
  } catch {
    // An unregistered seam / a resolver failure is not evidence of a fresh step-up. Deny.
    return false;
  }
}

/**
 * The route-side form: resolve step-up freshness for the CURRENT request from the server-assembled
 * `request.context` (the org binding and the real Better Auth session id the authenticate hook
 * stamps) — never from anything the caller sends.
 *
 * Use this when the boolean feeds a pure domain guard that has its own error vocabulary
 * (`transitionMeeting`'s `STEP_UP_REQUIRED`, `transitionMissingResolution`, `assertStepUp`). When the
 * route should simply refuse, mount `requireStepUp(opKey)` as a preHandler instead.
 */
export async function requestStepUpFresh(
  request: FastifyRequest,
  operationKey: string,
): Promise<boolean> {
  const ctx = request.context;
  const sessionId =
    typeof ctx?.attributes?.sessionId === "string" ? ctx.attributes.sessionId : null;
  return stepUpFreshFor({ organizationId: ctx?.organizationId ?? null, sessionId, operationKey });
}
