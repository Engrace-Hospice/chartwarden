// apps/backend/src/modules/02-identity — the PRODUCTION MembershipRepository (M2 §3, §6).
//
// The member-roster + lifecycle routes (GET /orgs/:id/members, PATCH/DELETE, accept-invite,
// select-organization) run through an injected MembershipRepository. This is the live Drizzle
// implementation over the M1-owned `membership` table (M2 may read it — dependsOn 1), joined to
// `organization` for the display name, run inside `withOrgContext` so RLS scopes by `app.org_id`.
//
// `isAdmin` (and `activeAdminCount`, for the last-admin lockout guard, §6) is an M3 fact — a membership
// holding an active `org_admin` grant — which M2 must NOT read from M3's tables directly. It comes from
// the injected `AdminMembershipReader` (the M3-owned `createDbAdminMembershipReader`).
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import type { AdminMembershipReader } from "@wardenx/types";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { MembershipRecord, MembershipRepository, MembershipStatus } from "./identity-ports";

const MEMBERSHIP_COLUMNS = {
  membershipId: schema.memberships.id,
  userId: schema.memberships.userId,
  organizationId: schema.memberships.organizationId,
  organizationName: schema.organizations.displayName,
  status: schema.memberships.status,
  defaultLocationIds: schema.memberships.defaultLocationIds,
} as const;

interface MembershipDbRow {
  membershipId: string;
  userId: string;
  organizationId: string;
  organizationName: string;
  status: MembershipStatus;
  defaultLocationIds: unknown;
}

function toRecord(row: MembershipDbRow, adminIds: ReadonlySet<string>): MembershipRecord {
  return {
    membershipId: row.membershipId,
    userId: row.userId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    status: row.status,
    isAdmin: adminIds.has(row.membershipId),
    defaultLocationIds: Array.isArray(row.defaultLocationIds) ? (row.defaultLocationIds as string[]) : [],
  };
}

/** Build the live MembershipRepository; `admin` (M3-owned) supplies the `org_admin` membership set. */
export function createDbMembershipRepository(
  db: DbClient,
  admin: AdminMembershipReader,
): MembershipRepository {
  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  const selectByOrg = (orgId: string, q?: string) =>
    withOrgContext(db, ctx(orgId), async (tx) => {
      // `q` (Global Search staff facet, FB-T11) narrows by the wrapped user's identity. RLS still
      // scopes the org; the ILIKE is an additional in-org filter (forward-compatible to name/email).
      const needle = q?.trim();
      // user_id is a uuid; cast to text for the substring match (Postgres has no uuid ILIKE).
      const where = needle
        ? and(
            eq(schema.memberships.organizationId, orgId),
            sql`${schema.memberships.userId}::text ILIKE ${`%${needle}%`}`,
          )
        : eq(schema.memberships.organizationId, orgId);
      const rows = (await tx
        .select(MEMBERSHIP_COLUMNS)
        .from(schema.memberships)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
        .where(where)) as MembershipDbRow[];
      const adminIds = await admin.adminMembershipIds(orgId);
      return rows.map((r) => toRecord(r, adminIds));
    });

  // Org-scoped by-id read: runs under the AMBIENT request org (withOrgContextFromRequest), so RLS
  // scopes by app.org_id under the real wardenx_app role — a bare `WHERE id=…` would return nothing
  // there. The route already requires the membership to be in the caller's org, so scoping to the
  // request org is exactly the intended semantics.
  const oneById = async (membershipId: string): Promise<MembershipRecord | null> =>
    withOrgContextFromRequest(db, async (tx) => {
      const rows = (await tx
        .select(MEMBERSHIP_COLUMNS)
        .from(schema.memberships)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
        .where(eq(schema.memberships.id, membershipId))
        .limit(1)) as MembershipDbRow[];
      const row = rows[0];
      if (!row) return null;
      const adminIds = await admin.adminMembershipIds(row.organizationId);
      return toRecord(row, adminIds);
    });

  return {
    listForOrg: (organizationId, q) => selectByOrg(organizationId, q),

    listForUser: async (userId) => {
      // Pre-org-bind (/auth/memberships): the user's memberships ACROSS orgs — there is no single org
      // to scope to. The org-only membership RLS policy can't express "my own memberships", so under
      // the real wardenx_app role this needs a `user_id = app.user_id` read policy (a follow-up); the
      // bare query below is correct only under a BYPASSRLS/platform connection.
      const rows = (await db
        .select(MEMBERSHIP_COLUMNS)
        .from(schema.memberships)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.organizationId))
        .where(eq(schema.memberships.userId, userId))) as MembershipDbRow[];
      // Admin status is per-org; resolve each org's admin set once.
      const orgIds = [...new Set(rows.map((r) => r.organizationId))];
      const adminByOrg = new Map<string, ReadonlySet<string>>();
      for (const orgId of orgIds) adminByOrg.set(orgId, await admin.adminMembershipIds(orgId));
      return rows.map((r) => toRecord(r, adminByOrg.get(r.organizationId) ?? new Set()));
    },

    findActive: async (userId, organizationId) => {
      const all = await selectByOrg(organizationId);
      return all.find((m) => m.userId === userId && m.status === "active") ?? null;
    },

    get: (membershipId) => oneById(membershipId),

    setStatus: async (membershipId, status) => {
      const existing = await oneById(membershipId);
      if (!existing) throw new Error(`membership ${membershipId} not found`);
      await withOrgContext(db, ctx(existing.organizationId), (tx) =>
        tx.update(schema.memberships).set({ status }).where(eq(schema.memberships.id, membershipId)),
      );
      return { ...existing, status };
    },

    setDefaultScope: async (membershipId, defaultLocationIds) => {
      const existing = await oneById(membershipId);
      if (!existing) throw new Error(`membership ${membershipId} not found`);
      await withOrgContext(db, ctx(existing.organizationId), (tx) =>
        tx
          .update(schema.memberships)
          .set({ defaultLocationIds })
          .where(eq(schema.memberships.id, membershipId)),
      );
      return { ...existing, defaultLocationIds };
    },

    create: async (input) =>
      withOrgContext(db, ctx(input.organizationId), async (tx) => {
        const inserted = (await tx
          .insert(schema.memberships)
          .values({
            userId: input.userId,
            organizationId: input.organizationId,
            status: "active",
            defaultLocationIds: input.defaultLocationIds,
          })
          .returning({ membershipId: schema.memberships.id })) as Array<{ membershipId: string }>;
        return {
          membershipId: inserted[0]!.membershipId,
          userId: input.userId,
          organizationId: input.organizationId,
          organizationName: input.organizationName,
          status: "active" as MembershipStatus,
          isAdmin: false, // a freshly created membership has no role grants yet
          defaultLocationIds: input.defaultLocationIds,
        };
      }),

    activeAdminCount: async (organizationId) => {
      const rows = await selectByOrg(organizationId);
      return rows.filter((m) => m.status === "active" && m.isAdmin).length;
    },
  };
}
