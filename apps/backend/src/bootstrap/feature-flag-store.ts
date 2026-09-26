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
// WHAT IS BOUND HERE: the reader (every consumer), plus `list` and `upsert` on the admin seam.
// `setKillSwitch` REMAINS REFUSING, and deliberately — see the note on `KILL_SWITCH_BLOCKED_REASON`.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
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
  readonly organizationId: string | null;
  readonly killSwitchActive: boolean;
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

/**
 * WHY `setKillSwitch` STILL REFUSES, and why that is the correct binding rather than a gap.
 *
 * M34 §4.7 specifies the kill switch as an AUDITED EMERGENCY control: flipping it "raises the critical
 * `feature_flag.platform_emergency_changed` alert to the platform security owner", in-tx with the write.
 * Both carriers for that alert fail on precisely the flag that matters most — a PLATFORM-GLOBAL one:
 *
 *   • the catalogued outbox payload (`events-by-m34.ts`) requires a NON-NULL `actorMembershipId`, and a
 *     platform-ops operator toggling an org-NULL flag holds no membership in any tenant; and
 *   • M36's seam is `AlertEmitter.emit(orgId, …)` — it takes an org, and a global flag has none.
 *
 * Writing the switch without the alert would be strictly WORSE than refusing: an emergency disable whose
 * security owner is never told is an emergency control that reports itself as having worked. Refusing
 * leaves a working disable path — `upsert` sets the same flag's value to false — so nothing an operator
 * needs is unreachable; what is unreachable is the *audited* variant, which is the half that is genuinely
 * unbuilt. Fixing it means widening the payload (or the alert seam) to express an org-less platform actor,
 * which is a decision about the alert taxonomy, not about this store.
 */
export const KILL_SWITCH_BLOCKED_REASON =
  "the §4.7 kill switch must raise `m34.feature_flag.platform_emergency_changed` in-tx with the write; " +
  "the catalogued payload requires a non-null actorMembershipId and M36's AlertEmitter requires an orgId, " +
  "neither of which a platform-ops actor toggling a GLOBAL (org-NULL) flag has. Use upsert to set the " +
  "flag's value to false; the audited emergency variant needs an org-less alert carrier first (F-091).";

/** Raised by `setKillSwitch` — carries `KILL_SWITCH_BLOCKED_REASON` so the 5xx says what is missing. */
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
export function createDrizzleFeatureFlagAdmin(platformDb: DbClient): FeatureFlagAdminAccess {
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

    async setKillSwitch() {
      throw new FeatureFlagKillSwitchUnavailable();
    },
  };
}
