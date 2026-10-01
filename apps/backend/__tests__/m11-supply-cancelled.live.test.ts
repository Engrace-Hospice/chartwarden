/**
 * F-166 (#248) — LIVE Postgres proof that M11's new `m21.supply_request.cancelled` binding
 * (`buildM11SupplyCancelledConsumer`, `outbox-consumers/m21-supply-cancelled.ts`) actually writes real
 * rows under RLS.
 *
 * `.cancelled` has TWO producers on the M21 side: (1) M11's own discharge cascade
 * (`11-orders/consumers/bindings.ts`, F-102) discontinues its order SYNCHRONOUSLY before it ever emits
 * `m11.order.supply_cancellation_requested`, so M21's reply always finds an already-terminal order; and
 * (2) `cancelSupplyRequest` (`21-supplies/routes/write-service-drizzle.ts`, `POST /supply-requests/:id/
 * cancel`) — a real staff route that never touches M11 at all. This suite proves the ONE consumer is
 * correct for BOTH: it releases the still-in-flight order on the second producer's path, and is a genuine
 * no-op on the first's (the order is already `discontinued` by construction).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m11:supply-cancelled:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M11_OUTBOX_EVENTS, type OrderWriteOutboxPort } from "../src/modules/11-orders/index";
import { buildM11SupplyCancelledConsumer } from "../src/modules/11-orders/outbox-consumers/m21-supply-cancelled";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

describe.skipIf(!DB_URL)(
  "F-166 — M11's m21.supply_request.cancelled consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let memberA: string;
    let consumer: ReturnType<typeof buildM11SupplyCancelledConsumer>;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    function makeOutbox(): OrderWriteOutboxPort {
      const catalog = new Map<string, unknown>(M11_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      return {
        async publish(tx, input) {
          if (!catalog.has(input.eventName)) {
            throw new Error(`test publisher: undeclared event ${input.eventName}`);
          }
          await (tx as typeof handle.db).execute(sql`
            INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
            VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                    ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
          `);
        },
      };
    }

    async function seedOrder(opts: {
      organizationId: string;
      providerEntityId: string;
      kind: string;
      status: string;
    }): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO order_record
           (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
            status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),$3,'v1','{}'::jsonb,$4,$5,
                 'rn_case_manager',$6)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.kind,
          opts.status,
          memberA,
          PHYSICIAN_MDM,
        ],
      );
      return rows[0].id as string;
    }

    async function orderRow(orderId: string) {
      const { rows } = await admin.query(
        `SELECT status, discontinued_at FROM order_record WHERE id = $1`,
        [orderId],
      );
      return rows[0];
    }

    async function discontinuationRows(orderId: string) {
      const { rows } = await admin.query(
        `SELECT reason, actor_membership_id, source_outbox_event_id FROM order_discontinuation
         WHERE order_record_id = $1`,
        [orderId],
      );
      return rows;
    }

    async function outboxRows(organizationId: string, eventType: string, aggregateId?: string) {
      const { rows } = await admin.query(
        aggregateId
          ? `SELECT payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2 AND aggregate_id=$3`
          : `SELECT payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2`,
        aggregateId ? [organizationId, eventType, aggregateId] : [organizationId, eventType],
      );
      return rows;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m11-supply-cancelled-a','M11 SC A','M11 SC A'),
                ($2,'m11-supply-cancelled-b','M11 SC B','M11 SC B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f166@x.test')`, [USER]);
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M11SC-A','Provider A','1300000001','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M11SC-B','Provider B','1300000002','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      memberA = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      consumer = buildM11SupplyCancelledConsumer({ db: handle.db, outbox: makeOutbox() });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("releases (discontinues) an active order when M21 cancels the request directly (never through M11's cascade)", async () => {
      const orderId = await seedOrder({
        organizationId: ORG_A,
        providerEntityId: providerA,
        kind: "supply",
        status: "active",
      });
      const eventId = "aaaaaaaa-2000-4000-8000-000000000001";

      await consumer.handle({
        id: eventId,
        organizationId: ORG_A,
        payload: { sourceOrderId: orderId },
      });

      const row = await orderRow(orderId);
      expect(row.status).toBe("discontinued");
      expect(row.discontinued_at).not.toBeNull();

      const discontinuations = await discontinuationRows(orderId);
      expect(discontinuations).toHaveLength(1);
      expect(discontinuations[0].reason).toBe("supply_request_cancelled");
      expect(discontinuations[0].actor_membership_id).toBeNull();
      expect(discontinuations[0].source_outbox_event_id).toBe(eventId);

      const events = await outboxRows(ORG_A, "m11.order.discontinued", orderId);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        orderId,
        reason: "supply_request_cancelled",
        actorMembershipId: null,
      });
    });

    it("releases a pending_signature order too — cascadeDiscontinue is legal there, unlike the human discontinue event", async () => {
      const orderId = await seedOrder({
        organizationId: ORG_A,
        providerEntityId: providerA,
        kind: "comfort_kit",
        status: "pending_signature",
      });
      await consumer.handle({
        id: "aaaaaaaa-2000-4000-8000-000000000002",
        organizationId: ORG_A,
        payload: { sourceOrderId: orderId },
      });
      expect((await orderRow(orderId)).status).toBe("discontinued");
    });

    it("is a true no-op when the order is already terminal — the M11-cascade-reply producer's case", async () => {
      const orderId = await seedOrder({
        organizationId: ORG_A,
        providerEntityId: providerA,
        kind: "dme",
        status: "discontinued",
      });
      await consumer.handle({
        id: "aaaaaaaa-2000-4000-8000-000000000003",
        organizationId: ORG_A,
        payload: { sourceOrderId: orderId },
      });
      expect((await orderRow(orderId)).status).toBe("discontinued");
      expect(await discontinuationRows(orderId)).toHaveLength(0);
      expect(await outboxRows(ORG_A, "m11.order.discontinued", orderId)).toHaveLength(0);
    });

    it("is a no-op when sourceOrderId is absent (a supply_request M21 opened itself, never linked to an M11 order)", async () => {
      await expect(
        consumer.handle({
          id: "aaaaaaaa-2000-4000-8000-000000000004",
          organizationId: ORG_A,
          payload: { sourceOrderId: null },
        }),
      ).resolves.toBeUndefined();
    });

    it("is idempotent on redelivery — a second delivery after discontinuation does not throw or double-emit", async () => {
      const orderId = await seedOrder({
        organizationId: ORG_A,
        providerEntityId: providerA,
        kind: "supply",
        status: "active",
      });
      const event = {
        id: "aaaaaaaa-2000-4000-8000-000000000005",
        organizationId: ORG_A,
        payload: { sourceOrderId: orderId },
      };
      await consumer.handle(event);
      await expect(consumer.handle(event)).resolves.toBeUndefined();
      expect(await discontinuationRows(orderId)).toHaveLength(1);
      expect(await outboxRows(ORG_A, "m11.order.discontinued", orderId)).toHaveLength(1);
    });

    it("does not cross tenants — org A's delivery cannot discontinue org B's order", async () => {
      const orderId = await seedOrder({
        organizationId: ORG_B,
        providerEntityId: providerB,
        kind: "supply",
        status: "active",
      });
      await consumer.handle({
        id: "aaaaaaaa-2000-4000-8000-000000000006",
        organizationId: ORG_A,
        payload: { sourceOrderId: orderId },
      });
      expect((await orderRow(orderId)).status).toBe("active"); // untouched by org A's delivery
    });
  },
);
