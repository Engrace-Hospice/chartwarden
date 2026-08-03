// apps/backend/src/modules/32-ai-platform/abac-predicates.ts — M32-T07 (§4.7 / §8.1).
//
// The SIX named ABAC predicate resolvers M32 registers into M3's named-predicate registry. Each is a
// typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes; every subject fact is
// loaded through the injected {@link AiPlatformAbacResolver} (org-scoped, RLS-backstopped) — never read
// off the request body.
//
//   ai_safety_owner                        — §4.7 `wardenx.ai_safety_owner`: the CROSS-TENANT platform
//        operator. The one M32 predicate that cannot be expressed as a permission grant (see below).
//   ai_capability_tenant_opted_in          — §4.7: an `ai_tenant_opt_in_record` for (org, capability) is
//        ACTIVE. The SDK gate's tenant arm (§5.3 / W4).
//   ai_capability_clinician_opted_out      — §4.7: a live `ai_clinician_opt_out` exists for this actor.
//        NOTE THE POLARITY: this predicate is TRUE when the clinician has opted OUT. §4.7 says "used by
//        SDK gate (inverted)" and the name says what it MEASURES, not what it permits — a route binding
//        it directly would gate access on having opted out, which is backwards. It is bound by the SDK
//        gate and by nothing in §4.1 (see the "registered but route-unbound" note).
//   ai_kill_switch_inactive                — §4.7: NO active row matches `(capability, org)` OR
//        `(capability, NULL)`. A DISJUNCTION of the platform and tenant rows, per M32-T05.
//   ai_invocation_same_org_or_safety_owner — §4.7: R17's object-level check.
//   ai_prohibited_zone_respected           — §4.7 / D18: the BOOT-time query M12/M13/M18/M21/M27/M28 run.
//
// ── THE FOUR ROLE-SHAPED CELLS §4.1 NAMES THAT M32 DOES **NOT** REGISTER ──────────────────────────────
//
// §4.1's Predicates column spells `wardenx.organization.member`, `wardenx.tenant_admin`,
// `wardenx.compliance_officer` and `wardenx.phi.full_read` beside `wardenx.ai_safety_owner`. Only the
// last is registered here, and the asymmetry is the whole design:
//
//   · `wardenx.organization.member` IS M3's intrinsic `inOrg`, verbatim ("session.organization_id ===
//     target.organization_id"). Registering a second name for a rule the platform already implements
//     would create two predicates that must never disagree, and `arch:abac-predicates` would be satisfied
//     by either. This is the M20 rule-5 decision, unchanged.
//   · `wardenx.tenant_admin` / `wardenx.compliance_officer` are ROLE facts, and §4.6's DEFAULT GRANTS
//     already carry them: `ai.tenant_opt_in` is granted to `tenant_admin` and nobody else, `ai.invocation
//     .read` to the Compliance Officer and the AI Safety Owner. A predicate that re-asserted the role
//     would be a second copy of the grant table that M3's catalog is the source of truth for, and the two
//     would drift the first time a tenant restricted a template.
//   · `wardenx.ai_safety_owner` CANNOT be reduced that way, and that is precisely why it is here. It is
//     CROSS-TENANT: the operator's session may carry an organization that is not the row's, so `inOrg`
//     denies them and no per-org grant can express "may act across every tenant". It is the only M32 cell
//     that names an authority the org-scoped machinery cannot state.
//   · `wardenx.phi.full_read` is M3/M5's masking grant, consumed by R16's projection rather than by a
//     guard (an actor without it gets a MASKED row, not a 403 — refusing the compliance officer the whole
//     search because she may not read the free text would break the §164.528 review the route exists for).
//
// ── ONE PREDICATE IS REGISTERED AND BOUND BY NO §4.1 ROUTE, DELIBERATELY ──────────────────────────────
//
// `ai_capability_clinician_opted_out` measures a fact whose route-level use would be inverted (see above),
// and `ai_prohibited_zone_respected` is a BOOT validator, not a request gate. Both are registered because
// §4.7 declares them and because M3's registry fails CLOSED on an unknown name: a predicate that exists as
// a name nothing declares is a permanently dead endpoint the whole build stays green over (the M30 finding
// `arch:abac-predicates` was built for). Declaring them here is what keeps "not yet bound to a route" and
// "misspelled" distinguishable.
//
// ── THE FAIL DIRECTION IS UNIFORM ────────────────────────────────────────────────────────────────────
//
// Every one of the six is an AUTHORIZATION read: an unreadable resolver, an unknown target, an absent row,
// a cross-tenant id and a thrown error all DENY. `ai_kill_switch_inactive` is the one whose fail-closed
// direction reads backwards at a glance — an unreadable kill-switch table answers "a switch MAY be
// active", i.e. the predicate is FALSE and the capability is refused. Guessing "no switch" from a failed
// read would let an outage of the safety table resume a capability somebody paused during a SEV-1.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards
// on `abacRegistry.has`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";

/** The §4.7 predicate names M32 OWNS (registered into M3). Single-owner across the platform registry. */
export const M32_ABAC_PREDICATES = [
  "ai_safety_owner",
  "ai_capability_tenant_opted_in",
  "ai_capability_clinician_opted_out",
  "ai_kill_switch_inactive",
  "ai_invocation_same_org_or_safety_owner",
  "ai_prohibited_zone_respected",
] as const;

export type M32RegisteredAbacPredicate = (typeof M32_ABAC_PREDICATES)[number];

/**
 * §4.7 `ai_safety_owner` — the role keys that carry AI-safety authority.
 *
 * §4.7's own definition is "granted only to Anthropic platform operators in production, or to designated
 * tenant clinical safety leads in single-tenant deployments" — a two-population definition, which is why
 * this list holds both a PLATFORM key and a tenant-side one. `platform_ops` is M3's cross-tenant operator
 * template; `clinical_safety_lead` is the single-tenant designee §4.7's second clause names and the same
 * role W4.1's opt-in evidence check requires of a named clinical reviewer.
 *
 * `compliance_officer` is NOT here. §4.1 lists it beside `ai_safety_owner` on R9 and R16 as a SEPARATE
 * arm, and folding it in would silently grant the compliance officer the R1/R4/R7 write surface — kill
 * switches, lifecycle transitions and prompt activation — that §6's matrix gives to the safety owner
 * alone. The two arms are ORed at the route (routes/guards.ts), which is where a disjunction belongs.
 */
export const AI_SAFETY_OWNER_ROLE_KEYS = [
  "ai_safety_owner",
  "platform_ops",
  "clinical_safety_lead",
] as const;

/**
 * §4.1 R9/R16 — the roles whose read arm is ORed beside the safety owner's.
 *
 * Kept as its own list rather than merged into {@link AI_SAFETY_OWNER_ROLE_KEYS} for the reason stated
 * there: a compliance officer reads the kill-switch dashboard and the disclosure ledger, and writes
 * nothing in this module.
 */
export const AI_COMPLIANCE_READER_ROLE_KEYS = [
  "compliance_officer",
  "privacy_officer",
  "administrator",
  "org_admin",
] as const;

// ── the facts the six predicates decide over ─────────────────────────────────────────────────────────

/** One `ai_tenant_opt_in_record` as `ai_capability_tenant_opted_in` reads it (§3.2.6). */
export interface AiTenantOptInAbacFacts {
  readonly organizationId: string;
  readonly capabilityId: string;
  /** `ai_tenant_opt_in_status`. Only `active` opts a tenant IN; `paused`/`withdrawn` do not. */
  readonly status: string;
  readonly optedOutAt: string | null;
}

/** One `ai_invocation` row as `ai_invocation_same_org_or_safety_owner` reads it (§3.2.8). */
export interface AiInvocationAbacFacts {
  readonly invocationId: string;
  readonly organizationId: string;
  /** Needed by the read route because the composite PK is `(id, invoked_at)` — the partition key is not
   *  derivable from the id, so the predicate hands it forward rather than making the route scan. */
  readonly invokedAt: string;
}

/**
 * The read surface M32's predicates resolve against (Drizzle in prod; in-memory in tests).
 *
 * EVERY METHOD IS THREE-VALUED WHERE THE DIFFERENCE MATTERS, and only where it does. `resolveCapabilityId`
 * answers `null` for both "no such capability" and "unreadable" because both deny identically and telling
 * them apart would let a caller enumerate the platform's capability registry by timing the refusals — the
 * same argument `resolveAiGovernanceGate` makes for answering `lifecycle_state_retired` to an unknown key.
 * `killSwitchActive` is the one that returns a THREE-valued answer (`true`/`false`/`null` = unreadable),
 * because the predicate's fail-closed direction is "a switch may be active" and a boolean cannot carry it.
 */
export interface AiPlatformAbacResolver {
  /** The enabled M3 role keys a membership holds in this org, or null when unresolvable (denies). */
  roleKeysOf(orgId: string, membershipId: string): Promise<readonly string[] | null>;
  /** Resolve a capability KEY or id to its id, or null when absent/unreadable. */
  resolveCapabilityId(capabilityRef: string): Promise<string | null>;
  /** The tenant's opt-in row for a capability, or null when absent/unreadable. */
  loadTenantOptIn(orgId: string, capabilityId: string): Promise<AiTenantOptInAbacFacts | null>;
  /** Whether a LIVE (un-reverted) clinician opt-out exists. `null` ⇒ unreadable. */
  clinicianOptedOut(
    orgId: string,
    membershipId: string,
    capabilityId: string,
  ): Promise<boolean | null>;
  /** Whether an active kill switch covers `(capability, org)` OR `(capability, NULL)`. `null` ⇒
   *  unreadable, which the predicate treats as "may be active" (see the module header). */
  killSwitchActive(orgId: string, capabilityId: string): Promise<boolean | null>;
  /** The invocation's org + partition key, or null when absent/cross-tenant/unreadable. */
  loadInvocation(orgId: string, invocationId: string): Promise<AiInvocationAbacFacts | null>;
  /** D18 — the ACTIVE prompt templates whose target entity starts with `prefix`. `null` ⇒ unreadable,
   *  which denies; an empty array is the genuine "no contraband prompt" answer. */
  activePromptsTargeting(prefix: string): Promise<readonly unknown[] | null>;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubAiPlatformAbacResolver: AiPlatformAbacResolver = {
  async roleKeysOf() {
    return null;
  },
  async resolveCapabilityId() {
    return null;
  },
  async loadTenantOptIn() {
    return null;
  },
  async clinicianOptedOut() {
    return null;
  },
  async killSwitchActive() {
    return null;
  },
  async loadInvocation() {
    return null;
  },
  async activePromptsTargeting() {
    return null;
  },
};

export interface AiPlatformAbacDeps {
  readonly resolver: AiPlatformAbacResolver;
}

// ── target/context extraction (server-side only) ─────────────────────────────────────────────────────

function targetStr(target: AbacTarget, ...fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function membershipIdOf(context: AbacContext): string | null {
  const value = context.attributes?.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Whether the SESSION holds an AI-safety-owner role.
 *
 * Reads the assembled `context.roles` FIRST and only then falls back to the resolver. §4.7 makes this a
 * cross-tenant authority, and the resolver's `roleKeysOf` is org-scoped — a platform operator acting on a
 * tenant they hold no membership in has no row for it to find. The session's assembled role set is the
 * one place that authority is visible, which is also why this is the single M32 predicate that can pass
 * with `membershipId === null`.
 */
async function isAiSafetyOwner(
  resolver: AiPlatformAbacResolver,
  context: AbacContext,
): Promise<boolean> {
  if (context.roles.some((role) => AI_SAFETY_OWNER_ROLE_KEYS.includes(role as never))) return true;
  const membershipId = membershipIdOf(context);
  if (membershipId === null || !context.organizationId) return false;
  const roles = await resolver.roleKeysOf(context.organizationId, membershipId).catch(() => null);
  if (roles === null) return false;
  return roles.some((role) => AI_SAFETY_OWNER_ROLE_KEYS.includes(role as never));
}

/** Whether the SESSION holds a compliance-side read role (the R9/R16 second arm — see the role lists). */
export function isAiComplianceReader(context: AbacContext): boolean {
  return context.roles.some((role) => AI_COMPLIANCE_READER_ROLE_KEYS.includes(role as never));
}

// ── the predicates ───────────────────────────────────────────────────────────────────────────────────

/** Build M32's six §4.7 predicate resolvers over an injected read surface (unit-testable without seams). */
export function buildAiPlatformAbacPredicates(deps: AiPlatformAbacDeps): Record<
  M32RegisteredAbacPredicate,
  (context: AbacContext, target: AbacTarget) => Promise<boolean>
> {
  const { resolver } = deps;

  /** The capability a target names — by id (`capabilityId`) or by key (`capabilityKey`), resolved. */
  const capabilityOf = async (target: AbacTarget): Promise<string | null> => {
    const ref = targetStr(target, "capabilityId", "capabilityKey", "id");
    if (ref === null) return null;
    return resolver.resolveCapabilityId(ref).catch(() => null);
  };

  return {
    /** §4.7 — the cross-tenant platform operator (R1, R4, R5, R6, R7, R19, R20, R26-R32). */
    ai_safety_owner: async (context) => isAiSafetyOwner(resolver, context),

    /** §4.7 / §5.3 — an ACTIVE `ai_tenant_opt_in_record` for (org, capability). */
    ai_capability_tenant_opted_in: async (context, target) => {
      if (!context.organizationId) return false;
      const capabilityId = await capabilityOf(target);
      if (capabilityId === null) return false;
      const optIn = await resolver
        .loadTenantOptIn(context.organizationId, capabilityId)
        .catch(() => null);
      if (optIn === null) return false;
      // `paused` and `withdrawn` are NOT opted in. §5.3's pause keeps the acknowledgment EVIDENCE while
      // stopping the capability, so a status check that accepted anything non-`withdrawn` would make the
      // pause a no-op that only the audit log could tell apart from a working one.
      return optIn.status === "active" && optIn.optedOutAt === null;
    },

    /**
     * §4.7 — a LIVE `ai_clinician_opt_out` exists for this actor (§5.4).
     *
     * TRUE MEANS OPTED OUT. See the module header: the name states the measurement, the SDK gate inverts
     * it. Nothing in §4.1 binds this at a route, and a route that did would refuse everyone who has NOT
     * opted out — the exact inversion this comment exists to prevent.
     */
    ai_capability_clinician_opted_out: async (context, target) => {
      if (!context.organizationId) return false;
      const membershipId = membershipIdOf(context);
      if (membershipId === null) return false;
      const capabilityId = await capabilityOf(target);
      if (capabilityId === null) return false;
      const optedOut = await resolver
        .clinicianOptedOut(context.organizationId, membershipId, capabilityId)
        .catch(() => null);
      // Unreadable ⇒ FALSE, i.e. "we cannot show an opt-out". The SDK gate inverts this predicate, so a
      // `null`-to-`true` reading would fail the gate CLOSED for a clinician who never opted out — a
      // capability silently dead for the whole org whenever the consent table blinks.
      return optedOut === true;
    },

    /** §4.7 / D8 — no active kill switch covers `(capability, org)` OR `(capability, NULL)`. */
    ai_kill_switch_inactive: async (context, target) => {
      if (!context.organizationId) return false;
      const capabilityId = await capabilityOf(target);
      if (capabilityId === null) return false;
      const active = await resolver
        .killSwitchActive(context.organizationId, capabilityId)
        .catch(() => null);
      // `null` (unreadable) is NOT "inactive" — see the module header's fail-direction note.
      return active === false;
    },

    /** §4.7 — R17's object-level check: same org, OR the cross-tenant safety owner. */
    ai_invocation_same_org_or_safety_owner: async (context, target) => {
      if (await isAiSafetyOwner(resolver, context)) return true;
      if (!context.organizationId) return false;
      const invocationId = targetStr(target, "invocationId", "id");
      if (invocationId === null) return false;
      const invocation = await resolver
        .loadInvocation(context.organizationId, invocationId)
        .catch(() => null);
      if (invocation === null) return false;
      return invocation.organizationId === context.organizationId;
    },

    /**
     * §4.7 / D18 — the BOOT-time query: true iff NO active prompt template targets the consumer's
     * AI-prohibited zone.
     *
     * The target names the prefix (`consumerModulePrefix`). An UNREADABLE registry answers false — the
     * asymmetry M32-T06 pinned: `[]` from a working registry is "no contraband found", and `[]` minted
     * from a failed read is a clean bill of health nobody issued.
     */
    ai_prohibited_zone_respected: async (_context, target) => {
      const prefix = targetStr(target, "consumerModulePrefix", "entityPrefix", "prefix");
      if (prefix === null) return false;
      const matches = await resolver.activePromptsTargeting(prefix).catch(() => null);
      if (matches === null) return false;
      return matches.length === 0;
    },
  };
}

/**
 * Register M32's six §4.7 ABAC predicate resolvers into M3's shared registry (M32-T07; idempotent).
 *
 * Call at boot after the M32 stores are constructed (the resolver reads the same tables). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerAiPlatformAbacPredicates(deps: AiPlatformAbacDeps): void {
  const predicates = buildAiPlatformAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
