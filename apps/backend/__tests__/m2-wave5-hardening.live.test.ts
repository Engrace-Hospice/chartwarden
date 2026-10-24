/**
 * M2 wave-5 hardening — LIVE Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 *  1. `rescind` is org-bound: another org's invitation is neither rescinded nor reported rescinded, and
 *     the DB-level RLS already refuses it even when the caller names the foreign org (so the added
 *     `organization_id` predicate is defense in depth, not the only barrier).
 *  2. `pendingExists` is case-insensitive over rows stored before invite emails were normalized.
 *  3. `withAdminLock` serializes same-org critical sections on the real database (the last-admin
 *     check-then-act guard) while leaving other orgs unblocked.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m2:wave5-hardening:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbAdminMembershipReader } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InvitationStore, MembershipRepository } from "../src/modules/02-identity/identity-ports";
import { createDbInvitationStore } from "../src/modules/02-identity/identity-stores-db";
import { createDbMembershipRepository } from "../src/modules/02-identity/membership-repository";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f5050001";
const ORG_B = "22222222-2222-4222-8222-2222f5050002";
const USER = "44444444-4444-4444-8444-4444f5050004";

describe.skipIf(!DB_URL)("M2 wave-5 hardening — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let invitations: InvitationStore;
  let memberships: MembershipRepository;
  const asOrg = <T>(organizationId: string, fn: () => T): T =>
    runWithRequestContext({ organizationId, userId: USER } as never, fn);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'w5-a','Alpha LLC','Alpha','active'),($2,'w5-b','Beta LLC','Beta','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,'w5@test.test','W Five')`, [USER]);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    invitations = createDbInvitationStore(handle.db);
    memberships = createDbMembershipRepository(handle.db, createDbAdminMembershipReader(handle.db));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  const mint = (organizationId: string, email: string) =>
    invitations.create({
      organizationId,
      organizationName: "Org",
      email,
      proposedRoleKeys: [],
      defaultLocationIds: [],
    });
  const statusOf = async (id: string) =>
    (await admin.query("SELECT status FROM organization_invitation WHERE id=$1", [id])).rows[0]
      ?.status as string;

  it("rescind cannot touch another org's invitation, with or without naming the foreign org", async () => {
    const foreign = await mint(ORG_B, "b-only@w5.test");
    // Caller is bound to A and names A: org predicate refuses.
    expect(await asOrg(ORG_A, () => invitations.rescind(foreign.invitationId, ORG_A))).toBe(false);
    // Caller bound to A but names B: RLS (app.org_id = A) still refuses -> RLS alone covers it too.
    expect(await asOrg(ORG_A, () => invitations.rescind(foreign.invitationId, ORG_B))).toBe(false);
    expect(await statusOf(foreign.invitationId)).toBe("pending");
    // The owning org can.
    expect(await asOrg(ORG_B, () => invitations.rescind(foreign.invitationId, ORG_B))).toBe(true);
    expect(await statusOf(foreign.invitationId)).toBe("revoked");
  });

  it("pendingExists matches regardless of stored email case", async () => {
    await mint(ORG_A, "Mixed.Case@W5.test");
    expect(await invitations.pendingExists(ORG_A, "mixed.case@w5.test")).toBe(true);
    expect(await invitations.pendingExists(ORG_B, "mixed.case@w5.test")).toBe(false);
  });

  it("withAdminLock serializes same-org sections and does not block other orgs", async () => {
    let active = 0;
    let maxActive = 0;
    let counter = 0;
    const section = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const read = counter; // read-modify-write with a gap: lost updates if sections overlap
      await new Promise((r) => setTimeout(r, 25));
      counter = read + 1;
      active -= 1;
    };
    await Promise.all(Array.from({ length: 5 }, () => memberships.withAdminLock(ORG_A, section)));
    expect(maxActive).toBe(1);
    expect(counter).toBe(5);

    // A held ORG_A lock does not delay ORG_B.
    let releaseA: () => void = () => undefined;
    const heldA = memberships.withAdminLock(
      ORG_A,
      () => new Promise<void>((resolve) => (releaseA = resolve)),
    );
    await new Promise((r) => setTimeout(r, 50));
    await expect(memberships.withAdminLock(ORG_B, async () => "b-ran")).resolves.toBe("b-ran");
    releaseA();
    await heldA;
  });

  it("withAdminLock releases on error so a failed section does not wedge the org", async () => {
    await expect(
      memberships.withAdminLock(ORG_A, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(memberships.withAdminLock(ORG_A, async () => "ok")).resolves.toBe("ok");
  });
});
