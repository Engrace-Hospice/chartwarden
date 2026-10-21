/**
 * F-15x (#248) — LIVE Postgres (+ Valkey) proof that M11's two new outbox-consumer bindings actually
 * write real rows under RLS:
 *
 *   - `buildM11AssessmentSuggestionConsumer` (`outbox-consumers/m9-assessment-significant-change.ts`) —
 *     the §2.7 D7 order-suggestion banner: `m9.assessment.significant_change` projects into Valkey under
 *     `wardenx:m11:orders:suggestion:<patientId>` and emits `m11.order.suggestion_state_changed`.
 *   - `buildM11FulfillmentStatusConsumer` (`outbox-consumers/m21-fulfillment-status.ts`) — the D8
 *     one-shot auto-complete: `m21.supply_request.status_changed` with `toStatus='delivered'` completes
 *     the M11 order when its kind is `supply`/`comfort_kit`, and explicitly does NOT for `dme`.
 *
 * Both deciders (`decideAssessmentSuggestion`, M11's own D8 spec rule) have existed unbound since M11-T07
 * / M11 lock; neither has ever had a live `OutboxConsumerBinding`. This proves both for real: the correct
 * effect, idempotent redelivery, the documented non-qualifying no-ops, and cross-tenant isolation.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT \
 *     bun run test:m11:m9-m21-consumers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M11_OUTBOX_EVENTS, type OrderWriteOutboxPort } from "../src/modules/11-orders/index";
import { buildM11AssessmentSuggestionConsumer } from "../src/modules/11-orders/outbox-consumers/m9-assessment-significant-change";
import { buildM11FulfillmentStatusConsumer } from "../src/modules/11-orders/outbox-consumers/m21-fulfillment-status";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "F-15x — M11's m9-significant-change / m21-fulfillment-status consumers — LIVE Postgres + Valkey",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let redis: IORedis;
    let providerA: string;
    let providerB: string;
    let memberA: string;
    let suggestionConsumer: ReturnType<typeof buildM11AssessmentSuggestionConsumer>;
    let fulfillmentConsumer: ReturnType<typeof buildM11FulfillmentStatusConsumer>;

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
      triggeringAssessmentId?: string | null;
    }): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO order_record
           (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
            status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id,
            triggering_assessment_id)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),$3,'v1','{}'::jsonb,$4,$5,
                 'rn_case_manager',$6,$7)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.kind,
          opts.status,
          memberA,
          PHYSICIAN_MDM,
          opts.triggeringAssessmentId ?? null,
        ],
      );
      return rows[0].id as string;
    }

    async function orderRow(orderId: string) {
      const { rows } = await admin.query(
        `SELECT status, completed_at FROM order_record WHERE id = $1`,
        [orderId],
      );
      return rows[0];
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
         VALUES ($1,'m11-m9m21-a','M11 M9M21 A','M11 M9M21 A'),
                ($2,'m11-m9m21-b','M11 M9M21 B','M11 M9M21 B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f15x@x.test')`, [USER]);
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M11X-A','Provider A','1200000001','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M11X-B','Provider B','1200000002','enc','12-31') RETURNING id`,
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

      redis = new IORedis({ ...parseRedisUrl(REDIS_URL as string), maxRetriesPerRequest: null });
      await redis
        .keys("wardenx:m11:orders:suggestion:*")
        .then((keys) => (keys.length ? redis.del(...keys) : undefined));

      suggestionConsumer = buildM11AssessmentSuggestionConsumer({
        db: handle.db,
        redis,
        outbox: makeOutbox(),
      });
      fulfillmentConsumer = buildM11FulfillmentStatusConsumer({
        db: handle.db,
        outbox: makeOutbox(),
      });
    }, 120_000);

    afterAll(async () => {
      await redis?.quit();
      await handle?.close();
      if (admin) await admin.end();
    });

    describe("m9.assessment.significant_change — order-suggestion banner", () => {
      it("adds a qualifying suggestion to the Valkey banner and emits the state-changed event", async () => {
        const patientId = "aaaaaaaa-1000-4000-8000-000000000001";
        const assessmentId = "aaaaaaaa-1000-4000-8000-000000000002";

        await suggestionConsumer.handle({
          organizationId: ORG_A,
          payload: { patientId, assessmentId, ruleId: "esas_symptom_ge_7" },
        });

        const raw = await redis.get(`wardenx:m11:orders:suggestion:${patientId}`);
        const banner = JSON.parse(raw as string);
        expect(banner).toHaveLength(1);
        expect(banner[0]).toMatchObject({
          triggeringId: assessmentId,
          suggestedKind: "comfort_kit",
        });

        const events = await outboxRows(ORG_A, "m11.order.suggestion_state_changed");
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          patientId,
          addedSuggestions: [assessmentId],
          droppedSuggestions: [],
        });
      });

      it("is idempotent on redelivery — no duplicate banner entry, no second event", async () => {
        const patientId = "aaaaaaaa-1000-4000-8000-000000000003";
        const assessmentId = "aaaaaaaa-1000-4000-8000-000000000004";
        const event = {
          organizationId: ORG_A,
          payload: { patientId, assessmentId, ruleId: "painad_ge_4" },
        };

        await suggestionConsumer.handle(event);
        await suggestionConsumer.handle(event);

        const raw = await redis.get(`wardenx:m11:orders:suggestion:${patientId}`);
        expect(JSON.parse(raw as string)).toHaveLength(1);
        expect(await outboxRows(ORG_A, "m11.order.suggestion_state_changed")).toEqual(
          expect.arrayContaining([expect.objectContaining({ payload: expect.anything() })]),
        );
      });

      it("skips a non-qualifying rule id (below threshold)", async () => {
        const patientId = "aaaaaaaa-1000-4000-8000-000000000005";
        await suggestionConsumer.handle({
          organizationId: ORG_A,
          payload: {
            patientId,
            assessmentId: "aaaaaaaa-1000-4000-8000-000000000006",
            ruleId: "unrelated_rule",
          },
        });
        expect(await redis.get(`wardenx:m11:orders:suggestion:${patientId}`)).toBeNull();
      });

      it("skips once the clinician already created a real order for this assessment", async () => {
        const patientId = "aaaaaaaa-1000-4000-8000-000000000007";
        const assessmentId = "aaaaaaaa-1000-4000-8000-000000000008";
        await seedOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          kind: "comfort_kit",
          status: "active",
          triggeringAssessmentId: assessmentId,
        });

        await suggestionConsumer.handle({
          organizationId: ORG_A,
          payload: { patientId, assessmentId, ruleId: "esas_symptom_ge_7" },
        });

        expect(await redis.get(`wardenx:m11:orders:suggestion:${patientId}`)).toBeNull();
      });

      it("does not cross tenants — org B's order for the same assessment id doesn't suppress org A's suggestion", async () => {
        const assessmentId = "aaaaaaaa-1000-4000-8000-000000000009";
        const patientId = "aaaaaaaa-1000-4000-8000-00000000000a";
        await seedOrder({
          organizationId: ORG_B,
          providerEntityId: providerB,
          kind: "comfort_kit",
          status: "active",
          triggeringAssessmentId: assessmentId,
        });

        await suggestionConsumer.handle({
          organizationId: ORG_A,
          payload: { patientId, assessmentId, ruleId: "esas_symptom_ge_7" },
        });

        const raw = await redis.get(`wardenx:m11:orders:suggestion:${patientId}`);
        expect(JSON.parse(raw as string)).toHaveLength(1); // org B's order never seen from org A's delivery
      });
    });

    describe("m21.supply_request.status_changed — D8 one-shot auto-complete", () => {
      it("completes an active supply order on delivered, tagged auto", async () => {
        const orderId = await seedOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          kind: "supply",
          status: "active",
        });

        await fulfillmentConsumer.handle({
          organizationId: ORG_A,
          payload: { sourceOrderId: orderId, toStatus: "delivered" },
        });

        const row = await orderRow(orderId);
        expect(row.status).toBe("completed");
        expect(row.completed_at).not.toBeNull();

        const events = await outboxRows(ORG_A, "m11.order.completed", orderId);
        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({ orderId, kindAutoOrManual: "auto" });
      });

      it("completes an active comfort_kit order the same way", async () => {
        const orderId = await seedOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          kind: "comfort_kit",
          status: "active",
        });
        await fulfillmentConsumer.handle({
          organizationId: ORG_A,
          payload: { sourceOrderId: orderId, toStatus: "delivered" },
        });
        expect((await orderRow(orderId)).status).toBe("completed");
      });

      it("does NOT auto-complete a dme order on delivered — DME closes out separately", async () => {
        const orderId = await seedOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          kind: "dme",
          status: "active",
        });

        await fulfillmentConsumer.handle({
          organizationId: ORG_A,
          payload: { sourceOrderId: orderId, toStatus: "delivered" },
        });

        expect((await orderRow(orderId)).status).toBe("active");
        expect(await outboxRows(ORG_A, "m11.order.completed", orderId)).toHaveLength(0);
      });

      it("is a no-op for a non-delivered status transition", async () => {
        const orderId = await seedOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          kind: "supply",
          status: "active",
        });
        await fulfillmentConsumer.handle({
          organizationId: ORG_A,
          payload: { sourceOrderId: orderId, toStatus: "shipped" },
        });
        expect((await orderRow(orderId)).status).toBe("active");
      });

      it("is idempotent — a redelivery after completion does not throw or double-emit", async () => {
        const orderId = await seedOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          kind: "supply",
          status: "active",
        });
        const event = {
          organizationId: ORG_A,
          payload: { sourceOrderId: orderId, toStatus: "delivered" },
        };
        await fulfillmentConsumer.handle(event);
        await expect(fulfillmentConsumer.handle(event)).resolves.toBeUndefined();
        expect(await outboxRows(ORG_A, "m11.order.completed", orderId)).toHaveLength(1);
      });

      it("does not cross tenants — org A cannot complete org B's order", async () => {
        const orderId = await seedOrder({
          organizationId: ORG_B,
          providerEntityId: providerB,
          kind: "supply",
          status: "active",
        });
        await fulfillmentConsumer.handle({
          organizationId: ORG_A,
          payload: { sourceOrderId: orderId, toStatus: "delivered" },
        });
        expect((await orderRow(orderId)).status).toBe("active"); // untouched by org A's delivery
      });
    });
  },
);
