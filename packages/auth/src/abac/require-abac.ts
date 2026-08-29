// @wardenx/auth · abac — the `requireAbac` half of the Authorization Contract (M3-T05).
//
// Spec §4.1 (the middleware every module consumes) + §2.2 (the resolution pipeline's ABAC
// step and the break-glass branch). `requireAbac(action, predicate)` is a preHandler
// factory that evaluates a NAMED, server-side predicate against server-assembled context.
//
// DENY BY DEFAULT (§2.2): "No explicit ABAC binding for a PHI action → treated as deny (a
// missing predicate is a bug, not an allow)." The named-predicate REGISTRY itself (the 14
// predicates + the `AbacContext` assembly from DB) is M3-T07; this contract consumes it
// through the injected `AbacEvaluator` seam, whose fail-closed default returns `false`, so
// an unregistered predicate denies. The break-glass branch and its critical-audit hook are
// likewise injected seams (the real break-glass machinery is M3-T08), so until they are
// registered the branch never opens and access stays denied.
import {
  ForbiddenError,
  type HttpRequestContext,
  NotFoundError,
  StepUpRequiredError,
  UnauthorizedError,
} from "@wardenx/types";
import {
  type GuardHandler,
  type GuardRequest,
  resetEffectivePermissionResolver,
} from "../rbac/require-role";

/**
 * The server-assembled context an ABAC predicate evaluates against (§4.2 — "context is
 * server-controlled ... never client input"). M3-T07 enriches predicate evaluation with
 * DB-derived facts; this is the request-derived core every predicate can rely on.
 */
export interface AbacContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly providerEntityIds: readonly string[];
  readonly locationIds: readonly string[];
  readonly attributes: Record<string, unknown>;
}

/** The object a predicate is evaluated against (e.g. the target patient/resource ids). */
export type AbacTarget = Record<string, unknown>;

function abacContextFrom(ctx: HttpRequestContext): AbacContext {
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    providerEntityIds: ctx.providerEntityIds,
    locationIds: ctx.locationIds,
    attributes: ctx.attributes,
  };
}

/**
 * Resolves a named predicate and evaluates it against server context + target (§4.2).
 * Registered by M3-T07's predicate registry; the default denies (fail closed) so a route
 * naming an unregistered predicate is refused rather than allowed.
 */
export type AbacEvaluator = (
  predicate: string,
  context: AbacContext,
  target: AbacTarget,
) => Promise<boolean> | boolean;

const DENY_ALL_EVALUATOR: AbacEvaluator = () => false;
let abacEvaluator: AbacEvaluator = DENY_ALL_EVALUATOR;

/** M3-T07 registers the named-predicate registry as the evaluator at boot. */
export function setAbacEvaluator(evaluator: AbacEvaluator): void {
  abacEvaluator = evaluator;
}

/** Restore the fail-closed default (boot reset / tests). */
export function resetAbacEvaluator(): void {
  abacEvaluator = DENY_ALL_EVALUATOR;
}

/** A temporary break-glass grant covering `target` for `action` (§2.2 break-glass branch). */
export interface BreakGlassGrant {
  readonly eventId: string;
}

/**
 * Checks whether an active break-glass event grants the actor bypass for this target
 * (§2.2 "break-glass active for this target?"). Registered by M3-T08; the default returns
 * `null` (no grant), so the branch stays closed until break-glass machinery is wired.
 */
export type BreakGlassChecker = (
  context: AbacContext,
  action: string,
  target: AbacTarget,
) => Promise<BreakGlassGrant | null> | BreakGlassGrant | null;

const NO_BREAK_GLASS: BreakGlassChecker = () => null;
let breakGlassChecker: BreakGlassChecker = NO_BREAK_GLASS;

/** M3-T08 registers the break-glass resolver. */
export function setBreakGlassChecker(checker: BreakGlassChecker): void {
  breakGlassChecker = checker;
}

/** Restore the fail-closed default (boot reset / tests). */
export function resetBreakGlassChecker(): void {
  breakGlassChecker = NO_BREAK_GLASS;
}

/** The access event handed to the critical-audit hook when the break-glass branch opens. */
export interface BreakGlassAccess {
  readonly grant: BreakGlassGrant;
  readonly action: string;
  readonly context: AbacContext;
  readonly target: AbacTarget;
}

/**
 * Invoked when access is allowed UNDER GLASS — §2.2 mandates "every such access is
 * individually audited at `critical`". The real `audit()` call (M4) is wired by M3-T08/T10;
 * the default is a no-op so the contract compiles before audit lands.
 */
export type BreakGlassAuditHook = (access: BreakGlassAccess) => Promise<void> | void;

const NOOP_AUDIT: BreakGlassAuditHook = () => {};
let breakGlassAuditHook: BreakGlassAuditHook = NOOP_AUDIT;

/** M3-T08/T10 registers the critical-audit hook. */
export function setBreakGlassAuditHook(hook: BreakGlassAuditHook): void {
  breakGlassAuditHook = hook;
}

/** Restore the no-op default (boot reset / tests). */
export function resetBreakGlassAuditHook(): void {
  breakGlassAuditHook = NOOP_AUDIT;
}

/** The break-glass id flagged onto the request so the handler's audit records it (§4.4). */
export const BREAK_GLASS_ATTRIBUTE = "breakGlassEventId";

export interface RequireAbacOptions {
  /** Extract the predicate target from the request (default: `request.params`). */
  readonly getTarget?: (request: GuardRequest) => AbacTarget;
  /**
   * Return 404 instead of 403 on denial — the §2.2 existence non-leak rule, for
   * object-level checks where a 403 would reveal a resource the actor may not know exists.
   */
  readonly notFoundOnDeny?: boolean;
  /**
   * Whether an active §2.2 break-glass grant may satisfy this guard. Defaults to `true` (the
   * emergency-access contract). Set `false` for gates a grant must NOT stand in for — the
   * step-up ceremonies, where break-glass proves emergency but not the live second factor the
   * ceremony exists to demand. See `requireStepUp`.
   */
  readonly breakGlassBypassable?: boolean;
  /**
   * Deny with `403 STEP_UP_REQUIRED` rather than `403 FORBIDDEN` (F-084). Set by
   * {@link requireStepUp} and by nothing else: the two refusals carry opposite remedies, and a
   * caller who cannot re-authenticate their way past a gate must never be told to try.
   */
  readonly stepUpOnDeny?: boolean;
}

function defaultTarget(request: GuardRequest): AbacTarget {
  const params = request.params;
  return params && typeof params === "object" ? (params as AbacTarget) : {};
}

/**
 * ABAC gate (§4.1, §2.2). Evaluates the named `predicate` against server context; on
 * `true` the request proceeds. On `false` the §2.2 break-glass branch is consulted: an
 * active grant flags the request, fires the critical-audit hook, and allows; otherwise the
 * request is denied (403, or 404 under the existence non-leak rule). Deny by default.
 */
export function requireAbac(
  action: string,
  predicate: string,
  options: RequireAbacOptions = {},
): GuardHandler {
  const getTarget = options.getTarget ?? defaultTarget;
  return async (request) => {
    const ctx = request.context;
    if (!ctx?.organizationId) throw new UnauthorizedError();

    const abacContext = abacContextFrom(ctx);
    const target = getTarget(request);

    if (await abacEvaluator(predicate, abacContext, target)) return; // predicate true → allow

    // predicate false → break-glass branch (§2.2): allow + flag + audit critical if active.
    // audit C2 — unless the guard opts out. Break-glass is proof of EMERGENCY; it is not proof of
    // PRESENCE. Because `requireStepUp` is itself a `requireAbac`, an active grant used to satisfy
    // every step-up ceremony in the org — including `support_session.elevate_phi_read` and the
    // device-attestation gate on bulk PHI export, i.e. the ceremonies that exist precisely to
    // require a second, live human factor. A grant cannot substitute for one.
    if (options.breakGlassBypassable !== false) {
      const grant = await breakGlassChecker(abacContext, action, target);
      if (grant) {
        ctx.attributes[BREAK_GLASS_ATTRIBUTE] = grant.eventId;
        await breakGlassAuditHook({ grant, action, context: abacContext, target });
        return;
      }
    }

    if (options.notFoundOnDeny) throw new NotFoundError("resource");
    if (options.stepUpOnDeny) {
      // No predicate name in the message: this one is rendered to a clinician mid-ceremony, and
      // `abac predicate 'step_up_recent' denied` is not what they need to read. Every other denial
      // keeps the diagnostic text — those are read by whoever is debugging a guard.
      throw new StepUpRequiredError();
    }
    throw new ForbiddenError(`abac predicate '${predicate}' denied for '${action}'`);
  };
}

/**
 * Step-up gate (§4.2.1, M03-F01): the route-binding form `requireStepUp(opKey)` is a thin
 * `requireAbac` over the `step_up_recent` predicate, carrying the operation key as the
 * target so M3-T07's predicate can resolve the per-operation freshness policy.
 */
export function requireStepUp(operationKey: string): GuardHandler {
  return requireAbac(operationKey, "step_up_recent", {
    getTarget: () => ({ operationKey }),
    // F-084 — a step-up refusal is not a permission refusal. Five modules' `authFailureRedirect`
    // helpers have branched on this code since before it could be emitted.
    stepUpOnDeny: true,
    // audit C2 — a step-up ceremony is never satisfiable by an emergency grant. See the
    // break-glass branch in `requireAbac`: this is the one guard that opts out of it.
    breakGlassBypassable: false,
  });
}

/**
 * Restore the whole contract to its fail-closed defaults (RBAC resolver + ABAC evaluator +
 * break-glass checker + audit hook). For test isolation and a clean boot baseline before
 * M3-T06/T07/T08 register the real implementations.
 */
export function resetAuthorizationContract(): void {
  resetEffectivePermissionResolver();
  resetAbacEvaluator();
  resetBreakGlassChecker();
  resetBreakGlassAuditHook();
}
