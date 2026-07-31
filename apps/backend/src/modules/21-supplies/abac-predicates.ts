// apps/backend/src/modules/21-supplies/abac-predicates.ts — M21-T05 (§4.4).
//
// The TWO named ABAC predicate resolvers M21 registers into M3's named-predicate registry (M3 §3.4). Each
// is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes; the subject facts are
// never read off the request body — they load through the injected {@link SuppliesAbacResolver} (org-scoped,
// RLS-backstopped, fail-CLOSED when absent / cross-tenant).
//
//   controlled_substance_dispatcher_eligible — §4.4: the subject must (a) hold an active credential
//        designating controlled-substance handling authority for the tenant, (b) not be suspended, and
//        (c) belong to the same Location as the patient's serving Location, or hold a cross-location
//        designation. Bound on `comfort_kit.dispatch.create` unconditionally, and on
//        `supplies.request.create` ONLY for `kind = 'comfort_kit_deploy'` (§4.1's conditional cell).
//   comfort_kit_return_reconciler_eligible  — §4.4: the subject must (a) be a DIFFERENT user from the
//        dispatcher of the originating dispatch (separation of duties), (b) hold reconciliation authority,
//        and (c) — when the kit held a controlled substance — have an active witness recorded on the return
//        row. Bound on `comfort_kit.return.reconcile` and on the 90-day unreturnable disposition.
//
// WHY THE AUTHORITY IS DERIVED FROM M3 ROLE GRANTS. §4.4 phrases (a) as "an active credential designating
// controlled-substance handling authority", but the platform has no credential store that carries such a
// designation: M40's `MdmEntityProvider` is master data about physicians / facilities / payers / vendors,
// not about staff, and the M2 `membership` row carries no credential column. The one place the platform
// already models a delegated authority is M3's `RoleGrant.roleKey` (M3's own doc-comment names it the
// discipline-derivation input), so that is what M21 reads, through the M3-owned `EffectivePermissionStore`
// PORT rather than by importing M3's `role` / `membership_role` schema. The same read answers (b): a
// suspension is the ABSENCE of an enabled grant, which is the only suspension signal M3 actually publishes.
// A role key nobody granted resolves to an empty set, which denies.
//
// THE FAIL DIRECTION IS UNIFORM HERE, and that is deliberate — unlike M15-T05 / M16-T05, where the posture
// was per-seam or per-method. Both of these predicates guard a controlled-substance movement. An
// unreadable resolver, an unknown target, an absent row, a cross-tenant id and a thrown error ALL deny.
// There is no fact about a CII solution whose unavailability should be read as permission to move it.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import type { MembershipId } from "@wardenx/types";

/** The §4.4 predicate names M21 owns (registered into M3). Single-owner across the platform registry. */
export const M21_ABAC_PREDICATES = [
  "controlled_substance_dispatcher_eligible",
  "comfort_kit_return_reconciler_eligible",
] as const;

export type M21RegisteredAbacPredicate = (typeof M21_ABAC_PREDICATES)[number];

/**
 * §4.4(a) — the M3 role keys that evidence controlled-substance HANDLING authority (the "dispatcher"
 * side: who may put a scheduled drug into a kit and send it out). Pharmacist and supply coordinator are
 * the operational holders; the DON and the medical director hold it by office.
 */
export const CONTROLLED_SUBSTANCE_DISPATCHER_ROLES = [
  "pharmacist",
  "supply_coordinator",
  "director_of_nursing",
  "medical_director",
  "registered_nurse",
] as const;

/**
 * §4.4(b) — the RECONCILER side: who may count a kit back in and sign the DEA 1304 closing entry. A
 * registered nurse qualifies (§4.3 names `registered_nurse_witness`), as does the supply coordinator; the
 * compliance officer and DON hold it by office.
 *
 * `pharmacist` is deliberately ABSENT even though it holds dispatch authority: the pharmacy is the most
 * common dispatcher, and §4.4(a)'s separation-of-duties clause is about the SPECIFIC dispatcher of THIS
 * dispatch, not the role in general. Keeping the pharmacist out of the reconciler set is a second,
 * coarser layer of the same rule — cheap, and it fails in the safe direction.
 */
export const COMFORT_KIT_RECONCILER_ROLES = [
  "registered_nurse",
  "supply_coordinator",
  "compliance_officer",
  "director_of_nursing",
] as const;

/**
 * §4.4(c) — the roles that carry a CROSS-LOCATION controlled-substance designation: they may dispatch to a
 * patient served out of a Location they are not themselves assigned to. Without one of these the subject's
 * own Location set must contain the request's serving Location.
 *
 * This is a MODIFIER on clause (a), not a substitute for it: the designation lifts the Location constraint
 * and nothing else, so every entry here is also a {@link CONTROLLED_SUBSTANCE_DISPATCHER_ROLES} entry. A
 * role in this set but not in that one would be dead weight — it could never reach clause (c) — and the
 * §9.1 test asserts the containment so the two lists cannot drift apart. `compliance_officer` is
 * deliberately absent for exactly that reason: it is a RECONCILER role (it counts kits back in), not a
 * dispatcher one, and listing it here would read as an authority it does not have.
 */
export const CROSS_LOCATION_DISPATCH_ROLES = [
  "pharmacist",
  "director_of_nursing",
  "medical_director",
] as const;

/** The dispatch/request facts `controlled_substance_dispatcher_eligible` decides over. */
export interface SupplyDispatchAbacFacts {
  readonly organizationId: string;
  /** The `supply_request` or `comfort_kit_dispatch` id the target named. */
  readonly targetId: string;
  /** The serving Location the kit is going out of — the §4.4(c) comparison point. */
  readonly locationId: string;
  /** True when this target actually moves a scheduled drug (a `comfort_kit_*` kind / a kit dispatch). */
  readonly involvesControlledSubstance: boolean;
}

/** The return facts `comfort_kit_return_reconciler_eligible` decides over. */
export interface ComfortKitReturnAbacFacts {
  readonly organizationId: string;
  readonly returnId: string;
  readonly dispatchId: string;
  /** WHO sent the kit out — the separation-of-duties comparison point (§4.4(a)). */
  readonly dispatchedByMembershipId: MembershipId;
  /** WHO physically retrieved it; a witness may not also be the retriever (§3.1.10 CHECK). */
  readonly assignedRetrievingMembershipId: MembershipId | null;
  /** The witness recorded on the return row, if any. §4.4(c) requires one when the kit held a schedule. */
  readonly disposalWitnessMembershipId: MembershipId | null;
  /** True when ANY dispatched line on the originating dispatch was a controlled substance. */
  readonly containsControlledSubstance: boolean;
}

/** The read surface M21's ABAC predicates resolve against (Drizzle in prod; in-memory in tests). */
export interface SuppliesAbacResolver {
  /** Dispatch facts for a `comfort_kit_dispatch` id, or null when absent / cross-tenant (fail-closed). */
  loadDispatch(orgId: string, dispatchId: string): Promise<SupplyDispatchAbacFacts | null>;
  /** The same facts resolved from a `supply_request` id (the §4.1 row-1 conditional binding). */
  loadRequest(orgId: string, supplyRequestId: string): Promise<SupplyDispatchAbacFacts | null>;
  /** Return facts for a `comfort_kit_return` id, or null when absent / cross-tenant (fail-closed). */
  loadReturn(orgId: string, returnId: string): Promise<ComfortKitReturnAbacFacts | null>;
  /**
   * The enabled M3 role keys a workforce subject holds, or null when they cannot be resolved. `null`
   * DENIES — an unreadable authority is never an authorized one. See the module header for why this is
   * derived from M3 role grants rather than a credential table.
   */
  roleKeysOf(orgId: string, subjectId: string): Promise<readonly string[] | null>;
  /**
   * The Location ids a workforce subject is assigned to, or null when unresolvable. Only consulted for a
   * subject who does NOT hold a cross-location designation; `null` denies.
   */
  locationIdsOf(orgId: string, subjectId: string): Promise<readonly string[] | null>;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubSuppliesAbacResolver: SuppliesAbacResolver = {
  async loadDispatch() {
    return null;
  },
  async loadRequest() {
    return null;
  },
  async loadReturn() {
    return null;
  },
  async roleKeysOf() {
    return null;
  },
  async locationIdsOf() {
    return null;
  },
};

/** Deps for M21's §4.4 predicate resolvers. */
export interface SuppliesAbacDeps {
  readonly resolver: SuppliesAbacResolver;
}

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const targetBool = (target: AbacTarget, field: string): boolean =>
  target[field] === true || target[field] === "true";

/** The actor's ACTIVE membership id (M2 assembles it onto `attributes`); null when absent (fail-closed). */
const membershipIdOf = (context: AbacContext): string | null => {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
};

const holdsAny = (roleKeys: readonly string[], allowed: readonly string[]): boolean =>
  roleKeys.some((key) => allowed.includes(key));

/**
 * §4.4 — does this subject hold controlled-substance DISPATCH authority for this target, over facts that
 * are already resolved? Split out from the registry closure so §9.1 unit-tests the RULE with no resolver,
 * and so the §2.5 dispatch validation can ask the same question inside the transaction (a guard that
 * passed on a grant revoked two seconds ago must still be caught before the kit ships).
 */
export function decideDispatcherEligible(
  facts: SupplyDispatchAbacFacts,
  subject: {
    readonly organizationId: string;
    readonly membershipId: string | null;
    readonly roleKeys: readonly string[] | null;
    readonly locationIds: readonly string[] | null;
  },
): boolean {
  if (facts.organizationId !== subject.organizationId) return false; // defense in depth behind RLS
  if (subject.membershipId === null) return false;
  // (a) + (b): an enabled dispatcher grant. An unreadable grant set is not "no restriction".
  if (subject.roleKeys === null) return false;
  if (!holdsAny(subject.roleKeys, CONTROLLED_SUBSTANCE_DISPATCHER_ROLES)) return false;
  // (c): same Location, unless the subject holds a cross-location designation.
  if (holdsAny(subject.roleKeys, CROSS_LOCATION_DISPATCH_ROLES)) return true;
  if (subject.locationIds === null) return false;
  return subject.locationIds.includes(facts.locationId);
}

/**
 * §4.4 — may this subject reconcile this return, over already-resolved facts?
 *
 * The separation-of-duties clause compares MEMBERSHIP ids, and it is checked BEFORE the authority clause
 * on purpose: the dispatcher of a kit is usually a pharmacist or supply coordinator who WOULD pass the
 * authority test, so evaluating authority first and duties second would let the most likely violation
 * through on any future refactor that short-circuits on the first true.
 */
export function decideReconcilerEligible(
  facts: ComfortKitReturnAbacFacts,
  subject: {
    readonly organizationId: string;
    readonly membershipId: string | null;
    readonly roleKeys: readonly string[] | null;
  },
): boolean {
  if (facts.organizationId !== subject.organizationId) return false;
  if (subject.membershipId === null) return false;
  // (a) separation of duties — the sender may not also be the counter.
  if (facts.dispatchedByMembershipId === subject.membershipId) return false;
  // (b) reconciliation authority.
  if (subject.roleKeys === null) return false;
  if (!holdsAny(subject.roleKeys, COMFORT_KIT_RECONCILER_ROLES)) return false;
  // (c) a controlled kit needs a witness ON THE ROW, and that witness may not be the reconciler.
  if (!facts.containsControlledSubstance) return true;
  if (facts.disposalWitnessMembershipId === null) return false;
  if (facts.disposalWitnessMembershipId === subject.membershipId) return false;
  return facts.disposalWitnessMembershipId !== facts.assignedRetrievingMembershipId;
}

/**
 * Build M21's two §4.4 predicate resolvers over injected deps (pure factory — unit-tested against a fresh
 * registry; the boot path registers them via {@link registerSuppliesAbacPredicates}).
 */
export function buildSuppliesAbacPredicates(
  deps: SuppliesAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;

  return {
    controlled_substance_dispatcher_eligible: async (context, target) => {
      // §4.1 row 1 binds this CONDITIONALLY — only when the request kind moves a scheduled drug. The
      // route guard passes `involvesControlledSubstance` on the target for the pre-insert case (there is
      // no row to load yet); for an existing row the resolver's own answer wins.
      const dispatchId = targetStr(target, "dispatchId");
      const requestId = targetStr(target, "supplyRequestId") ?? targetStr(target, "id");
      const facts =
        dispatchId !== null
          ? await resolver.loadDispatch(context.organizationId, dispatchId)
          : requestId !== null
            ? await resolver.loadRequest(context.organizationId, requestId)
            : null;

      if (facts === null) {
        // No row yet (the create path). The guard must still bind, so decide over the target's declared
        // Location + kind. A target that declares NEITHER resolves to nothing and denies — a route that
        // forgot its `getTarget` fails closed rather than being evaluated against no subject.
        const locationId = targetStr(target, "locationId");
        if (locationId === null) return false;
        if (!targetBool(target, "involvesControlledSubstance")) return true;
        return decideDispatcherEligible(
          {
            organizationId: context.organizationId,
            targetId: requestId ?? "",
            locationId,
            involvesControlledSubstance: true,
          },
          await subjectOf(resolver, context),
        );
      }

      // An existing row that moves nothing scheduled is not gated by this predicate (§4.1's cell is
      // explicitly conditional). Returning true here is NOT a widening: RBAC already passed, and the
      // narrower gate simply does not apply to a wound-care delivery.
      if (!facts.involvesControlledSubstance) return true;
      return decideDispatcherEligible(facts, await subjectOf(resolver, context));
    },

    comfort_kit_return_reconciler_eligible: async (context, target) => {
      const returnId = targetStr(target, "returnId") ?? targetStr(target, "id");
      if (returnId === null) return false;
      const facts = await resolver.loadReturn(context.organizationId, returnId);
      if (facts === null) return false; // absent / cross-tenant / unreadable → deny
      const membershipId = membershipIdOf(context);
      return decideReconcilerEligible(facts, {
        organizationId: context.organizationId,
        membershipId,
        roleKeys: membershipId === null ? null : await roleKeysFor(resolver, context, membershipId),
      });
    },
  };
}

/**
 * Resolve the acting subject's authority facts. The role keys come from the REQUEST CONTEXT when M2 has
 * already assembled them (no DB round-trip per guarded route, and a boot-without-DB path still knows its
 * own session); the Location set always goes to the resolver, because `context.locationIds` is the
 * session's VISIBILITY scope and §4.4(c) asks about ASSIGNMENT, which is a narrower fact.
 */
async function subjectOf(
  resolver: SuppliesAbacResolver,
  context: AbacContext,
): Promise<{
  organizationId: string;
  membershipId: string | null;
  roleKeys: readonly string[] | null;
  locationIds: readonly string[] | null;
}> {
  const membershipId = membershipIdOf(context);
  if (membershipId === null) {
    return {
      organizationId: context.organizationId,
      membershipId: null,
      roleKeys: null,
      locationIds: null,
    };
  }
  return {
    organizationId: context.organizationId,
    membershipId,
    roleKeys: await roleKeysFor(resolver, context, membershipId),
    locationIds: await safeLocationIds(resolver, context.organizationId, membershipId),
  };
}

async function roleKeysFor(
  resolver: SuppliesAbacResolver,
  context: AbacContext,
  membershipId: string,
): Promise<readonly string[] | null> {
  if (context.roles.length > 0) return context.roles;
  try {
    return await resolver.roleKeysOf(context.organizationId, membershipId);
  } catch {
    return null; // fail-CLOSED — an unreadable grant set denies
  }
}

async function safeLocationIds(
  resolver: SuppliesAbacResolver,
  orgId: string,
  membershipId: string,
): Promise<readonly string[] | null> {
  try {
    return await resolver.locationIdsOf(orgId, membershipId);
  } catch {
    return null;
  }
}

/**
 * Register M21's two §4.4 ABAC predicate resolvers into M3's shared registry (M21-T05; idempotent). Call at
 * boot after the M21 route services are constructed (the resolver reads the same tables). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerSuppliesAbacPredicates(deps: SuppliesAbacDeps): void {
  const predicates = buildSuppliesAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
