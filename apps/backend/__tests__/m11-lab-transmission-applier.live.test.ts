/**
 * F-177 (#248) — LIVE Postgres proof that M11's new `LabTransmissionApplier`
 * (`buildM11LabTransmissionApplierConsumer`, `outbox-consumers/m29-lab-transmission-applier.ts`) correctly
 * drives `order_record.transmission_status` off M29's real `m29.lab_order.transmitted`/`.transmission_failed`
 * events (live since F-175) and re-publishes M11's own D16-decisive
 * `m11.order.transmission_status_changed`/`.transmission_terminal_failed`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:lab-transmission-applier:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M11_OUTBOX_EVENTS, type OrderWriteOutboxPort } from "../src/modules/11-orders/index";
import { buildM11LabTransmissionApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-transmission-applier";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

describe.skipIf(!DB_URL)("F-177 — M11's LabTransmissionApplier — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerA: string;
  let providerB: string;
  let memberA: string;
  let consumer: ReturnType<typeof buildM11LabTransmissionApplierConsumer>;

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

  async function seedLabOrder(opts: {
    organizationId: string;
    providerEntityId: string;
    transmissionStatus: string;
  }): Promise<string> {
    // The RLS migration's §3.4 "lab-initial-states" trigger forces a new `kind='lab'` row's
    // `transmission_status` to `'pending'` at INSERT time regardless of what is inserted (proven directly
    // against this container: an INSERT carrying `'failed'` came back `'pending'`) — a genuine DB-level
    // invariant, not a test bug to route around by faking it. A later plain UPDATE is NOT re-triggered, so
    // seeding any status other than the trigger's own `'pending'` needs a follow-up UPDATE after the insert.
    const { rows } = await admin.query(
      `INSERT INTO order_record
         (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
          status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id)
       VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),'lab','v1','{}'::jsonb,'active',$3,
               'rn_case_manager',$4)
       RETURNING id`,
      [opts.organizationId, opts.providerEntityId, memberA, PHYSICIAN_MDM],
    );
    if (opts.transmissionStatus !== "pending") {
      await admin.query(`UPDATE order_record SET transmission_status = $2 WHERE id = $1`, [
        rows[0].id,
        opts.transmissionStatus,
      ]);
    }
    return rows[0].id as string;
  }

  async function orderRow(orderId: string) {
    const { rows } = await admin.query(
      `SELECT transmission_status, transmission_acked_at, transmission_ack_code,
              transmission_failure_reason
       FROM order_record WHERE id = $1`,
      [orderId],
    );
    return rows[0];
  }

  async function outboxRows(organizationId: string, eventType: string, aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2 AND aggregate_id=$3`,
      [organizationId, eventType, aggregateId],
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
       VALUES ($1,'m11-lab-transmission-a','M11 LT A','M11 LT A'),
              ($2,'m11-lab-transmission-b','M11 LT B','M11 LT B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f177@x.test')`, [USER]);
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M11LT-A','Provider A','1300000003','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    providerB = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M11LT-B','Provider B','1300000004','enc','12-31') RETURNING id`,
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

    consumer = buildM11LabTransmissionApplierConsumer({
      db: handle.db,
      outbox: makeOutbox(),
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("m29.lab_order.transmitted: flips pending -> transmitted, stamps the ack, emits transmission_status_changed", async () => {
    const orderId = await seedLabOrder({
      organizationId: ORG_A,
      providerEntityId: providerA,
      transmissionStatus: "pending",
    });
    await consumer.handle({
      eventType: "m29.lab_order.transmitted",
      organizationId: ORG_A,
      payload: {
        orderId,
        organizationId: ORG_A,
        feedId: "feed-1",
        outboundMessageId: "aaaaaaaa-3000-4000-8000-000000000001",
        messageControlId: "MC1",
        ackReceivedAt: "2026-09-29T11:59:00.000Z",
      },
    });

    const row = await orderRow(orderId);
    expect(row.transmission_status).toBe("transmitted");
    expect(row.transmission_ack_code).toBe("AA");
    expect(row.transmission_failure_reason).toBeNull();
    expect(row.transmission_acked_at).not.toBeNull();

    const events = await outboxRows(ORG_A, "m11.order.transmission_status_changed", orderId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      orderId,
      fromStatus: "pending",
      toStatus: "transmitted",
      ackCode: "AA",
      sourceM29EventId: "aaaaaaaa-3000-4000-8000-000000000001",
    });
    expect(await outboxRows(ORG_A, "m11.order.transmission_terminal_failed", orderId)).toHaveLength(
      0,
    );
  });

  it("m29.lab_order.transmission_failed: flips pending -> failed and emits BOTH events (D16's own table)", async () => {
    const orderId = await seedLabOrder({
      organizationId: ORG_A,
      providerEntityId: providerA,
      transmissionStatus: "pending",
    });
    await consumer.handle({
      eventType: "m29.lab_order.transmission_failed",
      organizationId: ORG_A,
      payload: {
        orderId,
        organizationId: ORG_A,
        feedId: "feed-1",
        outboundMessageId: "aaaaaaaa-3000-4000-8000-000000000002",
        reason: "dlq_exhausted",
        detail: "connect_timeout",
        attemptCount: 5,
      },
    });

    const row = await orderRow(orderId);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");

    const statusChanged = await outboxRows(ORG_A, "m11.order.transmission_status_changed", orderId);
    expect(statusChanged).toHaveLength(1);
    expect(statusChanged[0].payload).toMatchObject({
      orderId,
      fromStatus: "pending",
      toStatus: "failed",
      failureReason: "dlq_exhausted",
      sourceM29EventId: "aaaaaaaa-3000-4000-8000-000000000002",
    });

    const terminalFailed = await outboxRows(
      ORG_A,
      "m11.order.transmission_terminal_failed",
      orderId,
    );
    expect(terminalFailed).toHaveLength(1);
    expect(terminalFailed[0].payload).toMatchObject({
      orderId,
      failureReason: "dlq_exhausted",
      transmittedAttempts: 5,
      lastAttemptAt: "2026-09-29T12:00:00.000Z",
      orderingPhysicianMdmId: PHYSICIAN_MDM,
    });
  });

  it("an AR application_reject is applied identically to a DLQ exhaustion — both are terminal per the real M29 contract", async () => {
    const orderId = await seedLabOrder({
      organizationId: ORG_A,
      providerEntityId: providerA,
      transmissionStatus: "pending",
    });
    await consumer.handle({
      eventType: "m29.lab_order.transmission_failed",
      organizationId: ORG_A,
      payload: {
        orderId,
        organizationId: ORG_A,
        feedId: "feed-1",
        outboundMessageId: "aaaaaaaa-3000-4000-8000-000000000003",
        reason: "application_reject",
        detail: "MSA-3: unknown patient",
        attemptCount: 1,
      },
    });
    const row = await orderRow(orderId);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("application_reject");
    expect(await outboxRows(ORG_A, "m11.order.transmission_terminal_failed", orderId)).toHaveLength(
      1,
    );
  });

  it("is idempotent on redelivery — a settled (transmitted) row never regresses or double-emits", async () => {
    const orderId = await seedLabOrder({
      organizationId: ORG_A,
      providerEntityId: providerA,
      transmissionStatus: "pending",
    });
    const event = {
      eventType: "m29.lab_order.transmitted",
      organizationId: ORG_A,
      payload: {
        orderId,
        organizationId: ORG_A,
        feedId: "feed-1",
        outboundMessageId: "aaaaaaaa-3000-4000-8000-000000000004",
        messageControlId: "MC4",
        ackReceivedAt: "2026-09-29T11:59:00.000Z",
      },
    };
    await consumer.handle(event);
    await expect(consumer.handle(event)).resolves.toBeUndefined();

    expect((await orderRow(orderId)).transmission_status).toBe("transmitted");
    expect(await outboxRows(ORG_A, "m11.order.transmission_status_changed", orderId)).toHaveLength(
      1,
    );
  });

  it("is idempotent on redelivery — a settled (failed) row never flips back to transmitted on a stray transmitted redelivery", async () => {
    const orderId = await seedLabOrder({
      organizationId: ORG_A,
      providerEntityId: providerA,
      transmissionStatus: "failed",
    });
    await consumer.handle({
      eventType: "m29.lab_order.transmitted",
      organizationId: ORG_A,
      payload: {
        orderId,
        organizationId: ORG_A,
        feedId: "feed-1",
        outboundMessageId: "aaaaaaaa-3000-4000-8000-000000000005",
        messageControlId: "MC5",
        ackReceivedAt: "2026-09-29T11:59:00.000Z",
      },
    });
    expect((await orderRow(orderId)).transmission_status).toBe("failed");
    expect(await outboxRows(ORG_A, "m11.order.transmission_status_changed", orderId)).toHaveLength(
      0,
    );
  });

  it("is a benign no-op when no matching order exists (a stale/cross-module id)", async () => {
    await expect(
      consumer.handle({
        eventType: "m29.lab_order.transmitted",
        organizationId: ORG_A,
        payload: {
          orderId: "aaaaaaaa-4000-4000-8000-000000000099",
          organizationId: ORG_A,
          feedId: "feed-1",
          outboundMessageId: "aaaaaaaa-3000-4000-8000-000000000006",
          messageControlId: "MC6",
          ackReceivedAt: "2026-09-29T11:59:00.000Z",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not cross tenants — org A's delivery cannot transition org B's order", async () => {
    const orderId = await seedLabOrder({
      organizationId: ORG_B,
      providerEntityId: providerB,
      transmissionStatus: "pending",
    });
    await consumer.handle({
      eventType: "m29.lab_order.transmitted",
      organizationId: ORG_A,
      payload: {
        orderId,
        organizationId: ORG_A,
        feedId: "feed-1",
        outboundMessageId: "aaaaaaaa-3000-4000-8000-000000000007",
        messageControlId: "MC7",
        ackReceivedAt: "2026-09-29T11:59:00.000Z",
      },
    });
    // withOrgContext scopes the SELECT/UPDATE to org A's RLS window — org B's row is invisible, so this
    // is the same "no matching row" no-op path, proven here from the cross-tenant angle specifically.
    const { rows } = await admin.query(
      `SELECT transmission_status FROM order_record WHERE id = $1`,
      [orderId],
    );
    expect(rows[0].transmission_status).toBe("pending"); // untouched by org A's delivery
  });
});
