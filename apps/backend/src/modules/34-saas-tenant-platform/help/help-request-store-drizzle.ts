// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-store-drizzle.ts — the help-request store over Drizzle.
//
// `createDrizzleHelpRequestStore(tx)` binds the `HelpRequestStore` port to ONE open transaction; `createDrizzleHelpRequestRunner`
// opens that transaction the right way for each surface: the member's own `withOrgContext` (RLS on `app.org_id`, as the real
// NOBYPASSRLS app role) or an audited `withPlatformContext` on the BYPASSRLS carrier (an operator's Resolve, the inbox and the
// sweep). M34 owns every table touched here except the M1 spine read of the organization's slug, which the table-ownership gate
// sanctions. Migration 1482 holds the rules the database owns (the column grants, the pinned policies, the state CHECKs and the guard
// trigger); this file holds none of its own.
import { PLATFORM_GRANTABLE_ROLE_KEYS } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import type { LinkedHelpRequestPort } from "@chartwarden/saas-tenant-platform";
import {
  type PlatformBypassAuditor,
  getRequestContext,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PlatformHelpRequestFilter } from "./help-request-contract";
import type {
  HelpGrantRow,
  HelpPageAfter,
  HelpRequestRow,
  HelpRequestRunner,
  HelpRequestStore,
  LinkedRequestDefaults,
  PlatformHelpRequestRow,
} from "./help-request-store";

const R = schema.tenantHelpRequest;
const ACCOUNT = schema.tenantAccount;
const ORG = schema.organizations;
const GRANT = schema.supportConsentGrant;
const TEMPLATE = schema.onboardingTaskTemplate;

const LIVE_STATUSES = schema.TENANT_HELP_REQUEST_LIVE_STATUSES;
const ENDED_STATUSES = ["resolved", "cancelled"] as const;

/** `requested_at` at microsecond precision: the keyset cursor's anchor, so no two rows of one millisecond are skipped or repeated. */
const cursorTsOf = sql<string>`to_char(${R.requestedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request's own actor: the closer of a request when the cascade's caller did not name one (null outside a request, or a non-human). */
const ambientUserId = (): string | null => {
  const userId = getRequestContext()?.userId;
  return userId !== undefined && UUID_RE.test(userId) ? userId : null;
};

type HelpRequestRecord = typeof R.$inferSelect & { cursorTs: string };

const toRow = (r: HelpRequestRecord): HelpRequestRow => ({
  id: r.id,
  organizationId: r.organizationId,
  tenantAccountId: r.tenantAccountId,
  stepKey: r.stepKey,
  message: r.message,
  status: r.status,
  requestedByMembershipId: r.requestedByMembershipId,
  requestedByUserId: r.requestedByUserId,
  requestedAt: r.requestedAt,
  cursorTs: r.cursorTs,
  supportConsentGrantId: r.supportConsentGrantId,
  approvedByMembershipId: r.approvedByMembershipId,
  approvedAt: r.approvedAt,
  closedByActorKind: r.closedByActorKind,
  closedByUserId: r.closedByUserId,
  closedAt: r.closedAt,
  closeNote: r.closeNote,
});

/** `(requested_at, id) < cursor`: the rows after the last one the client saw, in (requested_at DESC, id DESC) order. */
const afterCursor = (after: HelpPageAfter | null) =>
  after
    ? sql`(${R.requestedAt}, ${R.id}) < (${after.cursorTs}::timestamptz, ${after.id}::uuid)`
    : undefined;

export function createDrizzleHelpRequestStore(
  tx: DbClient,
  now: () => Date = () => new Date(),
): HelpRequestStore {
  const columns = { ...getTableColumns(R), cursorTs: cursorTsOf };

  const byId = async (id: string): Promise<HelpRequestRow | null> => {
    const [row] = await tx.select(columns).from(R).where(eq(R.id, id)).limit(1);
    return row ? toRow(row) : null;
  };

  return {
    tx,

    async tenantAccountIdOf(organizationId) {
      const [row] = await tx
        .select({ id: ACCOUNT.id })
        .from(ACCOUNT)
        .where(eq(ACCOUNT.organizationId, organizationId))
        .limit(1);
      return row?.id ?? null;
    },

    // The wizard's question (`wizard-store-drizzle.ts` `isPlatformStaff`): SECURITY DEFINER holder read, platform-owned roles only.
    async isPlatformStaff(userId) {
      const holders = await tx.execute<{ user_id: string }>(
        sql`SELECT user_id FROM m34_platform_role_holders(ARRAY[${sql.join(
          PLATFORM_GRANTABLE_ROLE_KEYS.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[]) WHERE user_id = ${userId}::uuid`,
      );
      return holders.rows.length > 0;
    },

    async stepKeyExists(key) {
      const [row] = await tx
        .select({ key: TEMPLATE.key })
        .from(TEMPLATE)
        .where(eq(TEMPLATE.key, key))
        .limit(1);
      return row !== undefined;
    },

    async findLive(tenantAccountId) {
      const [row] = await tx
        .select(columns)
        .from(R)
        .where(and(eq(R.tenantAccountId, tenantAccountId), inArray(R.status, [...LIVE_STATUSES])))
        .limit(1);
      return row ? toRow(row) : null;
    },

    async listEnded(tenantAccountId, after, limit) {
      const rows = await tx
        .select(columns)
        .from(R)
        .where(
          and(
            eq(R.tenantAccountId, tenantAccountId),
            inArray(R.status, [...ENDED_STATUSES]),
            afterCursor(after),
          ),
        )
        .orderBy(desc(R.requestedAt), desc(R.id))
        .limit(limit);
      return rows.map(toRow);
    },

    async insert(input) {
      // Names only the columns the tenant role may INSERT (`tenantHelpRequestCreate`); the row is read back whole.
      const [created] = await tx
        .insert(schema.tenantHelpRequestCreate)
        .values({
          organizationId: input.organizationId,
          tenantAccountId: input.tenantAccountId,
          stepKey: input.stepKey,
          message: input.message,
          requestedByMembershipId: input.requestedByMembershipId,
          requestedByUserId: input.requestedByUserId,
        })
        .returning({ id: sql<string>`id` });
      const row = created ? await byId(created.id) : null;
      if (!row) throw new Error("tenant_help_request insert returned no row");
      return row;
    },

    async markApproved(id, approval) {
      const updated = await tx
        .update(R)
        .set({
          status: "approved",
          supportConsentGrantId: approval.grantId,
          approvedByMembershipId: approval.approvedByMembershipId,
          approvedAt: approval.approvedAt,
          updatedAt: approval.approvedAt,
        })
        .where(and(eq(R.id, id), eq(R.status, "open")))
        .returning({ id: R.id });
      return updated.length > 0 ? byId(id) : null;
    },

    // Under RLS `FOR UPDATE` only sees rows the UPDATE policy admits (a live request), so an ended request is read plainly: the
    // service answers it without writing.
    async findForUpdate(id) {
      const row = await byId(id);
      if (!row || (row.status !== "open" && row.status !== "approved")) return row;
      await tx.select({ id: R.id }).from(R).where(eq(R.id, id)).for("update");
      return byId(id);
    },

    async markClosed(id, closing) {
      const updated = await tx
        .update(R)
        .set({
          status: closing.to,
          closedByActorKind: closing.closedByActorKind,
          closedByUserId: closing.closedByUserId,
          closedAt: closing.closedAt,
          updatedAt: closing.closedAt,
          // The tenant role has no column grant on close_note, so a tenant close leaves it out of the statement altogether.
          ...(closing.closeNote === null ? {} : { closeNote: closing.closeNote }),
        })
        .where(and(eq(R.id, id), eq(R.status, closing.from)))
        .returning({ id: R.id });
      return updated.length > 0 ? byId(id) : null;
    },

    async grantsById(grantIds): Promise<ReadonlyMap<string, HelpGrantRow>> {
      if (grantIds.length === 0) return new Map();
      const rows = await tx
        .select({ id: GRANT.id, expiresAt: GRANT.expiresAt, revokedAt: GRANT.revokedAt })
        .from(GRANT)
        .where(inArray(GRANT.id, [...grantIds]));
      return new Map(rows.map((g) => [g.id, g]));
    },

    linkedRequests(defaults: LinkedRequestDefaults = {}): LinkedHelpRequestPort {
      return createLinkedHelpRequestPort(tx, now, defaults);
    },

    async listForPlatform(filter: PlatformHelpRequestFilter, after, limit) {
      const rows = await tx
        .select({ ...columns, orgSlug: ORG.slug, legalBusinessName: ACCOUNT.legalBusinessName })
        .from(R)
        .innerJoin(
          ACCOUNT,
          and(eq(ACCOUNT.id, R.tenantAccountId), eq(ACCOUNT.organizationId, R.organizationId)),
        )
        .innerJoin(ORG, eq(ORG.id, R.organizationId))
        .where(
          and(
            filter.statuses.length > 0 ? inArray(R.status, [...filter.statuses]) : undefined,
            filter.tenantAccountId ? eq(R.tenantAccountId, filter.tenantAccountId) : undefined,
            afterCursor(after),
          ),
        )
        .orderBy(desc(R.requestedAt), desc(R.id))
        .limit(limit);
      return rows.map(
        (r): PlatformHelpRequestRow => ({
          ...toRow(r),
          orgSlug: r.orgSlug,
          legalBusinessName: r.legalBusinessName,
        }),
      );
    },

    async findForPlatform(id) {
      const [row] = await tx
        .select({ ...columns, orgSlug: ORG.slug, legalBusinessName: ACCOUNT.legalBusinessName })
        .from(R)
        .innerJoin(
          ACCOUNT,
          and(eq(ACCOUNT.id, R.tenantAccountId), eq(ACCOUNT.organizationId, R.organizationId)),
        )
        .innerJoin(ORG, eq(ORG.id, R.organizationId))
        .where(eq(R.id, id))
        .limit(1);
      return row
        ? { ...toRow(row), orgSlug: row.orgSlug, legalBusinessName: row.legalBusinessName }
        : null;
    },

    async cancelStaleOpen(olderThan, at) {
      const cancelled = await tx
        .update(R)
        .set({
          status: "cancelled",
          closedByActorKind: "system",
          closedByUserId: null,
          closedAt: at,
          updatedAt: at,
        })
        .where(and(eq(R.status, "open"), sql`${R.requestedAt} < ${olderThan}`))
        .returning({ id: R.id });
      return cancelled.length;
    },

    async resolveGrantEnded(at) {
      const resolved = await tx.execute<{ id: string }>(sql`
        UPDATE tenant_help_request r
           SET status = 'resolved', closed_by_actor_kind = 'system', closed_by_user_id = NULL,
               closed_at = ${at}, updated_at = ${at}
          FROM support_consent_grant g
         WHERE g.id = r.support_consent_grant_id
           AND r.status = 'approved'
           AND (g.revoked_at IS NOT NULL OR g.expires_at <= ${at})
        RETURNING r.id`);
      return resolved.rows.length;
    },
  };
}

/**
 * The `LinkedHelpRequestPort` piece 7S's revoke cascade ends a grant's request through, bound to ONE transaction. It resolves the
 * `approved` request linked to the grant (a request with none, or one already ended, is a no-op returning null). The revoke input
 * carries neither the closer's user nor an operator's note, so `defaults` supply them; failing both, a human closer is the request's
 * own actor (the tenant role's policy pins the closer to the session user), and the system closes no user.
 */
export function createLinkedHelpRequestPort(
  tx: DbClient,
  now: () => Date = () => new Date(),
  defaults: LinkedRequestDefaults = {},
): LinkedHelpRequestPort {
  return {
    async resolveForRevokedGrant(input) {
      const note = input.note ?? defaults.note ?? null;
      const at = now();
      const closer =
        input.source === "system"
          ? null
          : (input.closedByUserId ?? defaults.closedByUserId ?? ambientUserId());
      const updated = await tx
        .update(R)
        .set({
          status: "resolved",
          closedByActorKind: input.source,
          closedByUserId: closer,
          closedAt: at,
          updatedAt: at,
          // The tenant role has no column grant on close_note: a note only ever rides an operator's Resolve.
          ...(note === null ? {} : { closeNote: note }),
        })
        .where(
          and(
            eq(R.supportConsentGrantId, input.grantId),
            eq(R.organizationId, input.organizationId),
            eq(R.status, "approved"),
          ),
        )
        .returning({ id: R.id });
      const row = updated[0];
      return row ? { helpRequestId: row.id } : null;
    },
  };
}

export interface DrizzleHelpRequestRunnerDeps {
  /** The tenant pool (the real NOBYPASSRLS app role). */
  readonly db: DbClient;
  /** The audited BYPASSRLS platform credential. */
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly platformJobId: string;
  readonly now?: () => Date;
}

export function createDrizzleHelpRequestRunner(
  deps: DrizzleHelpRequestRunnerDeps,
): HelpRequestRunner {
  const now = deps.now ?? (() => new Date());
  return {
    asMember<T>(
      ctx: { readonly organizationId: string; readonly userId: string },
      fn: (store: HelpRequestStore) => Promise<T>,
    ): Promise<T> {
      return withOrgContext<DbClient, T>(
        deps.db,
        { organizationId: ctx.organizationId, userId: ctx.userId },
        (tx) => fn(createDrizzleHelpRequestStore(tx, now)),
      );
    },
    asPlatform<T>(
      ctx: { readonly userId: string | null; readonly reason: string },
      fn: (store: HelpRequestStore) => Promise<T>,
    ): Promise<T> {
      return withPlatformContext<DbClient, T>(
        deps.platformDb,
        { jobId: deps.platformJobId, reason: ctx.reason, crossTenant: true },
        deps.auditBypass,
        async (tx) => {
          // The platform transaction acts for this operator: the row-audit trigger then names the person, not a NULL actor.
          await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId ?? ""}, true)`);
          return fn(createDrizzleHelpRequestStore(tx, now));
        },
      );
    },
  };
}
