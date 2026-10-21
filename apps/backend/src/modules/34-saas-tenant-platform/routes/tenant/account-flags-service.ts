// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/account-flags-service.ts - M34 GAP-164.
//
// The tenant-scoped account read and the tenant feature-flag read/write (§4.1):
//   - GET  /tenant/account                    own `tenant_account` (RLS: the tenant's own org only)
//   - GET  /tenant/feature-flags              flags EFFECTIVE for this tenant (org row overrides the global row)
//   - POST /tenant/feature-flags/:flagKey     toggle a tenant-toggleable flag
// A flag is TENANT-TOGGLEABLE (the "platform floor") only when the tenant already has its own row for the key,
// the row is a boolean `product`/`rollout` flag, and no kill switch is active: a `kill_switch` / `migration`
// flag, a global-only flag, or an emergency-disabled flag is read-only to the tenant. The write goes through
// the same M1 `FeatureFlagAdmin` port the platform route uses (M34 never imports the flag schema).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ForbiddenError, NotFoundError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type { FeatureFlagView, UpsertFeatureFlagArgs } from "../platform/service";

export interface TenantAccountView {
  readonly tenantAccountId: string;
  readonly organizationId: string;
  readonly status: string;
  readonly planLabel: string;
  readonly legalBusinessName: string;
  readonly dbaName: string | null;
  readonly billingContactEmail: string;
  readonly breachNotificationEmail: string;
  readonly provisionedAt: string | null;
  readonly activatedAt: string | null;
  readonly createdAt: string;
}

export interface TenantFlagView {
  readonly flagKey: string;
  readonly flagKind: string;
  readonly valueType: string;
  readonly value: unknown;
  readonly rolloutPercent: number | null;
  readonly killSwitchActive: boolean;
  /** Where the effective value comes from. */
  readonly scope: "tenant" | "platform";
  /** The tenant may toggle this flag itself (POST /tenant/feature-flags/:flagKey). */
  readonly tenantToggleable: boolean;
  readonly updatedAt: string;
}

/** The slice of the M1 FeatureFlagAdmin port the tenant service needs. */
export interface TenantFlagAdminPort {
  list(
    organizationId: string | null,
    flagKind: string | undefined,
  ): Promise<readonly FeatureFlagView[]>;
  upsert(actorUserId: string, args: UpsertFeatureFlagArgs): Promise<FeatureFlagView>;
}

export interface TenantAccountFlagsService {
  getAccount(organizationId: string): Promise<TenantAccountView>;
  listFlags(organizationId: string): Promise<readonly TenantFlagView[]>;
  writeFlag(
    organizationId: string,
    actorUserId: string,
    flagKey: string,
    enabled: boolean,
  ): Promise<TenantFlagView>;
}

/** Flag kinds a tenant may ever toggle (the platform floor). */
export const TENANT_TOGGLEABLE_KINDS = ["product", "rollout"] as const;

/** PURE - the tenant's own row, when it is boolean, toggle-eligible and not emergency-disabled. */
export function isTenantToggleable(
  row: Pick<FeatureFlagView, "organizationId" | "flagKind" | "valueType" | "killSwitchActive">,
  organizationId: string,
): boolean {
  return (
    row.organizationId === organizationId &&
    (row.valueType === "bool" || row.valueType === "boolean") &&
    (TENANT_TOGGLEABLE_KINDS as readonly string[]).includes(row.flagKind) &&
    !row.killSwitchActive
  );
}

/**
 * PURE - fold the platform-wide rows + this tenant's rows into the EFFECTIVE set: the tenant's own row wins
 * over the global row of the same key; another tenant's rows never appear.
 */
export function effectiveFlags(
  rows: readonly FeatureFlagView[],
  organizationId: string,
): readonly TenantFlagView[] {
  const byKey = new Map<string, FeatureFlagView>();
  for (const row of rows) {
    if (row.organizationId !== null && row.organizationId !== organizationId) continue;
    const current = byKey.get(row.flagKey);
    if (!current || (current.organizationId === null && row.organizationId !== null)) {
      byKey.set(row.flagKey, row);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (a.flagKey < b.flagKey ? -1 : 1))
    .map((row) => ({
      flagKey: row.flagKey,
      flagKind: row.flagKind,
      valueType: row.valueType,
      value: row.value,
      rolloutPercent: row.rolloutPercent,
      killSwitchActive: row.killSwitchActive,
      scope: row.organizationId === null ? ("platform" as const) : ("tenant" as const),
      tenantToggleable: isTenantToggleable(row, organizationId),
      updatedAt: row.updatedAt,
    }));
}

async function writeFlagVia(
  flags: TenantFlagAdminPort,
  organizationId: string,
  actorUserId: string,
  flagKey: string,
  enabled: boolean,
): Promise<TenantFlagView> {
  const rows = await flags.list(null, undefined);
  const own = rows.find((r) => r.flagKey === flagKey && r.organizationId === organizationId);
  if (!own) {
    const global = rows.find((r) => r.flagKey === flagKey && r.organizationId === null);
    if (global)
      throw new ForbiddenError("this flag is platform-managed; the tenant cannot toggle it");
    throw new NotFoundError("feature_flag", flagKey);
  }
  if (!isTenantToggleable(own, organizationId)) {
    throw new ForbiddenError("this flag is not tenant-toggleable (kind, type or emergency state)");
  }
  const saved = await flags.upsert(actorUserId, {
    flagKey,
    organizationId,
    flagKind: own.flagKind,
    valueType: own.valueType,
    value: enabled,
    rolloutPercent: own.rolloutPercent,
    rationale: "tenant toggle",
  });
  const [view] = effectiveFlags([saved], organizationId);
  if (!view) throw new Error("tenant flag write produced no view");
  return view;
}

// ── in-memory twin ───────────────────────────────────────────────────────────────────────────────────

export function createInMemoryTenantAccountFlagsService(
  seed: {
    readonly accounts?: readonly TenantAccountView[];
    readonly flags?: readonly FeatureFlagView[];
  } = {},
): TenantAccountFlagsService {
  const accounts = [...(seed.accounts ?? [])];
  const flags = [...(seed.flags ?? [])];
  const port: TenantFlagAdminPort = {
    async list() {
      return flags;
    },
    async upsert(_actor, args) {
      const idx = flags.findIndex(
        (f) => f.flagKey === args.flagKey && f.organizationId === args.organizationId,
      );
      const base = flags[idx];
      const next: FeatureFlagView = {
        id: base?.id ?? `flag-${flags.length + 1}`,
        flagKey: args.flagKey,
        organizationId: args.organizationId,
        flagKind: args.flagKind,
        valueType: args.valueType,
        value: args.value,
        rolloutPercent: args.rolloutPercent,
        killSwitchActive: base?.killSwitchActive ?? false,
        updatedAt: new Date().toISOString(),
      };
      if (idx >= 0) flags[idx] = next;
      else flags.push(next);
      return next;
    },
  };
  return {
    async getAccount(organizationId) {
      const a = accounts.find((x) => x.organizationId === organizationId);
      if (!a) throw new NotFoundError("tenant_account", organizationId);
      return a;
    },
    async listFlags(organizationId) {
      return effectiveFlags(flags, organizationId);
    },
    writeFlag: (organizationId, actorUserId, flagKey, enabled) =>
      writeFlagVia(port, organizationId, actorUserId, flagKey, enabled),
  };
}

// ── Drizzle twin ─────────────────────────────────────────────────────────────────────────────────────

export function createDrizzleTenantAccountFlagsService(deps: {
  readonly db: DbClient;
  readonly flags: TenantFlagAdminPort;
}): TenantAccountFlagsService {
  return {
    async getAccount(organizationId) {
      return withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
        const A = schema.tenantAccount;
        const [a] = await tx.select().from(A).where(eq(A.organizationId, organizationId)).limit(1);
        if (!a) throw new NotFoundError("tenant_account", organizationId);
        return {
          tenantAccountId: a.id,
          organizationId: a.organizationId,
          status: a.status,
          planLabel: a.planLabel,
          legalBusinessName: a.legalBusinessName,
          dbaName: a.dbaName,
          billingContactEmail: a.billingContactEmail,
          breachNotificationEmail: a.breachNotificationEmail,
          provisionedAt: a.provisionedAt?.toISOString() ?? null,
          activatedAt: a.activatedAt?.toISOString() ?? null,
          createdAt: a.createdAt.toISOString(),
        };
      });
    },
    async listFlags(organizationId) {
      return effectiveFlags(await deps.flags.list(null, undefined), organizationId);
    },
    writeFlag: (organizationId, actorUserId, flagKey, enabled) =>
      writeFlagVia(deps.flags, organizationId, actorUserId, flagKey, enabled),
  };
}
