// @wardenx/auth · abac — the named-predicate registry (M3 — Authorization, M3-T07; spec §4.2).
//
// `require-abac.ts` (M3-T05) ships `requireAbac(action, predicate)` as the contract: it
// assembles the server-side `AbacContext`, extracts the target, and dispatches to the
// injected `AbacEvaluator` seam — whose fail-closed default denies (§2.2: "a missing
// predicate is a bug, not an allow"). THIS file is the real evaluator that seam points at:
// a registry of NAMED predicates (`(context, target) => boolean`, code — **not** a generic
// rules engine, §4.2) that every later module registers its predicates into BY NAME. It is
// the single seam the whole platform's `requireAbac` calls resolve through.
//
// Two registration audiences (§4.2 / §4.2.1):
//   • M3-intrinsic predicates — computable from the server-assembled `AbacContext` + target
//     alone (provider-entity / location scope): seeded here so they are live the moment the
//     registry is installed.
//   • Cross-module predicates — `caseload_membership`, `oncall_shift_active`,
//     `engagement_scope`, … — depend on data owned by NON-dependency modules (§4.2.1). Each
//     owning module registers its predicate by name through `registerPredicate(...)`,
//     closing over its own boot-registered provider seam (deny-stub default → fail closed).
//     M3 never reads those modules' tables; it only resolves the named predicate.
//
// DENY BY DEFAULT: an unregistered predicate name resolves to `false` (never throws — a
// throw would surface as 500; the contract turns `false` into the correct 403/404). Predicate
// names are single-owner: re-registering a name throws, to catch a double-wire bug at boot.
import {
  type AbacContext,
  type AbacEvaluator,
  type AbacTarget,
  resetAbacEvaluator,
  setAbacEvaluator,
} from "./require-abac";

/**
 * A named ABAC predicate (§4.2): a pure-ish decision over the SERVER-assembled context and
 * the request target. May be async so a cross-module predicate can await its provider seam.
 * Never receives client input directly — `requireAbac` assembles `context` from session + DB.
 */
export type AbacPredicate = (
  context: AbacContext,
  target: AbacTarget,
) => boolean | Promise<boolean>;

/**
 * The registry every module registers its predicates into by name (the seam every later
 * module relies on for `requireAbac`). `evaluate` is the `AbacEvaluator` the contract's
 * seam is set to; it dispatches by name and fails closed on an unknown predicate.
 */
export interface PredicateRegistry {
  /** Register a predicate under `name`. Throws if `name` is already registered (single-owner). */
  register(name: string, predicate: AbacPredicate): void;
  /** Whether a predicate is registered under `name`. */
  has(name: string): boolean;
  /** The registered predicate names (for diagnostics / a "no unresolved consumer" audit). */
  names(): readonly string[];
  /** The fail-closed evaluator to install via `setAbacEvaluator` (deny on unknown name). */
  readonly evaluate: AbacEvaluator;
}

/** Coerce an unknown target field to a string id, or `null` when absent/ill-typed. */
function targetId(target: AbacTarget, field: string): string | null {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `provider_entity_scope` (§4.2): the target's ProviderEntity is within the actor's PE scope.
 * Context-only — the actor's PE scope rides on the assembled `AbacContext.providerEntityIds`
 * (membership/role scope); the target names its `providerEntityId`. Fail closed: a target
 * with no PE, or a PE outside the actor's scope, denies.
 */
export const providerEntityScope: AbacPredicate = (context, target) => {
  const pe = targetId(target, "providerEntityId");
  return pe !== null && context.providerEntityIds.includes(pe);
};

/**
 * `location_scope` (§4.2): the target's Location is within the actor's location scope.
 * Context-only — the actor's location scope rides on `AbacContext.locationIds`; the target
 * names its `locationId`. Fail closed on a missing or out-of-scope location.
 */
export const locationScope: AbacPredicate = (context, target) => {
  const location = targetId(target, "locationId");
  return location !== null && context.locationIds.includes(location);
};

/**
 * `inOrg` (§4.2): the M3-BASE org-scoping predicate every org-scoped route composes its own predicate
 * on top of.
 *
 * WHAT IT ASSERTS — the request is org-scoped at all: the actor is acting inside a resolved
 * organization, and where the target NAMES an organization it is the same one. That is the precondition
 * an ownership/visibility/discipline predicate needs before it can mean anything.
 *
 * WHAT IT IS NOT — row-level tenancy enforcement. `defaultTarget` hands `requireAbac` the route's PARAMS,
 * so on a COLLECTION route the target is `{}`: there is no row yet to compare against, and this returns
 * true. Postgres RLS (`organization_id = current_setting('app.org_id')`) is what keeps one tenant's rows
 * from another, on every read, proven live per module in
 * `packages/db/migrations/__tests__/*.live.test.ts`. Reading `inOrg` as "this route is tenant-safe" would
 * under-protect a new route: it is the cheap precondition, RLS is the control.
 *
 * It is an INTRINSIC (seeded) predicate rather than a module registration because modules already
 * compose on it as given — M30's own files call it "the M3-base `inOrg` predicate" — and a registry that
 * fails closed on unknown names turns a missing base predicate into an endpoint no one can reach.
 *
 * Fail closed: no resolved org denies; a target naming a DIFFERENT org denies (which catches a handler
 * threading an org id in from a body or path instead of the session).
 */
export const inOrg: AbacPredicate = (context, target) => {
  if (!context.organizationId) return false;
  const targetOrg = targetId(target, "organizationId") ?? targetId(target, "orgId");
  if (targetOrg !== null) return targetOrg === context.organizationId;
  return true;
};

/**
 * The predicates M3 owns outright — evaluable from the server-assembled context + target
 * with no cross-module seam. Seeded into the default registry so they are live on install.
 * Cross-module predicates (§4.2.1) are added by their owning modules via `registerPredicate`.
 */
export const M3_INTRINSIC_PREDICATES: Readonly<Record<string, AbacPredicate>> = {
  inOrg,
  provider_entity_scope: providerEntityScope,
  location_scope: locationScope,
};

/**
 * Build a predicate registry, optionally seeded with predicates by name (defaults to M3's
 * intrinsic predicates). Use a fresh registry per test for isolation; boot uses the shared
 * `abacRegistry` below.
 */
export function createPredicateRegistry(
  seed: Readonly<Record<string, AbacPredicate>> = M3_INTRINSIC_PREDICATES,
): PredicateRegistry {
  const predicates = new Map<string, AbacPredicate>();

  const register = (name: string, predicate: AbacPredicate): void => {
    if (predicates.has(name)) {
      throw new Error(`ABAC predicate '${name}' is already registered (single-owner per §4.2)`);
    }
    predicates.set(name, predicate);
  };

  for (const [name, predicate] of Object.entries(seed)) register(name, predicate);

  return {
    register,
    has: (name) => predicates.has(name),
    names: () => [...predicates.keys()],
    // Fail closed: an unregistered name denies (returns false), never throws (§2.2).
    evaluate: (predicate, context, target) => {
      const fn = predicates.get(predicate);
      return fn ? fn(context, target) : false;
    },
  };
}

/**
 * The shared registry the platform registers predicates into. A later module registers its
 * cross-module predicate by name once at boot, e.g.
 *   `registerPredicate('caseload_membership', (ctx, t) => caseloadProvider.covers(ctx, t))`.
 * Pre-seeded with M3's intrinsic predicates.
 */
export const abacRegistry: PredicateRegistry = createPredicateRegistry();

/** Register a predicate into the shared registry by name (the cross-module seam, §4.2.1). */
export function registerPredicate(name: string, predicate: AbacPredicate): void {
  abacRegistry.register(name, predicate);
}

/**
 * Boot wiring: install a registry as the Authorization Contract's `AbacEvaluator`, flipping
 * `requireAbac` from its fail-closed default to real named-predicate resolution. Defaults to
 * the shared `abacRegistry`. Mirrors `registerEffectivePermissionResolver` (M3-T06). Returns
 * the registry so the caller can keep registering predicates after install.
 */
export function registerAbacRegistry(
  registry: PredicateRegistry = abacRegistry,
): PredicateRegistry {
  setAbacEvaluator(registry.evaluate);
  return registry;
}

/** Restore the contract's fail-closed default evaluator (boot reset / test isolation). */
export function resetAbacRegistry(): void {
  resetAbacEvaluator();
}
