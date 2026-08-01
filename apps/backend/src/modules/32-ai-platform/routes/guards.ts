// apps/backend/src/modules/32-ai-platform/routes/guards.ts — M32-T07 (§4.1 / §4.7) route-guard builders.
//
// The shared `requirePermission` / `requireAbac` / `requireStepUp` preHandler factories every M32 route
// plugin composes (the M15/M16/M19/M20/M21/M23/M24/M26 routes/guards.ts precedent). Every §4.7 predicate
// resolves its subject facts server-side from the route's PATH PARAM or the SESSION — never from a
// caller-supplied org or actor claim.
//
// FOUR COMPOSITION RULES §4.1'S TABLE FORCES:
//
//   1. A `∨` CELL IS **ONE** PREHANDLER, NOT TWO. §4.1 spells four cells as disjunctions
//      (R7/R8's "`ai_safety_owner` (platform) or `tenant_admin` (tenant-scoped)", R9's and R16's
//      "`ai_safety_owner` or `compliance_officer`"). Two `requireAbac` preHandlers would AND — the
//      M16-T06 finding — and ANDing `ai_safety_owner` with an org-scoped arm denies the platform
//      operator, who is by definition acting outside the row's org. {@link ABAC_ANY} evaluates the named
//      predicates in order through M3's registry and passes on the FIRST that allows, with each name a
//      compile-time literal so `arch:abac-predicates` still sees it.
//   2. `notFoundOnDeny` IS ON FOR THE INVOCATION ROW AND OFF FOR EVERYTHING ELSE. An `ai_invocation` id
//      is 1:1 with "this named patient's chart went to a model vendor at this hour" (§3.2.8), which §8.2's
//      isolation test asks to be unprobeable — so a denied R17 answers 404. A CAPABILITY, a KILL SWITCH,
//      an EVALUATION RUN and a PROMPT TEMPLATE are all platform-shared reference data that §6 grants
//      every clinical role read on; "not yours" discloses nothing there and "403" is the answer an
//      operator actually needs.
//   3. THE GUARD IS NOT THE ONLY GATE. §2.2's transition table, §5.3.1's acknowledgment gate, D10's
//      evidence check and §3.2.12's already-active refusal all re-run INSIDE the service. A request that
//      slipped past a guard on a grant revoked between preHandler and commit still cannot transition a
//      capability. The guard is the cheap early refusal; the rule is the authority.
//   4. STEP-UP IS COMPOSED WHERE `../permission-keys.ts` SAYS AND NOWHERE ELSE
//      ({@link M32_STEP_UP_PERMISSION_KEYS}, asserted by the §10 test).
//
// ── THE TWO PREDICATES §4.7 DECLARES THAT NO ROUTE BINDS ────────────────────────────────────────────
//
// `ai_capability_clinician_opted_out` (polarity: TRUE means opted OUT) and `ai_prohibited_zone_respected`
// (a BOOT validator) are registered by ../abac-predicates.ts and bound by nothing here. That file's header
// states why binding either at a route would be an inversion or a category error. Nothing in this file
// should grow a builder for them without reading it.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { PreHandler } from "./actor";

type TargetRequest = { readonly params?: unknown; readonly body?: unknown; readonly query?: unknown };

const param = (request: TargetRequest, key: string): string =>
  (request.params as Record<string, string> | undefined)?.[key] ?? "";

const bodyStr = (request: TargetRequest, key: string): string =>
  typeof (request.body as Record<string, unknown> | undefined)?.[key] === "string"
    ? ((request.body as Record<string, string>)[key] as string)
    : "";

/** RBAC gate — `requirePermission(key)` from M3 (the §4.6 key catalog M32 contributes). */
export const P = (key: string): PreHandler => requirePermission(key) as PreHandler;

/** §4.1 — `requireStepUp(operationKey)` over the M3 `step_up_recent` predicate (rule 4). */
export const STEP_UP = (operationKey: string): PreHandler => requireStepUp(operationKey) as PreHandler;

/**
 * Rule 1 — the §4.1 `∨` cell as ONE preHandler.
 *
 * Takes ALREADY-BUILT guards and runs them in order until one passes. A guard signals denial by throwing,
 * so "passed" is "did not throw"; the LAST failure is re-thrown when every arm refuses, which keeps the
 * 403-vs-404 shape of the last-listed arm. `notFoundOnDeny` is therefore kept uniform across the arms of
 * a single cell — mixing them would make the status code depend on which arm happened to be evaluated
 * last.
 *
 * IT TAKES GUARDS, NOT PREDICATE NAMES, AND THAT SIGNATURE IS THE POINT. A version that took
 * `names: string[]` and called `requireAbac(action, name, …)` in a loop compiles, runs and denies exactly
 * the same — and makes every name INVISIBLE to `arch:abac-predicates`, which scans for the literal second
 * argument of a `requireAbac` call. That gate exists because M30 shipped 15 guards on a predicate nothing
 * registered and no other check noticed.
 */
export function ABAC_ANY(...guards: readonly PreHandler[]): PreHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let lastError: unknown;
    for (const guard of guards) {
      try {
        await guard(request, reply);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
}

/**
 * §4.1's baseline cell — `wardenx.organization.member`, which IS M3's intrinsic `inOrg`.
 *
 * Bound explicitly rather than left bare so "this route is org-scoped" is a DECLARED fact the §10 test can
 * assert instead of an absence. M32 registers no second name for it (../abac-predicates.ts states the
 * decision; the M20 rule-5 precedent).
 */
export const ABAC_IN_ORG = (action: string): PreHandler =>
  requireAbac(action, "inOrg", { getTarget: () => ({}), notFoundOnDeny: false }) as PreHandler;

/** §4.1 R1, R4, R5, R6, R19, R20, R26-R32 — the cross-tenant AI Safety Owner (§4.7). */
export const ABAC_SAFETY_OWNER = (action: string): PreHandler =>
  requireAbac(action, "ai_safety_owner", {
    getTarget: () => ({}),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * §4.1 R9 — the kill-switch dashboard: `ai_safety_owner ∨ compliance_officer`.
 *
 * The second arm is `inOrg` and NOT a role predicate, which reads odd until you remember §4.6: the
 * `ai.kill_switch.read` key is granted to `compliance_officer` and `tenant_admin` and to nobody else, so
 * "holds the key AND is in this org" IS the compliance-officer arm. Registering a second role-shaped
 * predicate would be a copy of the grant table (../abac-predicates.ts's header).
 */
export const ABAC_SAFETY_OWNER_OR_IN_ORG = (action: string): PreHandler =>
  ABAC_ANY(ABAC_SAFETY_OWNER(action), ABAC_IN_ORG(action));

/**
 * §4.1 R7/R8 — the kill switch: `ai_safety_owner` (platform scope) ∨ `tenant_admin` (tenant scope).
 *
 * THE ARMS ARE NOT INTERCHANGEABLE AND THE ORDER IS LOAD-BEARING. A `platform`-scoped request writes the
 * `organization_id IS NULL` row that stops EVERY agency, so only the safety-owner arm may satisfy it —
 * which is why the tenant arm is skipped entirely when the body says `platform`, rather than being ORed
 * and left to pass on `inOrg`. A tenant admin who sent `scope: 'platform'` would otherwise stop a
 * capability for every other agency on the deployment by holding a key §4.6 grants them for their own.
 */
export const ABAC_KILL_SWITCH_SCOPE = (action: string): PreHandler => {
  const safetyOwner = ABAC_SAFETY_OWNER(action);
  const inOrg = ABAC_IN_ORG(action);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = bodyStr(request as TargetRequest, "scope") || "tenant";
    if (scope === "platform") {
      await safetyOwner(request, reply);
      return;
    }
    await ABAC_ANY(safetyOwner, inOrg)(request, reply);
  };
};

/**
 * §4.1 R17 — one invocation: `ai_invocation_same_org_or_safety_owner`, 404 on deny (rule 2).
 *
 * The predicate itself already ORs the safety owner in (§4.7's own definition), so this is a single
 * `requireAbac` and NOT an {@link ABAC_ANY} — the disjunction lives inside the predicate, where the
 * cross-tenant read that satisfies it can be made once against the row rather than twice against a guard.
 */
export const ABAC_INVOCATION_ROW = (action: string, idParam = "invocationId"): PreHandler =>
  requireAbac(action, "ai_invocation_same_org_or_safety_owner", {
    getTarget: (r) => ({ invocationId: param(r as TargetRequest, idParam) }),
    notFoundOnDeny: true,
  }) as PreHandler;

/**
 * §4.1 R16 — the compliance search: `ai_safety_owner ∨ compliance_officer`.
 *
 * A COLLECTION route, so `notFoundOnDeny` is off (rule 2 applies to the per-row R17). The row-level
 * boundary is the read service's `withOrgContext` + RLS, and the PHI masking is `actor.phiFullRead` —
 * neither is a guard's job.
 */
export const ABAC_INVOCATION_SEARCH = (action: string): PreHandler =>
  ABAC_SAFETY_OWNER_OR_IN_ORG(action);

/**
 * §4.1 R10 — the tenant opt-in write, gated on `ai_capability_tenant_opted_in`? NO. Read the note.
 *
 * `ai_capability_tenant_opted_in` answers "is this org ALREADY opted in", which is the SDK's gate and the
 * exact inverse of what R10 needs: binding it would refuse the first opt-in and permit only re-submissions.
 * R10's real gate is §4.6's `ai.tenant_opt_in` key (granted to `tenant_admin` alone) plus `inOrg`, and the
 * ACKNOWLEDGMENT evidence W4.1 checks inside the service. This builder exists so that decision is a named,
 * greppable thing rather than an `ABAC_IN_ORG` call somebody later "fixes".
 */
export const ABAC_TENANT_CONSENT = (action: string): PreHandler => ABAC_IN_ORG(action);

/**
 * The §4.7 `ai_capability_tenant_opted_in` binding, for the ONE surface that genuinely asks the question.
 *
 * Not bound by any §4.1 route in Phase 1 — the SDK gate (`resolveAiGovernanceGate`) answers it in-process
 * on the invocation path. Exported so a Phase-2 route that needs "may this org use this capability right
 * now" binds the registered predicate by name instead of re-deriving it, and so the name stays visible to
 * `arch:abac-predicates` as something a route can reach.
 */
export const ABAC_TENANT_OPTED_IN = (action: string, capabilityParam = "capabilityId"): PreHandler =>
  requireAbac(action, "ai_capability_tenant_opted_in", {
    getTarget: (r) => ({ capabilityId: param(r as TargetRequest, capabilityParam) }),
    notFoundOnDeny: false,
  }) as PreHandler;

/**
 * The §4.7 `ai_kill_switch_inactive` binding, likewise reserved for the invocation path.
 *
 * A §4.1 ADMIN route must NOT bind this: R7/R8/R9 are how an operator manages the switch, and gating them
 * on the switch being inactive would make an active kill switch unliftable — the platform's stop button
 * with no release.
 */
export const ABAC_KILL_SWITCH_INACTIVE = (
  action: string,
  capabilityParam = "capabilityId",
): PreHandler =>
  requireAbac(action, "ai_kill_switch_inactive", {
    getTarget: (r) => ({ capabilityId: param(r as TargetRequest, capabilityParam) }),
    notFoundOnDeny: false,
  }) as PreHandler;
