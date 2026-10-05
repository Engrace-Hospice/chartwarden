/**
 * F-097 — M3's `createDbProposedRoleAttacher`: the M2 §D3 handshake, against REAL Postgres as the
 * NOBYPASSRLS `wardenx_app` role.
 *
 * LIVE by necessity for three reasons the in-memory route test cannot reach:
 *   1. `membership_role_idx` is UNIQUE on (membership_id, role_id) — the idempotency of a replayed
 *      accept is a statement about that constraint, not about the code.
 *   2. Migration 0025 widened the `role` read policy to admit org-NULL platform TEMPLATE rows, so RLS
 *      alone does not mean "this org's roles". The explicit `organization_id` predicate is what does,
 *      and only a real policy can show the difference.
 *   3. Cross-tenant: two orgs may both hold a role with the same key, and the attach must grant the
 *      caller's.
 *
 * WARDENX_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m3-proposed-role-attach.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { registerDbEffectivePermissionResolver } from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbInvitationStore } from "../src/modules/02-identity/identity-stores-db";
import { createDbProposedRoleAttacher } from "../src/modules/03-authorization/proposed-role-attacher";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-1111-4000-8000-00000000000b";
const USER = "cccccccc-1111-4000-8000-00000000000c";
// GAP-008 — the INVITER: holds role.assign + patient.read (and member.invite) but NOT org.manage.
const INVITER = "dddddddd-1111-4000-8000-00000000000d";
const NO_ASSIGN_INVITER = "eeeeeeee-1111-4000-8000-00000000000e";

describe.skipIf(!DB_URL)("F-097 proposed-role attach — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let attacher: ReturnType<typeof createDbProposedRoleAttacher>;
  let membershipA = "";
  let rnRoleA = "";
  const roleIdsA = new Map<string, string>();

  const grantsFor = async (membershipId: string): Promise<string[]> => {
    const { rows } = await admin.query(
      `SELECT r.key FROM membership_role mr JOIN role r ON r.id = mr.role_id
        WHERE mr.membership_id = $1 ORDER BY r.key`,
      [membershipId],
    );
    return rows.map((r) => r.key as string);
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    for (const [id, slug] of [
      [ORG_A, "org-f097-a"],
      [ORG_B, "org-f097-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [id, slug, slug],
      );
    }
    await admin.query(
      "INSERT INTO \"user\" (id, email, name, status) VALUES ($1,'invitee@f097.test','Invitee','active')",
      [USER],
    );
    const mem = await admin.query(
      "INSERT INTO membership (organization_id, user_id, status) VALUES ($1,$2,'active') RETURNING id",
      [ORG_A, USER],
    );
    membershipA = mem.rows[0].id as string;

    // Org A holds `clinical_rn` and `org_admin`; org B holds a role with the SAME key, which must not
    // be reachable. `survey_coordinator` is the org-NULL PLATFORM template row migration 0025's read
    // policy admits — it exists, it is readable, and it must not be grantable into a tenant.
    // GAP-008: the roles carry real permissions so the inviter's ceiling means something. `org_admin`
    // includes `org.manage`, which the inviter lacks.
    for (const [key, resource, action] of [
      ["role.assign", "role", "assign"],
      ["member.invite", "member", "invite"],
      ["patient.read", "patient", "read"],
      ["org.manage", "org", "manage"],
    ] as const) {
      await admin.query(
        `INSERT INTO permission (key, resource, action, category) VALUES ($1,$2,$3,'admin')
         ON CONFLICT (key) DO NOTHING`,
        [key, resource, action],
      );
    }
    const rolePerms: Record<string, string[]> = {
      clinical_rn: ["patient.read"],
      org_admin: ["role.assign", "patient.read", "org.manage"],
      inviter_role: ["role.assign", "member.invite", "patient.read"],
      invite_only_role: ["member.invite", "patient.read"],
    };
    for (const [org, key] of [
      [ORG_A, "clinical_rn"],
      [ORG_A, "org_admin"],
      [ORG_A, "inviter_role"],
      [ORG_A, "invite_only_role"],
      [ORG_B, "clinical_rn"],
    ] as const) {
      const row = await admin.query(
        `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
         VALUES ($1,$2,$2,'clinical_staff','organization',true,'f097') RETURNING id`,
        [org, key],
      );
      const id = row.rows[0].id as string;
      if (org === ORG_A) {
        roleIdsA.set(key, id);
        if (key === "clinical_rn") rnRoleA = id;
        for (const perm of rolePerms[key] ?? []) {
          await admin.query(
            "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
            [ORG_A, id, perm],
          );
        }
      }
    }
    // Inviters: real memberships holding real roles, so the REAL resolver computes their ceiling.
    for (const [user, email, roleKey] of [
      [INVITER, "inviter@f097.test", "inviter_role"],
      [NO_ASSIGN_INVITER, "inviter2@f097.test", "invite_only_role"],
    ] as const) {
      await admin.query(
        "INSERT INTO \"user\" (id, email, name, status) VALUES ($1,$2,'Inviter','active')",
        [user, email],
      );
      const inviterMembership = await admin.query(
        "INSERT INTO membership (organization_id, user_id, status) VALUES ($1,$2,'active') RETURNING id",
        [ORG_A, user],
      );
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG_A, inviterMembership.rows[0].id, roleIdsA.get(roleKey)],
      );
    }
    await admin.query(
      `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES (NULL,'survey_coordinator','Survey Coordinator','compliance_quality','organization',true,'platform template')`,
    );
    // A disabled role: present in the org, and not a grantable answer to a proposed key.
    await admin.query(
      `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES ($1,'retired_role','Retired','clinical_staff','organization',false,'f097')`,
      [ORG_A],
    );

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // The REAL effective-permission engine over the wardenx_app connection (the same resolver the
    // composition root hands the attacher), not a stub: the ceiling is computed from real grants.
    const rbac = registerDbEffectivePermissionResolver(handle.db);
    attacher = createDbProposedRoleAttacher(handle.db, ({ organizationId, userId }) =>
      rbac.resolver({ organizationId, userId } as Parameters<typeof rbac.resolver>[0]),
    );
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    // Only the invitee's grants: the inviters' own role grants are fixtures.
    await admin.query("DELETE FROM membership_role WHERE membership_id = $1", [membershipA]);
  });

  const attach = (
    roleKeys: readonly string[],
    organizationId = ORG_A,
    membershipId = membershipA,
    grantedByUserId: string | null = INVITER,
  ) => attacher.attach({ organizationId, membershipId, roleKeys, grantedByUserId });

  it("grants the org's roles for the keys it resolves", async () => {
    const result = await attach(["clinical_rn", "inviter_role"]);
    expect([...result.attached].sort()).toEqual(["clinical_rn", "inviter_role"]);
    expect(result.unresolved).toEqual([]);
    expect(await grantsFor(membershipA)).toEqual(["clinical_rn", "inviter_role"]);
  });

  // ── GAP-008: the attach is bounded by the INVITER's ceiling ────────────────────────────────────
  it("GAP-008 does NOT attach a role above the inviter's ceiling (org_admin needs org.manage)", async () => {
    const result = await attach(["clinical_rn", "org_admin"]);
    expect(result.attached).toEqual(["clinical_rn"]);
    expect(result.unresolved).toEqual(["org_admin"]);
    expect(await grantsFor(membershipA)).toEqual(["clinical_rn"]);
  });

  it("GAP-008 records the INVITER as granted_by, not the invitee", async () => {
    await attach(["clinical_rn"]);
    const { rows } = await admin.query(
      "SELECT granted_by FROM membership_role WHERE membership_id=$1",
      [membershipA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].granted_by).toBe(INVITER);
  });

  it("GAP-008 an inviter who no longer holds role.assign attaches nothing", async () => {
    const result = await attach(["clinical_rn"], ORG_A, membershipA, NO_ASSIGN_INVITER);
    expect(result.attached).toEqual([]);
    expect(result.unresolved).toEqual(["clinical_rn"]);
    expect(await grantsFor(membershipA)).toEqual([]);
  });

  it("GAP-008 a legacy/deleted inviter (null) has no ceiling, so nothing attaches", async () => {
    const result = await attach(["clinical_rn"], ORG_A, membershipA, null);
    expect(result.attached).toEqual([]);
    expect(result.unresolved).toEqual(["clinical_rn"]);
    expect(await grantsFor(membershipA)).toEqual([]);
  });

  it("GAP-008 the invitation store persists the inviter and returns it on peek and consume", async () => {
    const store = createDbInvitationStore(handle.db);
    const minted = await store.create({
      organizationId: ORG_A,
      organizationName: "Org A",
      email: "invitee-gap008@f097.test",
      proposedRoleKeys: ["clinical_rn"],
      defaultLocationIds: [],
      inviterId: INVITER,
    });
    const stored = await admin.query("SELECT inviter_id FROM organization_invitation WHERE id=$1", [
      minted.invitationId,
    ]);
    expect(stored.rows[0].inviter_id).toBe(INVITER);
    // peek/consume read by token hash with no org GUC (a pre-existing property of those two reads, not
    // of this change), so they are exercised over a privileged connection; `create` above ran under RLS.
    let consumed: Awaited<ReturnType<typeof store.consume>>;
    const privileged = createDbClient({ connectionString: DB_URL as string });
    try {
      const reader = createDbInvitationStore(privileged.db);
      expect((await reader.peek(minted.token)).inviterId).toBe(INVITER);
      consumed = await reader.consume(minted.token);
    } finally {
      await privileged.close();
    }
    expect(consumed.inviterId).toBe(INVITER);
    expect(consumed.proposedRoleKeys).toEqual(["clinical_rn"]);
  });

  it("GAP-008 a role edited upward AFTER the invite is re-bounded at accept", async () => {
    // clinical_rn gains org.manage between invite and accept; the inviter lacks it.
    const roleId = roleIdsA.get("clinical_rn") as string;
    await admin.query(
      "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,'org.manage')",
      [ORG_A, roleId],
    );
    try {
      const result = await attach(["clinical_rn"]);
      expect(result.attached).toEqual([]);
      expect(await grantsFor(membershipA)).toEqual([]);
    } finally {
      await admin.query(
        "DELETE FROM role_permission WHERE role_id=$1 AND permission_key='org.manage'",
        [roleId],
      );
    }
  });

  it("reports a key the org has no role for, and grants the rest", async () => {
    const result = await attach(["clinical_rn", "no_such_role"]);
    expect(result.attached).toEqual(["clinical_rn"]);
    expect(result.unresolved).toEqual(["no_such_role"]);
    expect(await grantsFor(membershipA)).toEqual(["clinical_rn"]);
  });

  it("a replayed accept grants nothing new and does not throw", async () => {
    // Accept is at-least-once: the invitation `consume` races atomically, and a retried job or a
    // double-submitted form reaches here twice. `onConflictDoNothing` over the UNIQUE
    // (membership_id, role_id) index is what makes the second run a no-op instead of a 500.
    await attach(["clinical_rn"]);
    const second = await attach(["clinical_rn"]);
    expect(second.attached).toEqual(["clinical_rn"]);
    expect(await grantsFor(membershipA)).toEqual(["clinical_rn"]);
  });

  it("does NOT grant the org-NULL platform template row", async () => {
    // Migration 0025 widened the role READ policy to admit org-NULL template rows, so RLS alone would
    // let this resolve. The explicit `organization_id = :org` predicate is the only thing standing
    // between a proposed key and a tenant silently acquiring a role it never created.
    const result = await attach(["survey_coordinator"]);
    expect(result.attached).toEqual([]);
    expect(result.unresolved).toEqual(["survey_coordinator"]);
    expect(await grantsFor(membershipA)).toEqual([]);
  });

  it("does not resolve a DISABLED role", async () => {
    const result = await attach(["retired_role"]);
    expect(result.unresolved).toEqual(["retired_role"]);
    expect(await grantsFor(membershipA)).toEqual([]);
  });

  it("grants THIS org's role when another tenant holds the same key", async () => {
    const result = await attach(["clinical_rn"]);
    expect(result.attached).toEqual(["clinical_rn"]);
    const { rows } = await admin.query(
      "SELECT role_id FROM membership_role WHERE membership_id=$1",
      [membershipA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role_id).toBe(rnRoleA); // org A's row, not org B's same-keyed one
  });

  it("de-duplicates repeated keys and ignores empty ones", async () => {
    const result = await attach(["clinical_rn", "clinical_rn", ""]);
    expect(result.attached).toEqual(["clinical_rn"]);
    expect(await grantsFor(membershipA)).toEqual(["clinical_rn"]);
  });

  it("an empty proposal touches the database not at all", async () => {
    const result = await attach([]);
    expect(result).toEqual({ attached: [], unresolved: [] });
    expect(await grantsFor(membershipA)).toEqual([]);
  });
});
