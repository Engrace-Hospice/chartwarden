/**
 * GAP-010 — a break-glass invocation DURABLY notifies Compliance, LIVE Postgres as `wardenx_app`.
 *
 * The production mount bound `createInMemoryComplianceNotifier` (a process-local array nothing read) and M3
 * published none of its spec'd outbox events. Now the break-glass store publishes `m3.breakglass.invoked`
 * through the REAL catalog-validating publisher in the invoke's own transaction. Proves, on a real database:
 *   1. invoke writes the grant AND an `m3.breakglass.invoked` outbox row (same tx, org-scoped under RLS);
 *   2. a payload that fails the catalog schema rolls the grant back (the row is atomic with the grant);
 *   3. revoke publishes `m3.breakglass.ended`;
 *   4. the M36 consumer, over the real dispatcher payload, emits a critical alert for the org;
 *   5. org B cannot see org A's outbox row.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m3:break-glass-outbox:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type M3OutboxPublisher,
  M3_OUTBOX_EVENTS,
  createDbBreakGlassStore,
} from "../src/modules/03-authorization/index";
import { buildM36BreakGlassAlertConsumer } from "../src/modules/36-messaging/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111111a01001";
const ORG_B = "11111111-1111-4111-8111-111111b01001";
const USER = "22222222-2222-4222-8222-222222a01001";
const COSIGNER = "22222222-2222-4222-8222-222222a01002";
const PATIENT = "33333333-3333-4333-8333-333333a01001";

describe.skipIf(!DB_URL)(
  "GAP-010 break-glass durable Compliance notification — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let store: ReturnType<typeof createDbBreakGlassStore>;

    // The REAL catalog-validating publisher, bound to caller module m3 exactly as the composition root does.
    const realPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M3_OUTBOX_EVENTS]));
    const publisher: M3OutboxPublisher = {
      publish: (tx, input) => realPublisher.publish(tx, { ...input, callerModule: "m3" }),
    };

    const asUser = <T>(userId: string, fn: () => T): T =>
      runWithRequestContext({ organizationId: ORG_A, userId } as never, fn);

    const invoke = () =>
      store.invoke({
        organizationId: ORG_A,
        actorUserId: USER,
        targetPatientId: PATIENT,
        reason: "covering nurse, chest pain emergency",
        cosignRequired: false,
        ttlSeconds: 4 * 3600,
      });

    const outboxRows = async (eventType: string) =>
      (
        await admin.query(
          "SELECT organization_id, payload, aggregate_id FROM outbox_event WHERE event_type=$1",
          [eventType],
        )
      ).rows;

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
      const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector)
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        await admin.query(sql);
      }
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'g010-a','A','A','active'),($2,'g010-b','B','B','active')",
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'u@g010.test'),($2,'c@g010.test')`,
        [USER, COSIGNER],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      store = createDbBreakGlassStore(handle.db, publisher);
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      await admin?.end();
    });

    beforeEach(async () => {
      await admin.query("DELETE FROM outbox_event");
      await admin.query("DELETE FROM break_glass_event");
    });

    it("invoke writes the grant AND an m3.breakglass.invoked outbox row for the org, carrying no free-text reason", async () => {
      const event = await asUser(USER, invoke);

      const rows = await outboxRows("m3.breakglass.invoked");
      expect(rows).toHaveLength(1);
      expect(rows[0].organization_id).toBe(ORG_A);
      expect(rows[0].aggregate_id).toBe(event.eventId);
      expect(rows[0].payload).toMatchObject({
        breakGlassId: event.eventId,
        organizationId: ORG_A,
        actorUserId: USER,
        targetPatientId: PATIENT,
        cosignRequired: false,
      });
      expect(JSON.stringify(rows[0].payload)).not.toContain("chest pain");
    });

    it("a publish failure rolls the grant back — the notification is atomic with the grant", async () => {
      const failing = createDbBreakGlassStore(handle.db, {
        publish: async () => {
          throw new Error("outbox down");
        },
      });
      await expect(
        asUser(USER, () =>
          failing.invoke({
            organizationId: ORG_A,
            actorUserId: USER,
            targetPatientId: PATIENT,
            reason: "covering nurse, chest pain emergency",
            cosignRequired: false,
            ttlSeconds: 3600,
          }),
        ),
      ).rejects.toThrow("outbox down");
      expect((await admin.query("SELECT 1 FROM break_glass_event")).rowCount).toBe(0);
    });

    it("revoke publishes m3.breakglass.ended", async () => {
      const event = await asUser(USER, invoke);
      await asUser(COSIGNER, () => Promise.resolve(store.revoke(event.eventId)));
      const rows = await outboxRows("m3.breakglass.ended");
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ breakGlassId: event.eventId, outcome: "revoked" });
    });

    it("the M36 consumer turns the REAL stored payload into a critical alert for the org", async () => {
      const event = await asUser(USER, invoke);
      const [row] = await outboxRows("m3.breakglass.invoked");
      const emit = vi.fn(async () => ({}));
      await buildM36BreakGlassAlertConsumer({ alerts: { emit } }).handle({
        eventType: "m3.breakglass.invoked",
        organizationId: row.organization_id,
        payload: row.payload,
      });
      expect(emit).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({
          eventType: "m3.breakglass.invoked",
          severity: "critical",
          correlationId: `m3.breakglass.invoked:${event.eventId}`,
        }),
      );
    });

    it("org B cannot read org A's outbox row (RLS as wardenx_app)", async () => {
      const event = await asUser(USER, invoke);
      const asOrgB = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await asOrgB.connect();
      try {
        await asOrgB.query(`SELECT set_config('app.org_id', '${ORG_B}', false)`);
        const seen = await asOrgB.query("SELECT id FROM outbox_event WHERE aggregate_id = $1", [
          event.eventId,
        ]);
        expect(seen.rows).toHaveLength(0);
      } finally {
        await asOrgB.end();
      }
    });
  },
);
