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
import { withOrgContext, withOrgContextFromRequest, withUserContext } from "@wardenx/tenancy";
import type { AdminMembershipReader } from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
import type {
  AccountStatus,
  MembershipRecord,
  MembershipRepository,
  MembershipStatus,
} from "./identity-ports";

// The wrapped user's display name / email / account status come from the M1-owned `user` table, and
// `lastLoginAt` from the most recent M1-owned `session` row — both joined in here (FB-T12). M2 reads
// these (dependsOn 1); they are org-scoped identity, not PHI, and `user`/`session` stay un-RLS'd
// (org context is applied at the app layer), so they read cleanly under wardenx_app.
const lastLoginExpr = sql<
  Date | string | null
>`(select max(${schema.sessions.createdAt}) from ${schema.sessions} where ${schema.sessions.userId} = ${schema.memberships.userId})`;

const MEMBERSHIP_COLUMNS = {
  membershipId: schema.memberships.id,
  userId: schema.memberships.userId,
  organizationId: schema.memberships.organizationId,
  organizationName: schema.organizations.displayName,
  status: schema.memberships.status,
  defaultLocationIds: schema.memberships.defaultLocationIds,
  displayName: schema.users.name,
  email: schema.users.email,
  accountStatus: schema.users.status,
  lastLoginAt: lastLoginExpr,
} as const;

interface MembershipDbRow {
  membershipId: string;
  userId: string;
  organizationId: string;
  organizationName: string;
  status: MembershipStatus;
  defaultLocationIds: unknown;
  displayName: string | null;
  email: string;
  accountStatus: AccountStatus;
  lastLoginAt: Date | string | null;
}

/** Normalize a timestamptz (Date or already-string) to an ISO string, preserving null. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: MembershipDbRow, adminIds: ReadonlySet<string>): MembershipRecord {
  return {
    membershipId: row.membershipId,
    userId: row.userId,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    status: row.status,
    isAdmin: adminIds.has(row.membershipId),
    defaultLocationIds: Array.isArray(row.defaultLocationIds)
      ? (row.defaultLocationIds as string[])
      : [],
    displayName: row.displayName,
    email: row.email,
    accountStatus: row.accountStatus,
    lastLoginAt: toIso(row.lastLoginAt),
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
      // `q` matches the wrapped user's identity: name/email (joined), or the user_id (uuid → text,
      // since Postgres has no uuid ILIKE). FB-T11 staff facet, now extended to name/email (FB-T12).
      const where = needle
        ? and(
            eq(schema.memberships.organizationId, orgId),
            sql`(${schema.memberships.userId}::text ILIKE ${`%${needle}%`}
              OR ${schema.users.name} ILIKE ${`%${needle}%`}
              OR ${schema.users.email} ILIKE ${`%${needle}%`})`,
          )
        : eq(schema.memberships.organizationId, orgId);
      const rows = (await tx
        .select(MEMBERSHIP_COLUMNS)
        .from(schema.memberships)
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.memberships.organizationId),
        )
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
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
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.memberships.organizationId),
        )
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
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
      // to scope to. This used to run a plain Drizzle join under two PERMISSIVE `app.user_id` RLS
      // policies (migrations 0213/0214). Those policies could not stay narrow: PostgreSQL UNIONs every
      // permissive policy for a role, and `withOrgContext` sets `app.user_id` on ordinary requests too
      // for M4 audit attribution, so they widened EVERY org-scoped session into a cross-org read of
      // this user's memberships (F-001, #15 — reproduced live). Migration 0215 drops them and moves the
      // read behind `membership_pre_org_picker`, the ADR-0010 D2/D3-compliant SECURITY DEFINER pattern
      // migrations 0193/0194 already use: scope is the function's single argument, not a session GUC,
      // so nothing about it is reachable from an org-scoped request.
      //
      // `withUserContext` is kept so M4 audit attribution still stamps the acting user; the picker
      // itself no longer depends on the `app.user_id` GUC for visibility.
      const rows = await withUserContext(db, { userId }, async (tx) => {
        // db.execute() is a raw query, so Drizzle applies no column-type deserialization and no
        // camelCase aliasing — the row comes back snake_cased, with timestamptz as a string (the same
        // gotcha documented in 36-messaging/alert-emitter-drizzle.ts `preferencesFor`). `toIso` below
        // already accepts `Date | string`, so lastLoginAt needs no special-casing here.
        const result = await tx.execute<{
          membership_id: string;
          user_id: string;
          organization_id: string;
          organization_name: string;
          status: MembershipStatus;
          default_location_ids: unknown;
          display_name: string | null;
          email: string;
          account_status: AccountStatus;
          last_login_at: string | null;
        }>(sql`SELECT * FROM membership_pre_org_picker(${userId}::uuid)`);
        return result.rows.map(
          (r): MembershipDbRow => ({
            membershipId: r.membership_id,
            userId: r.user_id,
            organizationId: r.organization_id,
            organizationName: r.organization_name,
            status: r.status,
            defaultLocationIds: r.default_location_ids,
            displayName: r.display_name,
            email: r.email,
            accountStatus: r.account_status,
            lastLoginAt: r.last_login_at,
          }),
        );
      });
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
        tx
          .update(schema.memberships)
          .set({ status })
          .where(eq(schema.memberships.id, membershipId)),
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
