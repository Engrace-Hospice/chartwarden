// apps/backend/src/modules/34-saas-tenant-platform/alert-rules.ts — M34 (§4.8, D17).
//
// Module 34's contribution to M36's alert engine: the THIRTEEN §4.8 alert-rule keys M34 ships as
// M36 platform-default seed rows, plus the TWO recipient resolvers M34 registers onto M36's OPEN
// resolver registry (`compliance_officer_for_tenant`, `platform_security_owner`). This is the exact
// ADR-0024 composition-resolver precedent (`registerCompositionResolvers` in
// packages/messaging/src/compose/resolvers.ts): M34 adds NEW resolver names + NEW platform-default
// rules to M36's catalog WITHOUT changing M36's seven built-ins and WITHOUT an import edge from M36
// to M34. M34 stays the PRODUCER — it emits the typed `m34.*` outbox events (events-by-m34.ts); M36
// is the live alerts consumer that matches an emitted `eventType` to the firing `alert_rule`s and
// fans out via the registered resolvers (§4.8). M34 `dependsOn` stays `[1,2,3,4,36]` — this file
// imports ONLY `@wardenx/messaging` (M36) types, never the inverse.
//
// SEED SHAPE (§4.8 ↔ M36 §3.6/§3.10): each rule below is an M36 platform-default `alert_rule` row
// (organization_id NULL) keyed on the `m34.<resource>.<verb>` outbox `eventType` the engine matches
// on (NOT the bare §4.8 rule key — see events-by-m34.ts header: the bare keys like
// `tenant.shred_pending_approval` are M36 rule labels; the wire `eventType` carries the `m34.` prefix
// the event-catalog gate enforces). M34 cannot reuse M36's enum-constrained `PlatformAlertRuleSeed`
// type for the seed because its `recipientResolver` is the `alert_recipient_resolver` pgEnum, which
// does NOT carry M34's two new resolver names (exactly as the ADR-0024 `ordering_provider*` names are
// absent from that enum). So the seed below is an M34-local row shape whose `recipientResolver` is a
// `string` — structurally the `EmitAlertRule` the engine routes on (§4.6). The boot UPSERT that
// inserts these rows is a Phase 2D TODO (see the foot of this file).
//
// SEVERITY MAPPING (D17 caveat): the §4.8 table uses an `info | warn | error | critical` ladder, but
// M36's `alert_severity` pgEnum (the `alert_rule.severity_floor` column) is the three-level
// `info | warn | critical` ladder (packages/db/src/enums.ts; §3.2 — DISTINCT from the broader
// `alert_payload_severity` catalog ladder). M34's `error` rows therefore floor to `critical` (the
// only level above `warn`); the finer distinction, if M36 later widens the legacy ladder, is carried
// losslessly in `specSeverity` on each rule below so the seed can be re-projected without re-reading
// the spec. See the typed TODO at the foot of this file.

import type { RecipientResolverFn } from "@wardenx/messaging";

// ── M34's two registered recipient resolvers (§4.8) ──────────────────────────────────────────────

/**
 * The source-of-truth lookups M34's two resolvers delegate to — bound at boot (Phase 2D) to M2
 * membership/role state. Kept as plain async ports (the ADR-0024 `CompositionResolverPorts`
 * precedent) so the resolvers stay pure and unit-testable with fakes; the M2 seam is not required to
 * exercise the resolution logic.
 */
export interface M34AlertResolverPorts {
  /**
   * M2 membership filtered to the named compliance-officer role(s) WITHIN the tenant org that owns
   * the alert (`compliance_officer_for_tenant`). The org is the alert's emit-org (the `orgId` M36
   * passes to the resolver) unless an explicit `orgIdPath` arg points at a payload field — a
   * tenant-lifecycle alert carries `orgId` in its payload (events-by-m34.ts), so the firing rule
   * scopes the officer lookup to that tenant's org, not the platform.
   */
  complianceOfficersForOrg(orgId: string, roleKeys: readonly string[]): Promise<readonly string[]>;
  /**
   * The PLATFORM security owner(s) — the platform-ops actor(s) holding the security-owner role
   * (`platform_security_owner`). A platform-scoped audience (NOT tenant-scoped): a tenant's
   * retention/shred/kill-switch/SLA-breach escalation pages the platform security desk, independent
   * of the alert's emit-org.
   */
  platformSecurityOwners(roleKeys: readonly string[]): Promise<readonly string[]>;
}

/** The two resolver names M34 adds to M36's registry (the new `RecipientResolver.name` values). */
export const M34_ALERT_RESOLVER_NAMES = [
  "compliance_officer_for_tenant",
  "platform_security_owner",
] as const;

/** Default role-key sets for the two M34 audiences (overridable per-rule via `resolverArgs.roleKeys`). */
export const M34_ALERT_RESOLVER_ROLE_KEYS = {
  compliance_officer_for_tenant: ["compliance_officer"],
  platform_security_owner: ["platform_security_owner"],
} as const;

/** Read a non-empty string off the payload at `key`, else null (mirrors M36's core resolvers). */
function readPath(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A `*Path` arg as a string (where in the payload a subject id lives), or undefined. */
function pathArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Role keys off `resolverArgs.roleKeys` when present, else the supplied default. */
function roleKeysArg(
  args: Record<string, unknown>,
  fallback: readonly string[],
): readonly string[] {
  const v = args.roleKeys;
  return Array.isArray(v) && v.every((k) => typeof k === "string") ? (v as string[]) : fallback;
}

/**
 * Register M34's two recipient resolvers onto an EXISTING M36 resolver registry (the map
 * `createRecipientResolverRegistry` returns), over the given source ports. Additive — it never
 * replaces a built-in; both names are new to the registry. Returns the same registry for chaining;
 * idempotent re-registration overwrites with an equivalent resolver (the M36-T09
 * `registerCompositionResolvers` precedent).
 *
 * Like the built-ins, `compliance_officer_for_tenant` returns `[]` when the payload omits the org id
 * rather than throwing — a missing `orgId` is a producer-payload problem the dispatch outcome
 * surfaces (§7.13 "malformed payload"), not a resolver crash.
 */
export function registerM34AlertResolvers(
  registry: Map<string, RecipientResolverFn>,
  ports: M34AlertResolverPorts,
): Map<string, RecipientResolverFn> {
  registry.set("compliance_officer_for_tenant", async (orgId, args, payload) => {
    // Scope to the tenant org carried in the payload when present (lifecycle alerts carry `orgId`);
    // else the emit-org M36 passed. An explicit `orgIdPath` arg overrides the payload key.
    const tenantOrgId = readPath(payload, pathArg(args, "orgIdPath") ?? "orgId") ?? orgId;
    if (tenantOrgId.length === 0) return [];
    return ports.complianceOfficersForOrg(
      tenantOrgId,
      roleKeysArg(args, M34_ALERT_RESOLVER_ROLE_KEYS.compliance_officer_for_tenant),
    );
  });

  registry.set("platform_security_owner", async (_orgId, args) =>
    ports.platformSecurityOwners(
      roleKeysArg(args, M34_ALERT_RESOLVER_ROLE_KEYS.platform_security_owner),
    ),
  );

  return registry;
}

// ── M34's thirteen platform-default alert rules (§4.8) ───────────────────────────────────────────

/** The three-level legacy ladder M36's `alert_severity` pgEnum / `alert_rule.severity_floor` uses. */
export type M34AlertSeverityFloor = "info" | "warn" | "critical";

/** The four-level §4.8 ladder the spec table authors against (carried losslessly for re-projection). */
export type M34SpecSeverity = "info" | "warn" | "error" | "critical";

/**
 * One M34 platform-default `alert_rule` (organization_id NULL). Structurally the `EmitAlertRule`
 * M36's engine routes on (§4.6): `recipientResolver` is a `string` so it can name M34's two
 * registered resolvers, which the `alert_recipient_resolver` pgEnum does not carry.
 */
export interface M34AlertRuleSeed {
  /** The §4.8 bare rule key (the M36 catalog label / what the platform-ops UI shows). */
  readonly ruleKey: string;
  /** The wire `eventType` the engine matches on — the `m34.<resource>.<verb>` outbox name (§4.9). */
  readonly eventType: string;
  /** M36 `alert_category` (every M34 rule is platform/admin-plane → `administrative` or `system`). */
  readonly category: "administrative" | "system";
  /** The legacy-ladder floor written to `alert_rule.severity_floor`. */
  readonly severityFloor: M34AlertSeverityFloor;
  /** The §4.8 ladder severity (re-projection source if M36 widens the legacy ladder). */
  readonly specSeverity: M34SpecSeverity;
  /** A named resolver — one of M34's two, or an M36 built-in / role_set for the platform-ops floor. */
  readonly recipientResolver: string;
  /** `alert_rule.resolver_args` — `*Path` keys + role overrides the resolver reads (§3.6). */
  readonly resolverArgs: Record<string, unknown>;
  /** null ⇒ use recipient preferences (no channel override, §3.6). */
  readonly channelsOverride: readonly string[] | null;
  /** Tenant-overridable (§7.4) unless locked; only `tenant.onboarding_activation_stuck` is (see its row). */
  readonly systemLocked: boolean;
  readonly enabled: boolean;
}

/** Map a §4.8 spec severity onto M36's three-level `alert_severity` floor (`error` → `critical`). */
function floorOf(spec: M34SpecSeverity): M34AlertSeverityFloor {
  return spec === "error" ? "critical" : spec;
}

/** Helper: a rule routed to a SECOND resolver (M36 fans out one `alert_rule` per resolver, §3.6 —
 *  the unique index is (org, event_type, severity_floor), so a multi-audience §4.8 row becomes two
 *  seed rows at distinct floors OR one row whose resolver is composed; M34 ships one row per audience
 *  by giving the platform-ops co-recipient a `role_set` companion rule). The table below enumerates
 *  the PRIMARY audience per §4.8 key; the platform-ops co-recipient companion rows follow it. */

/**
 * The thirteen §4.8 alert-rule keys (rows below; the multi-audience keys add a `role_set` platform-ops
 * companion so each `alert_rule` row names exactly one resolver, §3.6). Keyed on the `m34.*` outbox
 * `eventType` the engine matches; `compliance_officer_for_tenant` / `platform_security_owner` route
 * to M34's two registered resolvers. UPSERTed as M36 platform-default rows at boot.
 */
/** The M3 RBAC role key the platform-ops console gates on (`tenant_lifecycle_platform_ops`). */
export const PLATFORM_OPS_ROLE_KEY = "platform_ops";

/**
 * The ZERO-permission role operators are bound with INSIDE a tenant org (bind-platform-staff.ts, migration 1097).
 * Rules emitted under a TENANT org route at this key, never at `platform_ops`: binding `platform_ops` there would
 * hand operators `user.password.reset` / `user.deactivate` over the tenant's users.
 */
// Literal on purpose (this file imports no runtime code); a test pins it to `@wardenx/auth`.
export const TENANT_ALERT_AUDIENCE_ROLE_KEY = "platform_alert_audience";

export const M34_ALERT_RULES: readonly M34AlertRuleSeed[] = [
  // 1. tenant.onboarding_step_blocked_5d — m34.tenant.onboarding_step_blocked aged 5d → compliance officer + platform-ops
  {
    ruleKey: "tenant.onboarding_step_blocked_5d",
    eventType: "m34.tenant.onboarding_step_blocked",
    category: "administrative",
    severityFloor: floorOf("warn"),
    specSeverity: "warn",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    ruleKey: "tenant.onboarding_step_blocked_5d.platform_ops",
    eventType: "m34.tenant.onboarding_step_blocked",
    category: "administrative",
    severityFloor: floorOf("info"), // distinct floor so the (org,event,floor) unique index admits both rows
    specSeverity: "warn",
    recipientResolver: "platform_security_owner",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 2. tenant.onboarding_overdue — daily sweep → compliance officer
  {
    ruleKey: "tenant.onboarding_overdue",
    eventType: "m34.tenant.onboarding_overdue",
    category: "administrative",
    severityFloor: floorOf("warn"),
    specSeverity: "warn",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 3. tenant.onboarding_completed — m34.tenant.activated mirror → platform-ops (info)
  {
    ruleKey: "tenant.onboarding_completed",
    eventType: "m34.tenant.onboarding_completed",
    category: "administrative",
    severityFloor: floorOf("info"),
    specSeverity: "info",
    recipientResolver: "platform_security_owner",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 4. tenant.suspension_initiated — m34.tenant.suspended → compliance officer + platform-ops (error)
  {
    ruleKey: "tenant.suspension_initiated",
    eventType: "m34.tenant.suspension_initiated",
    category: "administrative",
    severityFloor: floorOf("error"),
    specSeverity: "error",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    ruleKey: "tenant.suspension_initiated.platform_ops",
    eventType: "m34.tenant.suspension_initiated",
    category: "administrative",
    severityFloor: floorOf("warn"), // distinct floor for the (org,event,floor) unique index
    specSeverity: "error",
    recipientResolver: "platform_security_owner",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 5. tenant.offboarding_initiated — compliance officer + platform_security_owner (error)
  {
    ruleKey: "tenant.offboarding_initiated",
    eventType: "m34.tenant.offboarding_initiated",
    category: "administrative",
    severityFloor: floorOf("error"),
    specSeverity: "error",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    ruleKey: "tenant.offboarding_initiated.security_owner",
    eventType: "m34.tenant.offboarding_initiated",
    category: "administrative",
    severityFloor: floorOf("warn"), // distinct floor for the (org,event,floor) unique index
    specSeverity: "error",
    recipientResolver: "platform_security_owner",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 6. tenant.retention_approaching_30d — retention sweep (tier=approaching_30d) → platform-ops (warn)
  {
    ruleKey: "tenant.retention_approaching_30d",
    eventType: "m34.tenant.retention_window_approaching",
    category: "administrative",
    severityFloor: floorOf("warn"),
    specSeverity: "warn",
    recipientResolver: "platform_security_owner",
    resolverArgs: { tier: "approaching_30d" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 7. tenant.retention_approaching_7d — retention sweep (tier=approaching_7d) → platform_security_owner (error)
  {
    ruleKey: "tenant.retention_approaching_7d",
    eventType: "m34.tenant.retention_window_approaching",
    category: "administrative",
    severityFloor: floorOf("error"),
    specSeverity: "error",
    recipientResolver: "platform_security_owner",
    resolverArgs: { tier: "approaching_7d" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 8. tenant.shred_pending_approval — m34.tenant.retention_window_reached → platform_security_owner (error)
  {
    ruleKey: "tenant.shred_pending_approval",
    eventType: "m34.tenant.shred_pending_approval",
    category: "administrative",
    severityFloor: floorOf("error"),
    specSeverity: "error",
    recipientResolver: "platform_security_owner",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 9. tenant.shred_executed — m34.tenant.destroyed → platform-ops + compliance officer (final notice, info)
  {
    ruleKey: "tenant.shred_executed",
    eventType: "m34.tenant.destroyed",
    category: "administrative",
    severityFloor: floorOf("info"),
    specSeverity: "info",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    ruleKey: "tenant.shred_executed.platform_ops",
    eventType: "m34.tenant.destroyed",
    category: "administrative",
    severityFloor: floorOf("warn"), // distinct floor for the (org,event,floor) unique index
    specSeverity: "info",
    recipientResolver: "platform_security_owner",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 10. support_session.started — m34.support_session.started → compliance officer (grantor, warn)
  {
    ruleKey: "support_session.started",
    eventType: "m34.support_session.started",
    category: "administrative",
    severityFloor: floorOf("warn"),
    specSeverity: "warn",
    recipientResolver: "compliance_officer_for_tenant",
    // the support-session payload carries `tenantAccountId`; the grantor-org lookup resolves the
    // tenant org from it at boot (Phase 2D) — no `orgId` on the payload, so default emit-org applies.
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 11. dsar_export.sla_escalation_20d — DSAR aged 20d → DSAR-officer + compliance officer (warn)
  {
    ruleKey: "dsar_export.sla_escalation_20d",
    eventType: "m34.dsar_export.requested",
    category: "administrative",
    severityFloor: floorOf("warn"),
    specSeverity: "warn",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId", slaTierDays: 20 },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 12. dsar_export.sla_escalation_27d — DSAR aged 27d → DSAR-officer + compliance officer + platform-ops (error)
  {
    ruleKey: "dsar_export.sla_escalation_27d",
    eventType: "m34.dsar_export.requested",
    category: "administrative",
    severityFloor: floorOf("error"),
    specSeverity: "error",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId", slaTierDays: 27 },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    ruleKey: "dsar_export.sla_escalation_27d.platform_ops",
    eventType: "m34.dsar_export.requested",
    category: "administrative",
    severityFloor: floorOf("warn"), // distinct floor for the (org,event,floor) unique index
    specSeverity: "error",
    recipientResolver: "platform_security_owner",
    resolverArgs: { slaTierDays: 27 },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 13. dsar_export.sla_escalation_30d — DSAR aged 30d (SLA breach) → DSAR-officer + compliance officer + platform_security_owner (critical)
  {
    ruleKey: "dsar_export.sla_escalation_30d",
    eventType: "m34.dsar_export.requested",
    category: "administrative",
    severityFloor: floorOf("critical"),
    specSeverity: "critical",
    recipientResolver: "platform_security_owner",
    resolverArgs: { slaTierDays: 30 },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    ruleKey: "dsar_export.sla_escalation_30d.compliance",
    eventType: "m34.dsar_export.requested",
    category: "administrative",
    severityFloor: floorOf("warn"), // distinct floor for the (org,event,floor) unique index
    specSeverity: "critical",
    recipientResolver: "compliance_officer_for_tenant",
    resolverArgs: { orgIdPath: "orgId", slaTierDays: 30 },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 14. tenant_export.oversized_hold — m34.tenant_export.oversized_hold → platform-ops (error). GAP-098.
  //
  // NOT in the §4.8 table: the SEC-052 oversized hold predates this rule and the spec never gave it an
  // alert. It needs one because the hold is INVISIBLE otherwise — the job stays `generating`, the hold
  // lives only in the ledger, and the release route (GAP-097) takes a job id nothing hands out.
  //
  // ROUTED AT M36's BUILT-IN `role_set`, NOT at M34's `platform_security_owner`. Two reasons, and the
  // second is the one that decided it:
  //
  //  1. (historical — GAP-057 has since bound `registerM34AlertResolvers` at boot) the resolvers were
  //     unregistered when this rule was written. M36's registry THROWS
  //     `UnknownRecipientResolverError` on an unknown name, so a rule naming either M34 resolver would
  //     make the emit that matched it fail, not deliver.
  //  2. `platformSecurityOwners` is PLATFORM-scoped by contract ("independent of the alert's emit-org"),
  //     but `AlertEmitter.emit` is org-scoped and the notification rows it writes live in the emit-org.
  //     How a platform-scoped recipient reads an org-scoped notification is a real unanswered question,
  //     and inventing an answer here would be a bigger decision than this gap.
  //
  // `role_set` is an M36 built-in whose recipient source is a real `membership_role → role` join
  // (GAP-096), and `platform_ops` is an ORG-SCOPED role in this codebase (`role.organization_id`; see
  // scripts/db/seed-org-admin.ts). So this resolves to the platform-ops staff who hold a membership in
  // the tenant whose export is held — real people, through machinery that already works.
  {
    ruleKey: "tenant_export.oversized_hold",
    eventType: "m34.tenant_export.oversized_hold",
    category: "administrative",
    severityFloor: floorOf("error"),
    specSeverity: "error",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: [TENANT_ALERT_AUDIENCE_ROLE_KEY] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // 15. tenant.onboarding_activation_stuck - m34.tenant.onboarding_activation_stuck -> platform-ops (warn).
  //
  // NOT in the §4.8 table. The onboarding sweep retries `onboarding -> active` daily and a refused guard (tasks not
  // settled, no executed BAA, BAA within 90 days of expiry) only logs; after 3 consecutive identical refusals the
  // sweep emits this so a tenant stuck in `onboarding` surfaces to a person. Routed at the built-in `role_set` over
  // `platform_ops` for the same reason as `tenant_export.oversized_hold` above.
  // LOCKED (unlike oversized_hold): it is emitted under the tenant's own org, so without the lock a tenant admin's
  // PATCH /api/v1/alert-rules/:id could clone it with another resolver and redirect it away from platform ops.
  // The platform row's system_locked makes migration 0334's trigger and selectEffectiveAlertRules refuse any
  // org row that changes the resolver, lowers the severity or disables it.
  {
    ruleKey: "tenant.onboarding_activation_stuck",
    eventType: "m34.tenant.onboarding_activation_stuck",
    category: "administrative",
    severityFloor: floorOf("warn"),
    specSeverity: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: [TENANT_ALERT_AUDIENCE_ROLE_KEY] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  // §4.1/§4.7 kill-switch toggle — `severity=critical`. The kill-switch store emits this under the ACTING
  // platform-ops operator's own organization (a global flag has no org of its own, and the operator holds
  // no membership in the flag's tenant), so `role_set` over `platform_ops` reaches the platform staff in
  // that org — the same real-people machinery as the oversized-hold rule above. The affected scope rides
  // in the payload (`orgId`, null = platform-global).
  {
    ruleKey: "feature_flag.platform_emergency_changed",
    eventType: "m34.feature_flag.platform_emergency_changed",
    category: "system",
    severityFloor: "critical",
    specSeverity: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: [PLATFORM_OPS_ROLE_KEY] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
];

/** M36's built-in recipient resolvers (the registry's seven names). */
export const M36_BUILT_IN_RESOLVERS: readonly string[] = [
  "care_team",
  "on_call",
  "discipline",
  "role_set",
  "tenant_admins",
  "user_list",
  "broadcast",
];

/**
 * The rules the boot persister UPSERTs (GAP-057): ALL of them. M34's two resolvers are registered onto M36's
 * recipient-resolver registry at boot (`m34ResolverExtension`, bound in `apps/backend/src/index.ts`), so a rule
 * naming either resolves instead of throwing `UnknownRecipientResolverError`. Kept as a function so callers
 * and the seed test have one name for "what gets seeded".
 */
export const seedableM34AlertRules = (): readonly M34AlertRuleSeed[] => M34_ALERT_RULES;

/** The sixteen distinct §4.8 rule keys (the canonical key set, before platform-ops companion rows). */
export const M34_ALERT_RULE_KEYS = [
  "tenant.onboarding_step_blocked_5d",
  "tenant.onboarding_overdue",
  "tenant.onboarding_completed",
  "tenant.suspension_initiated",
  "tenant.offboarding_initiated",
  "tenant.retention_approaching_30d",
  "tenant.retention_approaching_7d",
  "tenant.shred_pending_approval",
  "tenant.shred_executed",
  "support_session.started",
  "dsar_export.sla_escalation_20d",
  "dsar_export.sla_escalation_27d",
  "dsar_export.sla_escalation_30d",
  "tenant_export.oversized_hold",
  "tenant.onboarding_activation_stuck",
  "feature_flag.platform_emergency_changed",
] as const;

// BOOT WIRING (GAP-057, done): `apps/backend/src/index.ts` registers `registerM34AlertResolvers` onto the
//   emitter's registry (via `AlertEmitterPorts.extendResolvers`, ports from `alert-resolver-ports.ts`) and
//   `wireM34AlertRuleSeed` UPSERTs every `M34_ALERT_RULES` row as an M36 platform-default `alert_rule`.
// TODO(M36 severity ladder, D17): the §4.8 `error` tier floors to `critical` on `alert_rule`'s
//   three-level `alert_severity` pgEnum. `specSeverity` carries the §4.8 value losslessly; if M36
//   widens the legacy ladder, re-project `severityFloor` from `specSeverity` (drop the `floorOf` fold).
// NOTE(unique index, §3.6): `alert_rule_unique (organization_id, event_type, severity_floor)` admits
//   only one row per (org,event,floor). The multi-audience §4.8 keys are therefore seeded as a primary
//   row + a `.platform_ops`/`.security_owner`/`.compliance` companion row at a DISTINCT floor so both
//   resolvers fire for one emitted event. If M36 later models a composed multi-resolver rule, collapse
//   the companions.
