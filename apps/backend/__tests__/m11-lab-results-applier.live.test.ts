/**
 * GAP-016 — LIVE Postgres proof of the M29 -> M11 returned-lab handshake: M11's `LabResultsApplier`
 * (`outbox-consumers/m29-lab-results-applier.ts`) consumes `m29.lab_observation.attached`, flips
 * `order_record.results_status` to `results_received`, stamps `results_first_received_at` /
 * `last_lab_observation_attached_id`, and emits `m11.order.results_received` (+ `_critical`).
 *
 * Before this consumer existed `results_status` never left `awaiting_results`, `m11.order.results_received`
 * had no emit site (M22's lab-results render and every other consumer read a dead event), the lab-results
 * review queue (`resultsPendingReview`) was always empty, and the daily overdue sweep flipped every lab that
 * HAD come back to `results_overdue`. The suite drives the REAL catalog-validating transactional publisher
 * (`buildBootOutboxCatalog` / `buildTxOutboxPublisher`, not `NOOP_OUTBOX`) as the NOBYPASSRLS `chartwarden_app`
 * role, then reads the review queue through the real service and runs the real overdue sweep.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:lab-results-applier:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS, type OrderWriteOutboxPort } from "../src/modules/11-orders/index";
import { sweepLabResultsOverdue } from "../src/modules/11-orders/order-sweeps";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { buildM11LabResultsApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-results-applier";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const OBS_1 = "aaaaaaaa-5000-4000-8000-000000000001";
const OBS_2 = "aaaaaaaa-5000-4000-8000-000000000002";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const NOW = new Date("2026-10-08T12:00:00.000Z");

describe.skipIf(!DB_URL)(
  "GAP-016 — M11 LabResultsApplier (m29.lab_observation.attached) — LIVE",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let memberA: string;
    let consumer: ReturnType<typeof buildM11LabResultsApplierConsumer>;
    let outbox: OrderWriteOutboxPort;

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

    /** A signed, transmitted lab order awaiting results (the state every returned lab arrives against). */
    async function seedLabOrder(
      org: string,
      provider: string,
      signedAgoHours = 1,
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO order_record
         (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
          status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id, signed_at,
          priority)
       VALUES ($1,$2,$3,gen_random_uuid(),'lab','v1','{}'::jsonb,'active',$4,'rn_case_manager',$5,
               $6::timestamptz - make_interval(hours => $7), 'routine')
       RETURNING id`,
        [org, provider, PATIENT, memberA, PHYSICIAN_MDM, NOW.toISOString(), signedAgoHours],
      );
      await admin.query(
        "UPDATE order_record SET results_status='awaiting_results', transmission_status='transmitted' WHERE id=$1",
        [rows[0].id],
      );
      return rows[0].id as string;
    }

    const attached = (
      orderRecordId: string | null,
      observationId: string,
      abnormalFlag: string | null = null,
    ) => ({
      eventType: "m29.lab_observation.attached",
      organizationId: ORG_A,
      payload: {
        observationId,
        organizationId: ORG_A,
        patientId: PATIENT,
        orderRecordId,
        loincCode: "2345-7",
        abnormalFlag,
        observationDatetime: "2026-10-08T11:30:00.000Z",
      },
    });

    async function orderRow(id: string) {
      const { rows } = await admin.query(
        "SELECT results_status, results_first_received_at, last_lab_observation_attached_id FROM order_record WHERE id=$1",
        [id],
      );
      return rows[0];
    }
    async function events(org: string, type: string, aggregateId: string) {
      const { rows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2 AND aggregate_id=$3",
        [org, type, aggregateId],
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
       VALUES ($1,'m11-lab-results-a','M11 LR A','M11 LR A'),($2,'m11-lab-results-b','M11 LR B','M11 LR B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'gap016@x.test')`, [USER]);
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M11LR-A','Provider A','1300000013','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M11LR-B','Provider B','1300000014','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      memberA = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      // The REAL catalog-validating publisher: a payload that does not match the m11 catalog rolls the tx back.
      const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
      outbox = {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m11" }),
      };
      consumer = buildM11LabResultsApplierConsumer({ db: handle.db, outbox, now: () => NOW });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("flips results_status, stamps first-received + last observation, emits results_received (real catalog)", async () => {
      const orderId = await seedLabOrder(ORG_A, providerA);
      expect((await orderRow(orderId)).results_status).toBe("awaiting_results");

      await consumer.handle(attached(orderId, OBS_1));

      const row = await orderRow(orderId);
      expect(row.results_status).toBe("results_received");
      expect(row.last_lab_observation_attached_id).toBe(OBS_1);
      expect(new Date(row.results_first_received_at).toISOString()).toBe(NOW.toISOString());
      const received = await events(ORG_A, "m11.order.results_received", orderId);
      expect(received).toHaveLength(1);
      expect(received[0].payload).toMatchObject({
        orderId,
        organizationId: ORG_A,
        observationId: OBS_1,
        attachmentKind: "full",
        orderingPhysicianMdmId: PHYSICIAN_MDM,
      });
      // No critical flag -> no critical event.
      expect(await events(ORG_A, "m11.order.results_received_critical", orderId)).toHaveLength(0);
    });

    it("is idempotent on redelivery and keeps the FIRST received instant when a later observation arrives", async () => {
      const orderId = await seedLabOrder(ORG_A, providerA);
      await consumer.handle(attached(orderId, OBS_1));
      await consumer.handle(attached(orderId, OBS_1)); // redelivery: no second event
      expect(await events(ORG_A, "m11.order.results_received", orderId)).toHaveLength(1);

      const later = buildM11LabResultsApplierConsumer({
        db: handle.db,
        outbox,
        now: () => new Date("2026-10-09T08:00:00.000Z"),
      });
      await later.handle(attached(orderId, OBS_2)); // a further observation for the same order
      const row = await orderRow(orderId);
      expect(row.last_lab_observation_attached_id).toBe(OBS_2);
      expect(new Date(row.results_first_received_at).toISOString()).toBe(NOW.toISOString());
      expect(await events(ORG_A, "m11.order.results_received", orderId)).toHaveLength(2);
    });

    it("a critical (HH/LL) flag also emits results_received_critical; a plain abnormal flag does not", async () => {
      const critical = await seedLabOrder(ORG_A, providerA);
      await consumer.handle(attached(critical, OBS_1, "HH"));
      const crit = await events(ORG_A, "m11.order.results_received_critical", critical);
      expect(crit).toHaveLength(1);
      expect(crit[0].payload).toMatchObject({
        orderId: critical,
        observationId: OBS_1,
        criticalFlags: ["HH"],
        orderingPhysicianMdmId: PHYSICIAN_MDM,
      });

      const abnormal = await seedLabOrder(ORG_A, providerA);
      await consumer.handle(attached(abnormal, OBS_2, "H"));
      expect(await events(ORG_A, "m11.order.results_received", abnormal)).toHaveLength(1);
      expect(await events(ORG_A, "m11.order.results_received_critical", abnormal)).toHaveLength(0);
    });

    it("a result with no order, or naming another tenant's order, changes nothing (RLS)", async () => {
      await consumer.handle(attached(null, OBS_1)); // patient-bound, no order: nothing to flip
      const orderB = await seedLabOrder(ORG_B, providerB);
      await consumer.handle(attached(orderB, OBS_1)); // org A's event naming org B's order id
      const row = await orderRow(orderB);
      expect(row.results_status).toBe("awaiting_results");
      expect(row.last_lab_observation_attached_id).toBeNull();
      expect(await events(ORG_B, "m11.order.results_received", orderB)).toHaveLength(0);
    });

    it("the returned lab surfaces in the review queue and the overdue sweep no longer flags it", async () => {
      const returned = await seedLabOrder(ORG_A, providerA, 200); // signed long ago: past any expected-by
      const stillWaiting = await seedLabOrder(ORG_A, providerA, 200);
      await consumer.handle(attached(returned, OBS_1));

      const service = createDbOrderBackend(handle.db, outbox);
      const { orders: queue } = await service.resultsPendingReview(ORG_A);
      expect(queue.map((o) => o.id)).toContain(returned);
      expect(queue.map((o) => o.id)).not.toContain(stillWaiting);

      await sweepLabResultsOverdue({ db: handle.db, outbox, now: () => NOW } as never, ORG_A);
      expect((await orderRow(returned)).results_status).toBe("results_received");
      expect((await orderRow(stillWaiting)).results_status).toBe("results_overdue");
      expect(await events(ORG_A, "m11.order.results_overdue", returned)).toHaveLength(0);
    });

    it("a result that arrives AFTER the order was flagged overdue corrects it", async () => {
      const orderId = await seedLabOrder(ORG_A, providerA, 200);
      await sweepLabResultsOverdue({ db: handle.db, outbox, now: () => NOW } as never, ORG_A);
      expect((await orderRow(orderId)).results_status).toBe("results_overdue");
      await consumer.handle(attached(orderId, OBS_2));
      expect((await orderRow(orderId)).results_status).toBe("results_received");
    });
  },
);
