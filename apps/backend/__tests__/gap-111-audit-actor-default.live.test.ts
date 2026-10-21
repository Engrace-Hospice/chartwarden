/**
 * GAP-111 — write-audit actor attribution, LIVE Postgres, as the NOBYPASSRLS `wardenx_app` role.
 *
 * Route-level PHI writes call `withOrgContext(db, { organizationId, userId: "" }, …)`; the audit trigger
 * reads NULLIF(app.user_id,'')::uuid, so every such write used to record a NULL actor (§164.312(b)).
 * `withOrgContext` now resolves an empty `userId` to the ambient request actor (same org, authenticated),
 * and keeps "" for workers/relay ticks (no ambient request) or an explicit `systemActor`. One real
 * audited PHI write (`patient`, M5 — the same trigger family every M5-M18 route service writes through)
 * proves each branch against `audit_event.actor_user_id`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "mdm_canonical_writer",
];

const ORG_A = "11111111-1111-4111-8111-11110111a001";
const ORG_B = "22222222-2222-4222-8222-22220111b002";
const USER = "33333333-3333-4333-8333-33330111c003";

describe.skipIf(!DB_URL)("GAP-111 — withOrgContext defaults the audit actor", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let mrnSeq = 0;

  /** One audited PHI write through withOrgContext with the legacy `userId: ""`; returns the audit actor. */
  async function writeAndReadActor(
    org: string,
    ctx: { systemActor?: boolean },
    ambient?: { organizationId: string; userId: string },
  ): Promise<string | null> {
    const mrn = `G111-${++mrnSeq}`;
    const run = () =>
      withOrgContext(handle.db, { organizationId: org, userId: "", ...ctx }, async (tx) => {
        await tx.execute(
          sql`INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
              VALUES (${org}, ${mrn}, 'Gap', 'OneEleven', '1990-01-01', 'M', 'active')`,
        );
      });
    await (ambient ? runWithRequestContext(ambient, run) : run());
    const { rows } = await admin.query<{ actor_user_id: string | null }>(
      `SELECT a.actor_user_id FROM audit_event a
         JOIN patient p ON p.id = a.resource_id
        WHERE a.resource_kind = 'patient' AND a.event_type LIKE '%insert' AND p.mrn = $1`,
      [mrn],
    );
    expect(rows).toHaveLength(1);
    return rows[0]?.actor_user_id ?? null;
  }

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
      let ddl = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        ddl = ddl.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(ddl);
    }
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'g111-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'g111-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,'g111@example.test','G111')`, [
      USER,
    ]);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("records the request actor for a route-level write that passes userId ''", async () => {
    const actor = await writeAndReadActor(ORG_A, {}, { organizationId: ORG_A, userId: USER });
    expect(actor).toBe(USER);
  });

  it("records a NULL (system) actor outside a request — workers and relay ticks", async () => {
    expect(await writeAndReadActor(ORG_A, {})).toBeNull();
  });

  it("records a NULL actor when the ambient request belongs to another org", async () => {
    const actor = await writeAndReadActor(ORG_B, {}, { organizationId: ORG_A, userId: USER });
    expect(actor).toBeNull();
  });

  it("records a NULL actor under an explicit systemActor even inside a request", async () => {
    const actor = await writeAndReadActor(
      ORG_A,
      { systemActor: true },
      { organizationId: ORG_A, userId: USER },
    );
    expect(actor).toBeNull();
  });
});
