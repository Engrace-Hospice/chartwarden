/**
 * M2's audit/outbox RLS bug — LIVE Postgres, real NOBYPASSRLS `wardenx_app` role.
 *
 * Found while wiring M2's outbox catalog (#205). `mountIdentityRoutes` (and
 * `mountDeviceAttestationRoutes`/`mountSessionStepUpRoutes`) constructed `audit: db` — a bare, non-org-
 * context Drizzle client — even though `audit/identity-audit.ts`'s own header says "production passes the
 * Drizzle transaction so the audit row commits atomically with the membership/invitation write".
 * `audit_event`'s RLS policy (`audit_event_org_append`, migration 0119) requires
 * `organization_id = current_setting('app.org_id', true)::uuid`, and nothing sets that GUC outside a
 * `withOrgContext` transaction — so a bare `db` insert could never satisfy it. Confirmed empirically: every
 * M2 mutation route's `audit()` call threw `new row violates row-level security policy for table
 * "audit_event"` — AFTER the underlying store write had already committed, so the route 500'd on a write
 * that had, in fact, succeeded, with no audit row ever written. `outbox_event` carries the identical
 * org-scoped RLS shape, so a naively-wired outbox publish would have failed the same way.
 *
 * THIS SUITE IS LIVE BY NECESSITY: the failure is an RLS refusal on a real NOBYPASSRLS connection, which
 * no in-memory audit sink and no superuser connection (the only prior thing to touch `mountIdentityRoutes`
 * live, `auth.live.test.ts`'s TEST-003) can exhibit.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m2:outbox-audit-rls:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { audit } from "@wardenx/audit";
import { createDbClient } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  createOrgScopedAuditExecutor,
  createOrgScopedIdentityOutbox,
} from "../src/modules/02-identity/identity-ports";
import { M2_OUTBOX_EVENTS } from "../src/modules/02-identity/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f2050001";
const ORG_B = "22222222-2222-4222-8222-2222f2050002";
const USER = "33333333-3333-4333-8333-3333f2050003";

describe.skipIf(!DB_URL)("M2 audit()/outbox RLS — LIVE Postgres, real wardenx_app role", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
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
         ($1,'f205-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f205-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email,name) VALUES ($1,'f205@example.test','F205 User')`,
      [USER],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("a bare `db` audit() insert is REFUSED by RLS as wardenx_app (proves the bug existed)", async () => {
    try {
      await audit(
        handle.db as never,
        { organizationId: ORG_A, userId: USER, actorKind: "user", correlationId: "repro" },
        {
          eventType: "m2.user.invited",
          resourceKind: "invitation",
          resourceId: "44444444-4444-4444-8444-4444f2050004",
          outcome: "success",
          retentionClass: "compliance",
          after: {},
        },
      );
      expect.unreachable("expected the bare-db insert to be refused by RLS");
    } catch (err) {
      // Drizzle wraps the Postgres error; the RLS refusal is on `cause`, not `message`.
      const cause = (err as { cause?: { message?: string } }).cause;
      expect(cause?.message ?? String(err)).toMatch(/row-level security/i);
    }
  });

  it("createOrgScopedAuditExecutor's wrapped audit() succeeds under real RLS", async () => {
    const executor = createOrgScopedAuditExecutor(handle.db);
    await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
      audit(
        executor,
        { organizationId: ORG_A, userId: USER, actorKind: "user", correlationId: "fixed" },
        {
          eventType: "m2.user.invited",
          resourceKind: "invitation",
          resourceId: "55555555-5555-4555-8555-5555f2050005",
          outcome: "success",
          retentionClass: "compliance",
          after: {},
        },
      ),
    );
    const rows = await admin.query(
      "SELECT organization_id, event_type FROM audit_event WHERE resource_id = $1",
      ["55555555-5555-4555-8555-5555f2050005"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ organization_id: ORG_A, event_type: "m2.user.invited" });
  });

  it("createOrgScopedIdentityOutbox's wrapped publish() lands a real outbox_event row under RLS, and org B cannot see it", async () => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
    const rawPublisher: Parameters<typeof createOrgScopedIdentityOutbox>[1] = {
      publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m2" }),
    };
    const outbox = createOrgScopedIdentityOutbox(handle.db, rawPublisher);
    const invitationId = "66666666-6666-4666-8666-6666f2050006";

    await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
      outbox.publish({
        eventName: "m2.user.invited",
        payload: { invitationId, organizationId: ORG_A },
        organizationId: ORG_A,
        aggregateKind: "organization_invitation",
        aggregateId: invitationId,
      }),
    );

    const rows = await admin.query(
      "SELECT organization_id, event_type, payload FROM outbox_event WHERE aggregate_id = $1",
      [invitationId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].organization_id).toBe(ORG_A);
    expect(rows.rows[0].event_type).toBe("m2.user.invited");
    expect(rows.rows[0].payload).toMatchObject({ invitationId, organizationId: ORG_A });

    // The isolation proof: org B's connection context cannot read org A's row.
    const asOrgB = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await asOrgB.connect();
    await asOrgB.query(`SELECT set_config('app.org_id', '${ORG_B}', false)`);
    const crossTenant = await asOrgB.query("SELECT id FROM outbox_event WHERE aggregate_id = $1", [
      invitationId,
    ]);
    expect(crossTenant.rows).toHaveLength(0);
    await asOrgB.end();
  });

  it("a schema-invalid payload is refused by the catalog and rolls back, even inside the fixed wrapper", async () => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M2_OUTBOX_EVENTS]));
    const rawPublisher: Parameters<typeof createOrgScopedIdentityOutbox>[1] = {
      publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m2" }),
    };
    const outbox = createOrgScopedIdentityOutbox(handle.db, rawPublisher);

    await expect(
      runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
        // m2.user.deactivated requires a non-empty `reason` — this payload omits it entirely.
        outbox.publish({
          eventName: "m2.user.deactivated",
          payload: { userId: USER },
          organizationId: ORG_A,
          aggregateKind: "user",
          aggregateId: USER,
        }),
      ),
    ).rejects.toThrow();
  });
});
