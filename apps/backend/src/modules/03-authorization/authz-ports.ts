// apps/backend/src/modules/03-authorization/authz-ports.ts — M3-T08 route dependency ports
// + slice in-memory adapters (M3 spec §4.3–4.4, §6, §7.4–7.6).
//
// The M3 `/api/v1/*` authorization routes (role catalog + assignment, break-glass, auditor
// engagements) are wired through injected ports, matching the M2-T06 identity-ports pattern:
// every external dependency is injected with a slice-safe in-memory default, so the route
// contract + the §7.4–7.6 acceptance criteria are provable with Fastify `inject` and no live
// infra.
//
// Production adapters (tracked follow-ups, the slice's forward-seam pattern):
//   • RoleStore / MembershipRoleStore → SELECT/INSERT/UPDATE on M3's own `role`,
//     `role_permission`, `membership_role` tables, run inside `withOrgContext` so RLS scopes
//     every statement by `app.org_id` (the bespoke template-read RLS admits the org-NULL
//     platform templates for reads; writes stay org-scoped — migrations 0009/0010).
//   • BreakGlassStore → INSERT/UPDATE on `break_glass_event`; `findActiveGrant` is the read
//     the §2.2 break-glass branch consults (wired into the contract by `contract.ts`).
//   • EngagementStore → INSERT/UPDATE on `auditor_engagement`; auditor enrollment calls M2's
//     boot-validated `AuditorSessionMinter` seam (D4 / §4.4) to mint the magic-link session.
//   • ComplianceNotifier → the `m3.breakglass.invoked` / `m3.engagement.*` OUTBOX path that
//     Module 36's alert rules subscribe to (SD-017: M3 never writes M36's `alert.new`
//     directly, and M36 is not an M3 dependency). Modeled here so the §7.4 "Compliance
//     notified" guarantee is assertable in the slice.
//
// None of M3's tables are PHI (they carry authorization metadata + a target *reference*, not
// a patient record), so the three-column / eraser PHI mandates do not attach to these routes;
// the org-scoped RLS backstop + the audit() trail + the meta-permission guards (§6) are the
// controls.
import type { AuditExecutor } from "@wardenx/audit";
import {
  ROLE_TEMPLATES,
  type RoleTemplate,
  type ScopeLevel,
  floorViolations,
  isSystemLocked,
} from "@wardenx/auth";

/** The role scope-level union (re-exported from @wardenx/auth for the route body cast). */
export type ScopeLevelInput = ScopeLevel;

// --- Roles & permissions -----------------------------------------------------------------

/** A role as the routes expose it (a platform template or an org's own/customized role). */
export interface RoleView {
  readonly roleId: string;
  /** `null` for a platform template; the org id for a tenant-owned/customized role. */
  readonly organizationId: string | null;
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly scopeLevel: ScopeLevel;
  readonly systemDefault: boolean;
  readonly systemLocked: boolean;
  readonly enabled: boolean;
  /** `true` once a tenant has renamed or edited a default role's permission set. */
  readonly customized: boolean;
  readonly permissionKeys: readonly string[];
}

/** A `system_locked` role cannot be deleted or stripped below its CoP floor (§3.4.1). */
export class RoleLockedError extends Error {
  constructor(
    readonly kind: "delete" | "floor",
    message: string,
    readonly strippedKeys: readonly string[] = [],
  ) {
    super(message);
    this.name = "RoleLockedError";
  }
}

/** Read/clone/edit roles. A tenant sees the ≈60 templates plus its own customized rows. */
export interface RoleStore {
  /** Templates (org-NULL) the tenant may clone, plus the org's own roles. */
  listForOrg(organizationId: string): Promise<RoleView[]> | RoleView[];
  get(roleId: string): Promise<RoleView | null> | RoleView | null;
  /** Clone/extend a template into a new org-owned custom role (§7.6). */
  createCustom(input: {
    organizationId: string;
    key: string;
    name: string;
    category: string;
    scopeLevel: ScopeLevel;
    clonedFromKey?: string;
    permissionKeys: readonly string[];
  }): Promise<RoleView> | RoleView;
  /**
   * Rename / enable-disable / edit the permission set. Enforces the `system_locked` floor:
   * a permission-set edit that would strip a CoP-required key throws RoleLockedError('floor').
   */
  update(
    roleId: string,
    patch: { name?: string; enabled?: boolean; permissionKeys?: readonly string[] },
  ): Promise<RoleView> | RoleView;
  /** Delete a custom role; a `system_locked` role throws RoleLockedError('delete'). */
  delete(roleId: string): Promise<void> | void;
}

// --- Membership role grants --------------------------------------------------------------

/** One role grant on a membership (the M2↔M3 handshake row), as the routes expose it. */
export interface MembershipRoleView {
  readonly grantId: string;
  readonly membershipId: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly scope: unknown;
  readonly expiresAt: string | null;
}

/** Assign / revoke role grants on a membership. */
export interface MembershipRoleStore {
  listForMembership(membershipId: string): Promise<MembershipRoleView[]> | MembershipRoleView[];
  assign(input: {
    organizationId: string;
    membershipId: string;
    roleId: string;
    roleKey: string;
    scope?: unknown;
    expiresAt?: string | null;
    grantedByUserId: string;
  }): Promise<MembershipRoleView> | MembershipRoleView;
  /** Revoke a grant; returns false if the (membership, role) grant did not exist. */
  revoke(membershipId: string, roleId: string): Promise<boolean> | boolean;
}

// --- Break-glass -------------------------------------------------------------------------

export type BreakGlassStatus = "active" | "cosign_pending" | "revoked" | "expired";

/** A break-glass event as the routes expose it (carries only a target *reference*, not PHI). */
export interface BreakGlassView {
  readonly eventId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly targetPatientId: string | null;
  readonly reason: string;
  readonly status: BreakGlassStatus;
  readonly cosignRequired: boolean;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/** A temporary bypass grant the §2.2 break-glass branch consults (`contract.ts`). */
export interface BreakGlassGrantRef {
  readonly eventId: string;
}

/** Invoke / co-sign / revoke / read break-glass events + the active-grant lookup. */
export interface BreakGlassStore {
  invoke(input: {
    organizationId: string;
    actorUserId: string;
    targetPatientId: string | null;
    reason: string;
    cosignRequired: boolean;
    ttlSeconds: number;
  }): Promise<BreakGlassView> | BreakGlassView;
  get(eventId: string): Promise<BreakGlassView | null> | BreakGlassView | null;
  cosign(eventId: string, byUserId: string): Promise<BreakGlassView> | BreakGlassView;
  revoke(eventId: string): Promise<BreakGlassView> | BreakGlassView;
  listForOrg(organizationId: string): Promise<BreakGlassView[]> | BreakGlassView[];
  /**
   * The active, unexpired bypass covering (actor, target) for this org — the read the §2.2
   * break-glass branch makes on every ABAC denial. Returns null when no glass is open. May be
   * async: the Drizzle store queries `break_glass_event`; the in-memory store stays synchronous.
   * The break-glass checker (contract.ts) awaits whichever it gets.
   */
  findActiveGrant(
    organizationId: string,
    actorUserId: string,
    targetPatientId: string | null,
    nowMs: number,
  ): Promise<BreakGlassGrantRef | null> | BreakGlassGrantRef | null;
}

// --- Auditor engagements -----------------------------------------------------------------

export type EngagementStatus = "scheduled" | "active" | "closed" | "cancelled";

/** An auditor engagement as the routes expose it. */
export interface EngagementView {
  readonly engagementId: string;
  readonly organizationId: string;
  readonly engagementType: string;
  readonly auditorAgency: string;
  readonly scope: unknown;
  readonly status: EngagementStatus;
  readonly startAt: string;
  readonly endAt: string;
}

/** The post-engagement report — who touched what (the survey-defensibility deliverable, §5.2). */
export interface EngagementSummary {
  readonly engagementId: string;
  readonly auditorsEnrolled: number;
  readonly resourcesTouched: number;
}

/** Create / edit / enroll-auditor / report on engagements. */
export interface EngagementStore {
  create(input: {
    organizationId: string;
    engagementType: string;
    auditorAgency: string;
    scope: unknown;
    startAt: string;
    endAt: string;
    createdByUserId: string;
  }): Promise<EngagementView> | EngagementView;
  get(engagementId: string): Promise<EngagementView | null> | EngagementView | null;
  update(
    engagementId: string,
    patch: { cancel?: boolean; endAt?: string },
  ): Promise<EngagementView> | EngagementView;
  recordAuditorEnrolled(engagementId: string): Promise<void> | void;
  summary(engagementId: string): Promise<EngagementSummary | null> | EngagementSummary | null;
}

/**
 * M3 calls M2's boot-validated `AuditorSessionMinter` seam to mint the time-boxed magic-link
 * (D4 / §4.4). Injected here (structurally the seam) so the slice supplies an in-memory minter
 * and production passes `getSeam("AuditorSessionMinter")`.
 */
export interface AuditorSessionMinterPort {
  mintAuditorSession(input: {
    engagementId: string;
    organizationId: string;
    identity: { name: string; email: string };
    window: { start: Date; end: Date };
  }): Promise<{ magicLinkToken: string }>;
}

/**
 * The `m3.breakglass.invoked` / `m3.engagement.*` OUTBOX path Module 36's alert rules
 * subscribe to (SD-017). M3 emits the event; M36 delivers the Compliance-Officer
 * notification. Modeled as an injected port so the slice can assert "Compliance notified".
 */
export interface ComplianceNotifier {
  notify(event: {
    kind: "breakglass.invoked" | "engagement.created";
    organizationId: string;
    resourceId: string;
    severity: "warn" | "critical";
  }): Promise<void> | void;
}

/** Resolves an actor's effective permission set — the anti-escalation check (§6) reads it. */
export type ActorPermissionResolver = (input: {
  organizationId: string;
  userId: string;
}) => Promise<ReadonlySet<string>> | ReadonlySet<string>;

/** The full injection surface for `registerAuthorizationRoutes`. */
export interface AuthzRouteDeps {
  roles: RoleStore;
  membershipRoles: MembershipRoleStore;
  breakGlass: BreakGlassStore;
  engagements: EngagementStore;
  auditorSessions: AuditorSessionMinterPort;
  notifier: ComplianceNotifier;
  /** Resolves the actor's effective permissions (anti-escalation + GET /me/permissions). */
  effectivePermissions: ActorPermissionResolver;
  /** Audit sink for the M3 lifecycle events (audit() executor — denylist runs there). */
  audit: AuditExecutor;
  /** Break-glass time-box in seconds (spec §3.5 default +4h, D1). */
  breakGlassTtlSec?: number;
}

// --- Slice in-memory adapters ------------------------------------------------------------

const templateByKey = new Map<string, RoleTemplate>(ROLE_TEMPLATES.map((t) => [t.key, t]));

/** Project a role template into a `RoleView` (org-NULL, floor = its locked permission set). */
function templateView(t: RoleTemplate): RoleView {
  return {
    roleId: `tmpl_${t.key}`,
    organizationId: null,
    key: t.key,
    name: t.name,
    category: t.category,
    scopeLevel: t.scopeLevel,
    systemDefault: t.systemDefault,
    systemLocked: t.systemLocked,
    enabled: true,
    customized: false,
    permissionKeys: [...t.floor],
  };
}

/**
 * In-memory role store seeded with the ≈60 platform templates (the floor-bearing subset
 * ships in @wardenx/auth). A tenant's customized/cloned roles are layered on top, keyed by id.
 */
export function createInMemoryRoleStore(): {
  store: RoleStore;
  all(organizationId: string): RoleView[];
} {
  const orgRows = new Map<string, RoleView>(); // org-owned roles keyed by roleId

  const store: RoleStore = {
    listForOrg(organizationId) {
      const templates = ROLE_TEMPLATES.map(templateView);
      const own = [...orgRows.values()].filter((r) => r.organizationId === organizationId);
      return [...templates, ...own];
    },
    get(roleId) {
      if (roleId.startsWith("tmpl_")) {
        const t = templateByKey.get(roleId.slice("tmpl_".length));
        return t ? templateView(t) : null;
      }
      return orgRows.get(roleId) ?? null;
    },
    createCustom(input) {
      const row: RoleView = {
        roleId: crypto.randomUUID(),
        organizationId: input.organizationId,
        key: input.key,
        name: input.name,
        category: input.category,
        scopeLevel: input.scopeLevel,
        systemDefault: false,
        systemLocked: false,
        enabled: true,
        customized: true,
        permissionKeys: [...input.permissionKeys],
      };
      orgRows.set(row.roleId, row);
      return row;
    },
    update(roleId, patch) {
      const current =
        orgRows.get(roleId) ??
        (roleId.startsWith("tmpl_")
          ? templateView(templateByKey.get(roleId.slice("tmpl_".length)) as RoleTemplate)
          : undefined);
      if (!current) throw new Error(`unknown role ${roleId}`);

      // Floor enforcement (§3.4.1): a permission-set edit may not strip a locked role's floor.
      if (patch.permissionKeys && isSystemLocked(current.key)) {
        const stripped = floorViolations(current.key, patch.permissionKeys);
        if (stripped.length > 0) {
          throw new RoleLockedError(
            "floor",
            `role '${current.key}' is system_locked; cannot strip CoP-required permission(s)`,
            stripped,
          );
        }
      }

      const next: RoleView = {
        ...current,
        name: patch.name ?? current.name,
        enabled: patch.enabled ?? current.enabled,
        permissionKeys: patch.permissionKeys ? [...patch.permissionKeys] : current.permissionKeys,
        // Editing a default role marks it customized + materializes an org-owned row.
        organizationId: current.organizationId,
        customized: true,
      };
      orgRows.set(roleId, next);
      return next;
    },
    delete(roleId) {
      const current = orgRows.get(roleId);
      const isTemplate = roleId.startsWith("tmpl_");
      const key = isTemplate ? roleId.slice("tmpl_".length) : current?.key;
      if (key && isSystemLocked(key)) {
        throw new RoleLockedError("delete", `role '${key}' is system_locked; cannot delete`);
      }
      if (isTemplate) {
        throw new RoleLockedError("delete", "platform templates are not tenant-deletable");
      }
      orgRows.delete(roleId);
    },
  };
  return { store, all: (organizationId) => store.listForOrg(organizationId) as RoleView[] };
}

/** In-memory membership-role store exposing grants for assertions. */
export function createInMemoryMembershipRoleStore(): {
  store: MembershipRoleStore;
  grantsFor(membershipId: string): MembershipRoleView[];
} {
  const grants = new Map<string, MembershipRoleView>(); // keyed by grantId
  const compositeKey = (membershipId: string, roleId: string) => `${membershipId}:${roleId}`;
  const byComposite = new Map<string, string>(); // (membership:role) → grantId

  const store: MembershipRoleStore = {
    listForMembership: (membershipId) =>
      [...grants.values()].filter((g) => g.membershipId === membershipId),
    assign(input) {
      const grant: MembershipRoleView = {
        grantId: crypto.randomUUID(),
        membershipId: input.membershipId,
        roleId: input.roleId,
        roleKey: input.roleKey,
        scope: input.scope ?? {},
        expiresAt: input.expiresAt ?? null,
      };
      grants.set(grant.grantId, grant);
      byComposite.set(compositeKey(input.membershipId, input.roleId), grant.grantId);
      return grant;
    },
    revoke(membershipId, roleId) {
      const grantId = byComposite.get(compositeKey(membershipId, roleId));
      if (!grantId) return false;
      grants.delete(grantId);
      byComposite.delete(compositeKey(membershipId, roleId));
      return true;
    },
  };
  return {
    store,
    grantsFor: (membershipId) =>
      [...grants.values()].filter((g) => g.membershipId === membershipId),
  };
}

/** In-memory break-glass store (the active-grant lookup powers the §2.2 break-glass branch). */
export function createInMemoryBreakGlassStore(): {
  store: BreakGlassStore;
  all(): BreakGlassView[];
} {
  const events = new Map<string, BreakGlassView>();

  const store: BreakGlassStore = {
    invoke(input) {
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + input.ttlSeconds * 1000);
      const event: BreakGlassView = {
        eventId: crypto.randomUUID(),
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        targetPatientId: input.targetPatientId,
        reason: input.reason,
        status: input.cosignRequired ? "cosign_pending" : "active",
        cosignRequired: input.cosignRequired,
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      events.set(event.eventId, event);
      return event;
    },
    get: (eventId) => events.get(eventId) ?? null,
    cosign(eventId, _byUserId) {
      const event = events.get(eventId);
      if (!event) throw new Error(`unknown break-glass event ${eventId}`);
      const next = { ...event, status: "active" as BreakGlassStatus };
      events.set(eventId, next);
      return next;
    },
    revoke(eventId) {
      const event = events.get(eventId);
      if (!event) throw new Error(`unknown break-glass event ${eventId}`);
      const next = { ...event, status: "revoked" as BreakGlassStatus };
      events.set(eventId, next);
      return next;
    },
    listForOrg: (organizationId) =>
      [...events.values()].filter((e) => e.organizationId === organizationId),
    findActiveGrant(organizationId, actorUserId, targetPatientId, nowMs) {
      for (const e of events.values()) {
        if (e.organizationId !== organizationId) continue;
        if (e.actorUserId !== actorUserId) continue;
        if (e.status !== "active") continue; // cosign_pending / revoked / expired do not grant
        if (Date.parse(e.expiresAt) <= nowMs) continue; // time-box elapsed
        // null target = scope-level glass (covers any target); else must match.
        if (e.targetPatientId !== null && e.targetPatientId !== targetPatientId) continue;
        return { eventId: e.eventId };
      }
      return null;
    },
  };
  return { store, all: () => [...events.values()] };
}

/** In-memory engagement store (tracks enrolled auditors + touched resources for the summary). */
export function createInMemoryEngagementStore(): {
  store: EngagementStore;
  all(): EngagementView[];
} {
  const rows = new Map<string, EngagementView>();
  const enrolled = new Map<string, number>();

  const store: EngagementStore = {
    create(input) {
      const row: EngagementView = {
        engagementId: crypto.randomUUID(),
        organizationId: input.organizationId,
        engagementType: input.engagementType,
        auditorAgency: input.auditorAgency,
        scope: input.scope,
        status: "scheduled",
        startAt: input.startAt,
        endAt: input.endAt,
      };
      rows.set(row.engagementId, row);
      enrolled.set(row.engagementId, 0);
      return row;
    },
    get: (engagementId) => rows.get(engagementId) ?? null,
    update(engagementId, patch) {
      const row = rows.get(engagementId);
      if (!row) throw new Error(`unknown engagement ${engagementId}`);
      const next: EngagementView = {
        ...row,
        status: patch.cancel ? "cancelled" : row.status,
        endAt: patch.endAt ?? row.endAt,
      };
      rows.set(engagementId, next);
      return next;
    },
    recordAuditorEnrolled(engagementId) {
      enrolled.set(engagementId, (enrolled.get(engagementId) ?? 0) + 1);
    },
    summary(engagementId) {
      if (!rows.has(engagementId)) return null;
      return {
        engagementId,
        auditorsEnrolled: enrolled.get(engagementId) ?? 0,
        resourcesTouched: 0, // populated from the break-glass + read-audit trail (M4/T10).
      };
    },
  };
  return { store, all: () => [...rows.values()] };
}

/** In-memory minter — records mints + returns a deterministic-shaped token (slice/test). */
export function createInMemoryAuditorSessionMinter(): {
  minter: AuditorSessionMinterPort;
  mints(): Array<{ engagementId: string; email: string }>;
} {
  const mints: Array<{ engagementId: string; email: string }> = [];
  return {
    minter: {
      mintAuditorSession(input) {
        mints.push({ engagementId: input.engagementId, email: input.identity.email });
        return Promise.resolve({ magicLinkToken: crypto.randomUUID() });
      },
    },
    mints: () => mints,
  };
}

/** In-memory Compliance notifier exposing delivered notifications for assertions. */
export function createInMemoryComplianceNotifier(): {
  notifier: ComplianceNotifier;
  delivered(): Array<{ kind: string; resourceId: string }>;
} {
  const delivered: Array<{ kind: string; resourceId: string }> = [];
  return {
    notifier: {
      notify(event) {
        delivered.push({ kind: event.kind, resourceId: event.resourceId });
      },
    },
    delivered: () => delivered,
  };
}

/** A fixed effective-permission resolver (slice/test) keyed by (orgId, userId). */
export function createFixedPermissionResolver(
  seed: Array<{ organizationId: string; userId: string; permissions: string[] }> = [],
): {
  resolver: ActorPermissionResolver;
  put(organizationId: string, userId: string, permissions: string[]): void;
} {
  const rows = new Map<string, Set<string>>();
  const key = (o: string, u: string) => `${o}:${u}`;
  for (const r of seed) rows.set(key(r.organizationId, r.userId), new Set(r.permissions));
  return {
    resolver: ({ organizationId, userId }) =>
      rows.get(key(organizationId, userId)) ?? new Set<string>(),
    put: (organizationId, userId, permissions) =>
      void rows.set(key(organizationId, userId), new Set(permissions)),
  };
}
