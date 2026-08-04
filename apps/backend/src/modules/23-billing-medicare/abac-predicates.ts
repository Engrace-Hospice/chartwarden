// apps/backend/src/modules/23-billing-medicare/abac-predicates.ts — M23 (§4.7).
//
// The four named ABAC predicate resolvers M23 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC
// passes; M23 never authorizes by reading the request body — a resource's / actor's owner + scope facts
// are loaded through the injected {@link ReadingM23AbacResolver} (org-scoped, RLS-backstopped). The
// re-used M3 base predicate `inOrg` and the M5 `caseload_or_scope` predicate every M23 route also composes
// are owned + registered by their modules and are NOT re-registered here. The four names below are
// M23-owned (the `@wardenx/billing` `M23_ABAC_PREDICATES` catalog):
//
//   provider_entity_billing_scope      — the actor's membership is scoped to the resource's ProviderEntity
//                                        (or holds org-wide billing scope, or is a system principal for
//                                        the M25/M26 service-to-service seam calls).
//   claim_in_billing_manager_caseload  — the claim's patient is in the actor's caseload AND the claim's
//                                        ProviderEntity is in scope (both must hold for a scoped role).
//   override_role_eligible             — the actor holds the `overrideRoleRequired` role the failed
//                                        validation_result's rule demands (typed OverrideRole check, read
//                                        from the code-side rule registry — not a string match).
//   regulatory_required_rule_protected — DENIES the rule-config OVERLAY-EDITING surface when the targeted
//                                        rule is `regulatoryRequired` (D5); the per-instance override
//                                        surface is NOT denied by this predicate (fine-grained §4.5/§4.7).
//
// The REAL Drizzle fact-loader `buildDrizzleM23AbacResolver(db)` loads each fact under `withOrgContext`
// (RLS scopes every read to `app.org_id`), mirroring the M27 §4.7 resolver shape (the composition root
// binds the db handle). Every fact read is against an M23-OWNED table (claim / noe_record / notr_record /
// validation_result); the actor's provider scope comes from the SERVER-assembled `context.providerEntityIds`
// (the M40 `provider_entity_scope` source the routes already trust) and the caseload check delegates to the
// M5 `CaseloadProvider` seam (ADR-0005 D1 — seam consumption needs no dependsOn edge). The override-role +
// regulatory-protection facts come from the code-side `@wardenx/billing` DEFAULT_BILLING_RULES registry.
//
// Default-deny throughout: a missing / cross-tenant fact row, an actor with no resolvable provider scope,
// an out-of-scope provider, an unknown override role, or an un-suppliable target id all resolve to deny.
// M23 billing rows carry ids + financial facts + a patient FK (no MBI, no free-text PHI in the facts read).
//
// AI-BLOCK (D13): no `@wardenx/ai-platform` import here (the dependency-cruiser boundary enforces it); the
// per-route `actor_kind='ai_*'` reject lives at the route layer.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has` (the M27 `registerM27AbacPredicates` precedent). Never fails open.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { type BillingDb, DEFAULT_BILLING_RULES, type OverrideRole } from "@wardenx/billing";
// The Drizzle fact loader + the resolver fact types live in `./abac-resolver-drizzle` (it carries the
// central-schema import; this file names `context.roles`, so keeping the two apart clears the table-ownership
// scanner — see that file's header). Re-exported below so consumers still resolve them from this module.
import {
  type M23AbacReadContext,
  type ReadingM23AbacResolver,
  buildDrizzleM23AbacResolver,
} from "./abac-resolver-drizzle";

export {
  type BillingEntityScopeFacts,
  type M23AbacReadContext,
  type ReadingM23AbacResolver,
  type RuleConfigRuleFacts,
  type ValidationResultRuleFacts,
  buildDrizzleM23AbacResolver,
} from "./abac-resolver-drizzle";

// IMPORT-BOUNDARY NOTE (differs from M27): M23 `dependsOn = [6,8,22,38,40]` does NOT include M1, so the
// M1-owned `apps/backend/src/bootstrap` seam registry (`getSeam`) is forbidden by `module-23-boundary` (and
// `dependsOn` may not be widened). `registerPredicate` / `abacRegistry` are FINE — they live in
// `@wardenx/auth`, a foundation-helper package every module may import. The M5 `CaseloadProvider` seam is
// therefore reached NOT via `getSeam` here but through an INJECTED `isInCaseload` the composition root binds
// to `getSeam("CaseloadProvider").isInCaseload` (the app root may import bootstrap). Absent injection the
// caseload axis defaults to a fail-closed deny — boot stays green and scoped reads deny until wired.

/**
 * The §4.7 predicate names M23 OWNS and registers into M3 (four). `inOrg` (M3) and `caseload_or_scope`
 * (M5) are excluded — re-used base predicates owned + registered by their modules. Single-owner registry.
 */
export const M23_REGISTERED_ABAC_PREDICATES = [
  "provider_entity_billing_scope",
  "claim_in_billing_manager_caseload",
  "override_role_eligible",
  "regulatory_required_rule_protected",
] as const;

/** Union of the predicate names M23 registers. */
export type M23RegisteredAbacPredicate = (typeof M23_REGISTERED_ABAC_PREDICATES)[number];

// -----------------------------------------------------------------------------
// Constants the §4.7 predicates key on.
// -----------------------------------------------------------------------------

/**
 * Roles whose billing scope spans the whole organization (not a single ProviderEntity). An actor holding
 * one of these passes `provider_entity_billing_scope` for any provider in the org. Conservative floor —
 * org-administration + compliance oversight only; the per-provider `billing_manager` is NOT here (it is
 * scoped through `context.providerEntityIds`).
 */
export const ORG_WIDE_BILLING_SCOPE_ROLES: readonly string[] = [
  "org_admin",
  "compliance_officer",
] as const;

/**
 * The code-side rule registry the override-role + regulatory-protection predicates read (D5). Built ONCE
 * at module load from `@wardenx/billing` DEFAULT_BILLING_RULES — the platform-floor set is immutable, so a
 * static map is the source of truth for `overrideRoleRequired` + `regulatoryRequired` per rule key. A
 * tenant-custom (DSL-overlay) rule key absent from this map is, by construction, NOT a regulatory rule.
 */
interface RuleProtectionFacts {
  readonly regulatoryRequired: boolean;
  readonly overrideRoleRequired: OverrideRole | undefined;
}
const RULE_PROTECTION_BY_KEY: ReadonlyMap<string, RuleProtectionFacts> = new Map(
  DEFAULT_BILLING_RULES.map((rule) => [
    rule.key,
    { regulatoryRequired: rule.regulatoryRequired, overrideRoleRequired: rule.overrideRoleRequired },
  ]),
);

// -----------------------------------------------------------------------------
// The fact-loader resolver + its fact types live in `./abac-resolver-drizzle` (imported + re-exported above).
// `ReadingM23AbacDeps` + the deny-stub resolver stay here (no central-schema import).
// -----------------------------------------------------------------------------

/**
 * Deps for M23's ABAC predicate resolvers. The boot path passes a Drizzle `db` handle (the resolver reads
 * facts under RLS); unit tests may inject an in-memory `resolver` directly. Precedence: an explicit
 * `resolver` wins, else `db` builds the real Drizzle resolver, else the {@link denyStubM23AbacResolver}.
 * The caseload axis defaults to the boot-registered M5 `CaseloadProvider` seam (overridable in tests).
 */
export interface ReadingM23AbacDeps {
  /** The Drizzle handle the real resolver opens `withOrgContext` over (the composition root binds it). */
  readonly db?: BillingDb;
  /** An explicit resolver (in-memory in unit tests); overrides `db` when present. */
  readonly resolver?: ReadingM23AbacResolver;
  /**
   * The M5 caseload membership check. The composition root injects
   * `(q) => getSeam("CaseloadProvider").isInCaseload(q)` (M23 cannot import the M1-owned bootstrap seam
   * registry — see the import-boundary note above). Absent ⇒ a fail-closed deny-stub: the per-patient
   * caseload axis of `claim_in_billing_manager_caseload` denies until the composition root binds the seam.
   */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

/**
 * Deny-stub `ReadingM23AbacResolver` — every lookup fails closed (no claim, no notice, no validation
 * result). Lets the composition root register the predicates at boot BEFORE a db handle is bound: with this
 * resolver every scope/override predicate denies. Never fails open.
 */
export const denyStubM23AbacResolver: ReadingM23AbacResolver = {
  async loadClaim() {
    return null;
  },
  async loadNoe() {
    return null;
  },
  async loadNotr() {
    return null;
  },
  async loadValidationResult() {
    return null;
  },
  async loadRuleConfig() {
    return null;
  },
};

// ---- shared helpers ---------------------------------------------------------

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);

/** The org + acting user the resolver scopes its `withOrgContext` reads to. */
function readContextOf(context: AbacContext): M23AbacReadContext {
  return { organizationId: context.organizationId, userId: context.userId };
}

/**
 * Is this a service-to-service principal (the M25 Remittance / M26 Cap seam calls into M23)? The route layer
 * marks such callers with a server-assembled `systemPrincipal` attribute; a request-borne actor never sets
 * it. Absent / non-true ⇒ false (fail-closed: an interactive actor is scoped by provider/caseload).
 */
function isSystemPrincipal(context: AbacContext): boolean {
  return context.attributes.systemPrincipal === true;
}

/**
 * Resolve the target ProviderEntity for a scope evaluation. The route may name it directly
 * (`providerEntityId`, e.g. on assemble) OR carry only the entity id (`claimId` / `noeId` / `notrId`); the
 * resolver then loads the owning row's provider scope under RLS. A target that resolves to neither fails
 * closed (null → deny).
 */
async function resolveBillingScopeFacts(
  resolver: ReadingM23AbacResolver,
  context: AbacContext,
  target: AbacTarget,
): Promise<{ providerEntityId: string; patientId: string | null } | null> {
  const directProvider = targetStr(target, "providerEntityId");
  const claimId = targetStr(target, "claimId");
  if (claimId) {
    const facts = await resolver.loadClaim(readContextOf(context), claimId);
    if (!facts) return null;
    return { providerEntityId: facts.providerEntityId, patientId: facts.patientId };
  }
  const noeId = targetStr(target, "noeId");
  if (noeId) {
    const facts = await resolver.loadNoe(readContextOf(context), noeId);
    if (!facts) return null;
    return { providerEntityId: facts.providerEntityId, patientId: facts.patientId };
  }
  const notrId = targetStr(target, "notrId");
  if (notrId) {
    const facts = await resolver.loadNotr(readContextOf(context), notrId);
    if (!facts) return null;
    return { providerEntityId: facts.providerEntityId, patientId: facts.patientId };
  }
  // No entity id — a create/assemble path that names the provider directly.
  if (directProvider) return { providerEntityId: directProvider, patientId: null };
  return null;
}

/**
 * Is the actor's membership scoped to `providerEntityId`? Org-wide billing roles and the system principal
 * pass for any provider; otherwise the canonical server-assembled `context.providerEntityIds` (the M40
 * `provider_entity_scope` source) must include it. Fail-closed: not in scope ⇒ false.
 */
function inProviderScope(context: AbacContext, providerEntityId: string): boolean {
  if (isSystemPrincipal(context)) return true;
  if (ORG_WIDE_BILLING_SCOPE_ROLES.some((r) => hasRole(context, r))) return true;
  return context.providerEntityIds.includes(providerEntityId);
}

/** The override role a rule demands, or `undefined` if the rule is unknown / requires none. */
function requiredOverrideRole(ruleKey: string): OverrideRole | undefined {
  return RULE_PROTECTION_BY_KEY.get(ruleKey)?.overrideRoleRequired;
}

/**
 * Resolve the rule key a target names, one of three ways: directly (`ruleKey`, e.g. a bulk override or
 * the rule-config CREATE route — nothing exists yet to load by id, so the route targets the key being
 * created), via a `validationResultId` (the resolver loads the recorded rule key under RLS — the
 * override-eligibility routes), or via a `ruleConfigId` (the resolver loads the overlay row's rule key
 * under RLS — the rule-config PATCH/DELETE `:id` routes, which target the EXISTING row, not its key). A
 * target that resolves to none of the three fails closed (null → deny).
 */
async function resolveRuleKey(
  resolver: ReadingM23AbacResolver,
  context: AbacContext,
  target: AbacTarget,
): Promise<string | null> {
  const direct = targetStr(target, "ruleKey");
  if (direct) return direct;
  const validationResultId = targetStr(target, "validationResultId");
  if (validationResultId) {
    const facts = await resolver.loadValidationResult(readContextOf(context), validationResultId);
    if (facts) return facts.ruleKey;
  }
  const ruleConfigId = targetStr(target, "ruleConfigId");
  if (ruleConfigId) {
    const facts = await resolver.loadRuleConfig(readContextOf(context), ruleConfigId);
    if (facts) return facts.ruleKey;
  }
  return null;
}

/**
 * Resolve the injected/derived resolver for a predicate factory: an explicit `resolver` wins (tests), else
 * a `db` handle builds the real Drizzle resolver, else the fail-closed deny-stub.
 */
function resolverFor(deps: ReadingM23AbacDeps): ReadingM23AbacResolver {
  if (deps.resolver) return deps.resolver;
  if (deps.db) return buildDrizzleM23AbacResolver(deps.db);
  return denyStubM23AbacResolver;
}

/**
 * Build M23's four §4.7 predicate resolvers over a Drizzle `db` handle (or an injected `resolver` for unit
 * tests). Target ids come from the route `:id`/payload; a missing / cross-tenant fact row, an actor with no
 * resolvable provider scope, an out-of-scope provider, or an un-suppliable target id fails closed (deny).
 * Every resolver load is org-scoped to `context.organizationId` under RLS.
 */
export function buildM23AbacPredicates(
  deps: ReadingM23AbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const resolver = resolverFor(deps);
  // Fail-closed default: with no injected caseload checker the per-patient axis denies (the composition
  // root binds the real M5 `CaseloadProvider` seam — M23 cannot import the bootstrap registry directly).
  const isInCaseload = deps.isInCaseload ?? (async () => false);

  return {
    // The actor's membership is scoped to the resource's ProviderEntity, OR the actor holds an org-wide
    // billing role, OR is a system principal (the M25/M26 service-to-service seam calls). §4.7. Guards the
    // claim assemble / NOE / NOTR / eligibility / sequestration / MAC-credential surfaces.
    provider_entity_billing_scope: async (context, target) => {
      if (isSystemPrincipal(context)) return true; // service-to-service (M25/M26)
      const facts = await resolveBillingScopeFacts(resolver, context, target);
      if (!facts) return false; // fail-closed (no resolvable provider)
      return inProviderScope(context, facts.providerEntityId);
    },

    // The claim's patient is in the actor's caseload AND the claim's ProviderEntity is in scope. §4.7. An
    // org-wide billing role / system principal satisfies BOTH axes; otherwise both the provider scope and
    // the M5 caseload membership must hold. Guards the claim read / update / submit / replace / void paths.
    claim_in_billing_manager_caseload: async (context, target) => {
      const claimId = targetStr(target, "claimId");
      if (!claimId) return false; // route must supply the claim id → fail-closed
      const facts = await resolver.loadClaim(readContextOf(context), claimId);
      if (!facts) return false; // absent / cross-tenant
      if (!inProviderScope(context, facts.providerEntityId)) return false;
      // Broad-scope principals bypass the per-patient caseload axis (they see every provider's claims).
      if (isSystemPrincipal(context)) return true;
      if (ORG_WIDE_BILLING_SCOPE_ROLES.some((r) => hasRole(context, r))) return true;
      if (!context.userId) return false;
      return isInCaseload({
        organizationId: context.organizationId,
        userId: context.userId,
        patientId: facts.patientId,
      });
    },

    // The actor holds the OverrideRole the failed validation_result's rule demands (D5). The required role
    // is read from the code-side rule registry — NOT the request body. §4.7. Guards the §2.2 override-record
    // surface. Fail-closed: an un-resolvable rule key, a rule that requires no override role (so an override
    // is not a sanctioned action), or an actor lacking the role ⇒ deny.
    override_role_eligible: async (context, target) => {
      const ruleKey = await resolveRuleKey(resolver, context, target);
      if (!ruleKey) return false; // fail-closed (no resolvable rule)
      const role = requiredOverrideRole(ruleKey);
      if (!role) return false; // the rule sanctions no override → deny the override surface
      return hasRole(context, role);
    },

    // PROTECTS a regulatory-required rule from tenant overlay-editing (D5): DENIES (false) when the targeted
    // rule is `regulatoryRequired`, ALLOWS (true) for a non-regulatory / tenant-custom rule. The per-instance
    // override surface is gated by `override_role_eligible`, NOT this predicate (fine-grained §4.5/§4.7). The
    // regulatory floor is read from the code-side registry. Fail-closed: a missing target rule key ⇒ deny.
    regulatory_required_rule_protected: async (context, target) => {
      const ruleKey = await resolveRuleKey(resolver, context, target);
      if (!ruleKey) return false; // route must supply the rule key → fail-closed (deny the edit)
      const facts = RULE_PROTECTION_BY_KEY.get(ruleKey);
      // Unknown key ⇒ not a platform-floor regulatory rule (a tenant-custom rule) ⇒ editing is permitted.
      if (!facts) return true;
      return !facts.regulatoryRequired;
    },
  };
}

/**
 * Register M23's four §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Call at boot;
 * the composition root passes `{ db }` so the predicates resolve facts under RLS. With NO db handle it
 * defaults to the {@link denyStubM23AbacResolver} so the predicates still EXIST (fail-closed) at boot.
 * Re-boot (tests) skips already-registered names (single-owner / no-clear; the M27 precedent).
 */
export function registerM23AbacPredicates(deps: ReadingM23AbacDeps = {}): void {
  const predicates = buildM23AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
