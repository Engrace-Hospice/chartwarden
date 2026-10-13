// apps/backend/src/bootstrap/feature-flag-store.ts — M1 Foundation §3.10/§3.11 — the Drizzle-backed
// `feature_flag` READER and the platform-side `FeatureFlagAdmin` seam (M34 §4.7 / D13 delegates to it).
//
// F-091. `feature_flag` had NO READER AND NO WRITER anywhere in the running system:
//
//   • READ — `createDefaultFeatureFlagReader()` (routes/system.ts) answers `{}` for every org, and the
//     composition root never passed a `featureFlagReader`, so `GET /api/v1/system/feature-flags` served
//     an empty map to every tenant on every deployment. Four more consumers read the same fact through
//     structurally identical ports and got the same empty map or no reader at all: M22's `documents.doclens`
//     DocLens gate, M38's `ai.full` semantic-search gate, M16's bereavement Layer-2 ladder and M32's AI
//     invocation pipeline. Every capability flag on the platform therefore read FALSE, always.
//   • WRITE — M34's three platform-ops admin routes are mounted and reach `FeatureFlagAdminPort`, which
//     the production wiring binds to a stub that THROWS `M34InfraPortUnbound` on all three methods. So
//     the surface that exists to turn a flag on answered 5xx.
//
// Both halves being dead is what made it invisible: a flag that cannot be set and a flag that reads off
// are indistinguishable from a Phase-1 capability that is *correctly* off. The table, the four governance
// kinds, the five-key permission family, the `feature_flag_write_authority` ABAC predicate, the admin
// screen and the kill switch were all inert, and nothing could tell.
//
// WHAT IS BOUND HERE: the reader (every consumer), plus `list`, `upsert` and `setKillSwitch` on the admin
// seam. `setKillSwitch` is the audited §4.7 emergency control: it needs the platform-context + outbox +
// alert + audit ports (`FeatureFlagKillSwitchPorts`) and refuses (501) on a boot that has none.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, eq, isNull, or } from "drizzle-orm";

/** Reader port over `feature_flag` — the resolved boolean map for one org. M1 owns this shape; M22/M38/
 *  M16/M32 each re-declare it structurally so no consumer takes a dependency edge on the bootstrap. */
export interface FeatureFlagReaderPort {
  forOrg(orgId: string): Promise<Record<string, boolean>>;
}

/** One `feature_flag` row, narrowed to the columns resolution reads. */
export interface FeatureFlagResolutionRow {
  readonly flagKey: string;
  readonly organizationId: string | null;
  readonly valueType: string;
  readonly value: unknown;
  readonly rolloutPercent: number | null;
  readonly targeting: unknown;
  readonly killSwitchActive: boolean;
  readonly expiresAt: Date | null;
}

/**
 * Resolve a set of `feature_flag` rows to the boolean map the consumers read. PURE — the live reader is
 * this function plus one SELECT, so every rule below is unit-testable without a database.
 *
 * SCOPE PRECEDENCE. A tenant-scoped row (`organization_id = <org>`) wins OUTRIGHT over the platform-global
 * (org-NULL) row of the same key, and if it yields no opinion the key is simply ABSENT — the global row is
 * never consulted as a fallback. A tenant row is a deliberate per-tenant decision; letting an expiring
 * tenant override silently hand the key back to the platform default would turn "this tenant's override
 * lapsed" into "the platform re-enabled it here", which is the opposite of what an operator setting an
 * override is asking for.
 *
 * VALUE RULES, applied to the winning row:
 *   • `kill_switch_active` ⇒ FALSE, unconditionally and first. The schema calls this "returns false
 *     regardless of other config and bypasses any caching"; there is no cache here, so the second half is
 *     satisfied by construction (see `createDrizzleFeatureFlagReader`).
 *   • expired (`expires_at` non-null and at/before `now`) ⇒ ABSENT. §3.10 specifies the post-expiry
 *     behaviour as "no-op (returns default)" for migration flags — this is what prevents a migration flag
 *     from becoming permanent technical debt — and expiry is applied to any kind that carries the column,
 *     because a flag that has passed its own stated end date is not evidence of anything.
 *   • `value_type <> 'bool'` ⇒ ABSENT. The port carries booleans. Coercing a string/number/json to one
 *     would fail OPEN on the most likely value (a non-empty string is truthy), which is the wrong direction
 *     for a capability gate. A non-boolean flag is not readable through this port, and says so by absence.
 *   • `rollout_percent` non-null, or a non-empty `targeting` list ⇒ ABSENT. Both make the value a function
 *     of a SUBJECT (§3.10: "percentage of users (or tenants if global)"), and `forOrg(orgId)` carries no
 *     subject. Bucketing an org-scoped rollout by org would resolve every percentage to 0% or 100% for the
 *     whole tenant — a number that looks like a rollout and is not one. Absent is fail-closed and true.
 *   • otherwise ⇒ `value === true`.
 */
export function resolveFeatureFlags(
  rows: readonly FeatureFlagResolutionRow[],
  now: Date,
): Record<string, boolean> {
  const winners = new Map<string, FeatureFlagResolutionRow>();
  for (const row of rows) {
    const held = winners.get(row.flagKey);
    // A tenant row displaces a global one. Two rows of the SAME scope cannot exist —
    // `feature_flag_key_org_idx` is UNIQUE on (flag_key, organization_id), and since migration 0237
    // that holds for the global scope too (`NULLS NOT DISTINCT`; before it, duplicate org-NULL rows
    // for one key were legal and this loop's winner would have been whichever the scan returned last).
    if (!held || (held.organizationId === null && row.organizationId !== null)) {
      winners.set(row.flagKey, row);
    }
  }

  const resolved: Record<string, boolean> = {};
  for (const [flagKey, row] of winners) {
    if (row.killSwitchActive) {
      resolved[flagKey] = false;
      continue;
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) continue;
    if (row.valueType !== "bool") continue;
    if (row.rolloutPercent !== null) continue;
    if (Array.isArray(row.targeting) && row.targeting.length > 0) continue;
    resolved[flagKey] = row.value === true;
  }
  return resolved;
}

// A read-only path: `app.user_id` feeds ONLY the M4 write-audit trigger attribution, and a SELECT fires no
// trigger. The M7/M13/M33 seam-store convention for the same situation.
const FEATURE_FLAG_READER_SYSTEM_USER_ID = "";

/**
 * ONE key read from the PLATFORM-GLOBAL (`organization_id IS NULL`) row ALONE, never merged with a tenant row.
 * `forOrg` lets a tenant-scoped row of the same key win over the global one; a platform KILL SWITCH must not be
 * overridable that way (ADR-0058 "Enablement and kill switches" 5), so that consumer selects the org-NULL row directly and
 * passes just that row through {@link resolveFeatureFlags}: kill-switch, expiry, value-type, rollout and targeting
 * semantics stay identical to every other flag. Absent row = off. A read error propagates (the caller fails closed).
 * `contextOrgId` only supplies the RLS context (policy `feature_flag_org_read` exposes the global rows to any tenant).
 */
export async function readPlatformGlobalFlag(
  db: DbClient,
  contextOrgId: string,
  flagKey: string,
): Promise<{ readonly enabled: boolean; readonly updatedAt: Date | null }> {
  const T = schema.featureFlags;
  const rows = await withOrgContext(
    db,
    { organizationId: contextOrgId, userId: FEATURE_FLAG_READER_SYSTEM_USER_ID },
    async (tx) =>
      tx
        .select({
          flagKey: T.flagKey,
          organizationId: T.organizationId,
          valueType: T.valueType,
          value: T.value,
          rolloutPercent: T.rolloutPercent,
          targeting: T.targeting,
          killSwitchActive: T.killSwitchActive,
          expiresAt: T.expiresAt,
          updatedAt: T.updatedAt,
        })
        .from(T)
        .where(and(eq(T.flagKey, flagKey), isNull(T.organizationId)))
        .limit(1),
  );
  const row = rows[0];
  if (!row) return { enabled: false, updatedAt: null };
  return {
    enabled: resolveFeatureFlags([row], new Date())[flagKey] === true,
    updatedAt: row.updatedAt,
  };
}

/**
 * The production `FeatureFlagReader` — the org's own flags plus the platform-global (org-NULL) ones,
 * read on the TENANT pool inside `withOrgContext` so migration 0002's `feature_flag_org_read` policy is
 * the isolation floor rather than this WHERE clause. The predicate is stated anyway: RLS is the backstop,
 * not the query planner's only instruction.
 *
 * DELIBERATELY UNCACHED. A kill switch's contract (§3.10) is that it "bypasses any caching", and the read
 * is one indexed SELECT of a handful of rows on a surface nobody calls in a hot loop — a TTL cache here
 * would buy nothing and would make the one flag kind whose whole purpose is to take effect NOW take effect
 * a TTL later.
 */
export function createDrizzleFeatureFlagReader(db: DbClient): FeatureFlagReaderPort {
  const T = schema.featureFlags;
  return {
    async forOrg(orgId) {
      const rows = await withOrgContext(
        db,
        { organizationId: orgId, userId: FEATURE_FLAG_READER_SYSTEM_USER_ID },
        async (tx) =>
          tx
            .select({
              flagKey: T.flagKey,
              organizationId: T.organizationId,
              valueType: T.valueType,
              value: T.value,
              rolloutPercent: T.rolloutPercent,
              targeting: T.targeting,
              killSwitchActive: T.killSwitchActive,
              expiresAt: T.expiresAt,
            })
            .from(T)
            .where(or(eq(T.organizationId, orgId), isNull(T.organizationId))),
      );
      return resolveFeatureFlags(rows, new Date());
    },
  };
}

// ── the platform-side admin seam (M34 §4.7 / D13 delegates to it) ─────────────────────────────────────

/** One flag as the M34 admin surface projects it. Structurally M34's `FeatureFlagView`; declared here so
 *  the bootstrap takes no dependency edge on M34 (M1 `dependsOn` is `[]`). */
export interface FeatureFlagAdminView {
  readonly id: string;
  readonly flagKey: string;
  readonly organizationId: string | null;
  readonly flagKind: string;
  readonly valueType: string;
  readonly value: unknown;
  readonly rolloutPercent: number | null;
  readonly killSwitchActive: boolean;
  readonly updatedAt: string;
}

/** Structurally M34's `UpsertFeatureFlagArgs`. */
export interface FeatureFlagUpsertArgs {
  readonly flagKey: string;
  readonly organizationId: string | null;
  readonly flagKind: string;
  readonly valueType: string;
  readonly value: unknown;
  readonly rolloutPercent: number | null;
  readonly rationale: string | null;
}

/** Structurally M34's `SetKillSwitchArgs`. */
export interface FeatureFlagKillSwitchArgs {
  readonly flagKey: string;
  /** The flag's SCOPE: the owning org, or `null` for a platform-global flag. */
  readonly organizationId: string | null;
  readonly killSwitchActive: boolean;
  /** The acting operator's own (session) organization — the org the emergency alert/outbox row is emitted
   *  under, because a global flag has no org of its own. Server-derived, never from the body. */
  readonly actorOrganizationId: string;
  /** The acting operator's session membership, when the session carries one. */
  readonly actorMembershipId: string | null;
}

/** Structurally M34's `FeatureFlagAdminPort` (§4.7 / D13). */
export interface FeatureFlagAdminAccess {
  list(
    organizationId: string | null,
    flagKind: string | undefined,
  ): Promise<readonly FeatureFlagAdminView[]>;
  upsert(actorUserId: string, args: FeatureFlagUpsertArgs): Promise<FeatureFlagAdminView>;
  setKillSwitch(
    actorUserId: string,
    args: FeatureFlagKillSwitchArgs,
  ): Promise<FeatureFlagAdminView>;
}

/** The catalogued outbox event + alert event type the kill switch raises (M34 §4.7/§4.9). */
export const KILL_SWITCH_EVENT_NAME = "m34.feature_flag.platform_emergency_changed";

/** What the composition root injects so the kill switch can be the AUDITED emergency control §4.7 specifies.
 *  The bootstrap takes no dependency edge on M34/M36/M4: each carrier arrives as a port. */
export interface FeatureFlagKillSwitchPorts {
  /** Run `fn` in ONE audited platform-context transaction (the write, outbox row, audit and alert share it). */
  runPlatform<T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T>;
  /** Catalog-validated outbox publish over the same tx. */
  publish(
    tx: DbClient,
    input: {
      eventName: string;
      organizationId: string;
      aggregateKind: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void>;
  /** The `severity=critical` audit row (§7.4). */
  audit(
    tx: DbClient,
    event: {
      eventType: string;
      resourceId: string;
      correlationId: string;
      context: Record<string, unknown>;
    },
  ): Promise<void>;
  /** M36 `AlertEmitter.emit` — the critical `feature_flag.platform_emergency_changed` alert. */
  alert(
    organizationId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: "critical";
      correlationId: string;
    },
  ): Promise<unknown>;
  now?(): Date;
}

/**
 * Why `setKillSwitch` can still refuse: only on a boot WITHOUT the platform ports (a slice/no-platform
 * credential boot). Writing the switch without its alert would be strictly worse than refusing — an emergency
 * disable whose security owner is never told reports itself as having worked — so absent carriers fail closed.
 * (F-091 carried the older blocker: the payload required a non-null actorMembershipId and the alert seam an
 * orgId, which a platform operator toggling a global flag lacks. Resolved by widening the payload to carry
 * `actorUserId` with a nullable membership, and emitting under the operator's own org.)
 */
export const KILL_SWITCH_BLOCKED_REASON =
  "the §4.7 kill switch needs the audited platform ports (platform-context tx, outbox, M36 alert, audit); " +
  "none are bound on this boot. Use upsert to set the flag's value to false.";

/** Raised by `setKillSwitch` when no platform ports are bound — carries `KILL_SWITCH_BLOCKED_REASON`. */
export class FeatureFlagKillSwitchUnavailable extends Error {
  readonly code = "FEATURE_FLAG_KILL_SWITCH_UNAVAILABLE";
  readonly statusCode = 501;
  constructor() {
    super(KILL_SWITCH_BLOCKED_REASON);
    this.name = "FeatureFlagKillSwitchUnavailable";
  }
}

function adminView(row: typeof schema.featureFlags.$inferSelect): FeatureFlagAdminView {
  return {
    id: row.id,
    flagKey: row.flagKey,
    organizationId: row.organizationId,
    flagKind: row.flagKind,
    valueType: row.valueType,
    value: row.value,
    rolloutPercent: row.rolloutPercent,
    killSwitchActive: row.killSwitchActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The production `FeatureFlagAdmin` seam. Runs on the PLATFORM pool, which is not optional: migration
 * 0001's write policies never admit a NULL org (`WITH CHECK organization_id = app.org_id`), so a
 * platform-global flag is uncreatable from any tenant connection by design. A deployment with no platform
 * credential falls back to the tenant pool, where a global write is refused by RLS — fail-closed, and the
 * per-tenant writes still work.
 *
 * `list(null, …)` means NO ORG FILTER — global rows AND every tenant's — which is what the §4.1 route
 * documents ("platform-global + per-tenant") and the only reading its caller leaves available: the service
 * collapses an absent filter to null (`filter.organizationId ?? null`), so a null that meant "global only"
 * would make the unfiltered platform-ops listing look empty on a platform full of per-tenant flags.
 */
export function createDrizzleFeatureFlagAdmin(
  platformDb: DbClient,
  killSwitchPorts?: FeatureFlagKillSwitchPorts,
): FeatureFlagAdminAccess {
  const T = schema.featureFlags;
  return {
    async list(organizationId, flagKind) {
      const filters = [
        ...(organizationId !== null ? [eq(T.organizationId, organizationId)] : []),
        ...(flagKind !== undefined
          ? [eq(T.flagKind, flagKind as (typeof T.flagKind)["_"]["data"])]
          : []),
      ];
      const rows = await (filters.length > 0
        ? platformDb
            .select()
            .from(T)
            .where(and(...filters))
        : platformDb.select().from(T));
      return rows.map(adminView);
    },

    async upsert(actorUserId, args) {
      const values = {
        flagKey: args.flagKey,
        organizationId: args.organizationId,
        flagKind: args.flagKind as (typeof T.flagKind)["_"]["data"],
        valueType: args.valueType as (typeof T.valueType)["_"]["data"],
        value: args.value,
        rolloutPercent: args.rolloutPercent,
        rationale: args.rationale,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      };
      // Idempotent on the table's own uniqueness — (flag_key, organization_id). `killSwitchActive` is
      // deliberately NOT in the update set: an upsert is a configuration edit and must never clear an
      // active emergency disable as a side effect of someone editing the flag's value.
      const [row] = await platformDb
        .insert(T)
        .values(values)
        .onConflictDoUpdate({
          target: [T.flagKey, T.organizationId],
          set: {
            flagKind: values.flagKind,
            valueType: values.valueType,
            value: values.value,
            rolloutPercent: values.rolloutPercent,
            rationale: values.rationale,
            updatedBy: actorUserId,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error(`feature flag upsert returned no row for '${args.flagKey}'`);
      return adminView(row);
    },

    async setKillSwitch(actorUserId, args) {
      if (!killSwitchPorts) throw new FeatureFlagKillSwitchUnavailable();
      const ports = killSwitchPorts;
      const changedAt = (ports.now ?? (() => new Date()))();
      return ports.runPlatform("m34 platform-ops feature-flag kill switch", async (tx) => {
        // Exact-scope match: (flag_key, organization_id) — a same-key global row is never toggled in place
        // of an org's own row, nor the reverse. The kill switch never creates a row.
        const [row] = await tx
          .update(T)
          .set({
            killSwitchActive: args.killSwitchActive,
            updatedBy: actorUserId,
            updatedAt: changedAt,
          })
          .where(
            and(
              eq(T.flagKey, args.flagKey),
              args.organizationId === null
                ? isNull(T.organizationId)
                : eq(T.organizationId, args.organizationId),
            ),
          )
          .returning();
        if (!row) throw new NotFoundError("feature flag");
        const payload = {
          flagKey: row.flagKey,
          killSwitchActive: row.killSwitchActive,
          actorUserId,
          actorMembershipId: args.actorMembershipId,
          orgId: row.organizationId,
          changedAt: changedAt.toISOString(),
        };
        const correlationId = `${KILL_SWITCH_EVENT_NAME}:${row.id}:${changedAt.getTime()}`;
        // All three emissions are in the SAME tx as the write: if any carrier fails the flag does not flip
        // and the operator sees the failure — an emergency control must never report success unaudited.
        await ports.publish(tx, {
          eventName: KILL_SWITCH_EVENT_NAME,
          organizationId: args.actorOrganizationId,
          aggregateKind: "feature_flag",
          aggregateId: row.id,
          payload,
        });
        await ports.audit(tx, {
          eventType: "feature_flag.platform_emergency_changed",
          resourceId: row.id,
          correlationId,
          context: payload,
        });
        await ports.alert(args.actorOrganizationId, {
          eventType: KILL_SWITCH_EVENT_NAME,
          payload,
          severity: "critical",
          correlationId,
        });
        return adminView(row);
      });
    },
  };
}

/**
 * Every `feature_flag` row for one key (platform-global and per-tenant), read on the PLATFORM pool — the
 * fact source for M34's `feature_flag_write_authority` ABAC resolver. Only the owning org is projected: the
 * predicate needs scope, never the value. Errors propagate (the resolver turns them into a deny).
 */
export function createDrizzleFeatureFlagScopeLoader(
  platformDb: DbClient,
): (flagKey: string) => Promise<readonly { readonly organizationId: string | null }[]> {
  const T = schema.featureFlags;
  return (flagKey) =>
    platformDb.select({ organizationId: T.organizationId }).from(T).where(eq(T.flagKey, flagKey));
}
