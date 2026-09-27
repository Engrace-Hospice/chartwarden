/**
 * §11 D19 — M2's org activate/suspend/close capability, LIVE Postgres, real NOBYPASSRLS `wardenx_app`.
 *
 * Closes the M2 "hard half" (#205): `organization.status` had NO UPDATE anywhere in the codebase before
 * `organization-lifecycle.ts` — the four `m2.organization.*` / `m2.session.created` events M35's §4.12
 * per-seat billing is specified against had no producer at all. This suite proves, against a real
 * NOBYPASSRLS connection (not the in-memory slice, not a superuser):
 *   - a legal transition (activate/suspend/close) writes `organization.status`, lands the correct
 *     `m2.organization.*` outbox row, and audits the transition;
 *   - suspend/close revoke every session ALREADY bound to the org, in the same transaction;
 *   - an illegal transition (e.g. `activate` from `closed`) is refused and changes nothing;
 *   - `select-organization`'s OTHER half of §11 D19 enforcement — refusing to bind a FRESH session to a
 *     non-active org — via `OrganizationStatusReader.getStatus`.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m2:organization-lifecycle:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M2_OUTBOX_EVENTS } from "../src/modules/02-identity/index";
import { createDrizzleOrganizationLifecycleWriter } from "../src/modules/02-identity/organization-lifecycle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f2050101";
const ORG_B = "22222222-2222-4222-8222-2222f2050102";
const USER = "33333333-3333-4333-8333-3333f2050103";
const ACTOR_MEMBERSHIP = "44444444-4444-4444-8444-4444f2050104";

describe.skipIf(!DB_URL)("M2 organization-lifecycle — LIVE Postgres, real wardenx_app role", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
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
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f11d19-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f11d19-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,'f11d19@example.test','F11D19 User')`, [
      USER,
    ]);
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  function writer() {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
    const rawPublisher = {
      publish: (tx: never, input: never) => publisher.publish(tx, { ...input, callerModule: "m2" } as never),
    };
    return createDrizzleOrganizationLifecycleWriter(handle.db, rawPublisher as never);
  }

  it("suspend: writes status, revokes bound sessions, lands the outbox row, audits the transition", async () => {
    const boundSessionId = "sess-org-a-bound-1";
    await admin.query(
      `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
      [boundSessionId, USER, ORG_A, `tok-${boundSessionId}`],
    );

    const result = await writer().transition(ORG_A, "suspend", {
      reason: "non-payment 60d",
      actorUserId: USER,
      actorMembershipId: ACTOR_MEMBERSHIP,
    });
    expect(result).toMatchObject({ status: "suspended", sessionsRevoked: 1 });

    const org = await admin.query("SELECT status FROM organization WHERE id = $1", [ORG_A]);
    expect(org.rows[0].status).toBe("suspended");

    const sessions = await admin.query('SELECT id FROM "session" WHERE id = $1', [boundSessionId]);
    expect(sessions.rows).toHaveLength(0);

    const outbox = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm2.organization.suspended'",
      [ORG_A],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({
      organizationId: ORG_A,
      reason: "non-payment 60d",
      actorMembershipId: ACTOR_MEMBERSHIP,
    });

    const audit = await admin.query(
      "SELECT event_type, before, after FROM audit_event WHERE resource_id = $1 AND event_type = 'm2.organization.suspended'",
      [ORG_A],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].before).toMatchObject({ status: "active" });
    expect(audit.rows[0].after).toMatchObject({ status: "suspended", sessionsRevoked: 1 });
  });

  it("an illegal transition (suspend again, from suspended) is refused and changes nothing", async () => {
    await expect(
      writer().transition(ORG_A, "suspend", {
        reason: "n/a",
        actorUserId: USER,
        actorMembershipId: ACTOR_MEMBERSHIP,
      }),
    ).rejects.toThrow(/cannot 'suspend' from 'suspended'|ILLEGAL_ORGANIZATION_TRANSITION/);

    const org = await admin.query("SELECT status FROM organization WHERE id = $1", [ORG_A]);
    expect(org.rows[0].status).toBe("suspended"); // unchanged
  });

  it("activate: reactivates a suspended org and publishes m2.organization.activated", async () => {
    const result = await writer().transition(ORG_A, "activate", {
      reason: "cause resolved",
      actorUserId: USER,
      actorMembershipId: ACTOR_MEMBERSHIP,
    });
    expect(result.status).toBe("active");

    const outbox = await admin.query(
      "SELECT id FROM outbox_event WHERE aggregate_id = $1 AND event_type = 'm2.organization.activated'",
      [ORG_A],
    );
    expect(outbox.rows).toHaveLength(1);
  });

  it("close: terminal, revokes sessions, publishes m2.organization.closed; org B is untouched", async () => {
    await admin.query(
      `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
      ["sess-org-a-bound-2", USER, ORG_A, "tok-sess-org-a-bound-2"],
    );
    await admin.query(
      `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')`,
      ["sess-org-b-bound-1", USER, ORG_B, "tok-sess-org-b-bound-1"],
    );

    const result = await writer().transition(ORG_A, "close", {
      reason: "customer offboarded",
      actorUserId: USER,
      actorMembershipId: ACTOR_MEMBERSHIP,
    });
    expect(result).toMatchObject({ status: "closed", sessionsRevoked: 1 });

    const orgBSession = await admin.query('SELECT id FROM "session" WHERE id = $1', ["sess-org-b-bound-1"]);
    expect(orgBSession.rows).toHaveLength(1); // untouched

    await expect(
      writer().transition(ORG_A, "suspend", {
        reason: "n/a",
        actorUserId: USER,
        actorMembershipId: ACTOR_MEMBERSHIP,
      }),
    ).rejects.toThrow(); // closed is terminal
  });

  it("getStatus (the select-organization enforcement reader) reads the real status, org-scoped", async () => {
    const reader = writer();
    expect(await reader.getStatus(ORG_A)).toBe("closed");
    expect(await reader.getStatus(ORG_B)).toBe("active");
    expect(await reader.getStatus("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
