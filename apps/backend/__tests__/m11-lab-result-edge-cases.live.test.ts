/**
 * S08 (clinical workflow audit 2026-10-28) -- the edges of the returned-lab handshake, on real Postgres.
 *
 * m11-lab-results-applier.live proves the happy path, sequential redelivery and the HH/LL emit. This suite owns what
 * it does not:
 *   - CONCURRENCY: N simultaneous deliveries of one observation apply once; two different observations racing both
 *     apply and neither overwrites the first-received instant;
 *   - SILENT DROPS, pinned: a critical result with no order, or on an order the applier cannot publish for, emits
 *     nothing (so nobody can be told);
 *   - CORRECTION, pinned: a later non-critical observation does not withdraw an earlier critical event;
 *   - the two critical signals (`m11.order.results_received_critical`, `m29.lab_observation.abnormal_flag`) have NO
 *     consumer, and a returned lab has NO review/acknowledge step (no state, no service method).
 * Everything marked "REPORTED, NOT FIXED" pins today's behaviour (convention: m19-inbound-triggers.live) so the day
 * it is built this suite fails and the change is made deliberately. Tracked in the linked GitHub issues.
 *
 * Drives the writes as the NOBYPASSRLS `chartwarden_app` role with the real catalog-validating publisher.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:lab-result-edge-cases:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS, type OrderWriteOutboxPort } from "../src/modules/11-orders/index";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { buildM11LabResultsApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-results-applier";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const RACERS = 6;
const obs = (n: number): string => `aaaaaaaa-5008-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!DB_URL)("S08 lab-result edge cases — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let provider: string;
  let member: string;
  let outbox: OrderWriteOutboxPort;
  let consumer: ReturnType<typeof buildM11LabResultsApplierConsumer>;

  /**
   * A transmitted lab order awaiting results. `signed: false` clears `signed_at` (a verbal order not yet signed can
   * be transmitted). `ordering_physician_mdm_id` is NOT NULL in the schema, so the applier's null-physician guard is
   * unreachable and `signed_at` is the only way to trip its silent skip.
   */
  async function seedLabOrder(signed = true): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO order_record
         (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
          status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id, signed_at, priority)
       VALUES ($1,$2,$3,gen_random_uuid(),'lab','v1','{}'::jsonb,'active',$4,'rn_case_manager',$5,
               $6::timestamptz - interval '1 hour', 'routine')
       RETURNING id`,
      [ORG, provider, PATIENT, member, PHYSICIAN_MDM, NOW.toISOString()],
    );
    const id = rows[0].id as string;
    await admin.query(
      "UPDATE order_record SET results_status='awaiting_results', transmission_status='transmitted' WHERE id=$1",
      [id],
    );
    if (!signed) await admin.query("UPDATE order_record SET signed_at=NULL WHERE id=$1", [id]);
    return id;
  }
  const attached = (
    orderRecordId: string | null,
    observationId: string,
    flag: string | null = null,
  ) => ({
    eventType: "m29.lab_observation.attached",
    organizationId: ORG,
    payload: {
      observationId,
      organizationId: ORG,
      patientId: PATIENT,
      orderRecordId,
      loincCode: "2345-7",
      abnormalFlag: flag,
      observationDatetime: "2026-10-08T11:30:00.000Z",
    },
  });
  const handleEvent = (e: ReturnType<typeof attached>) => consumer.handle(e as never);
  const orderRow = async (id: string) =>
    (
      await admin.query(
        "SELECT results_status, results_first_received_at, last_lab_observation_attached_id FROM order_record WHERE id=$1",
        [id],
      )
    ).rows[0];
  const eventsFor = async (type: string, orderId: string): Promise<number> =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
        [type, orderId],
      )
    ).rows[0].n as number;
  const eventsForObservation = async (observationId: string): Promise<number> =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm11.order.results_%' AND payload->>'observationId'=$1",
        [observationId],
      )
    ).rows[0].n as number;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (process.env.CHARTWARDEN_TEST_NO_PGVECTOR) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'s08-a','S08','S08')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'s08@x.test')`, [USER]);
    provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'S08-A','Provider A','1300000013','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    member = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
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

  it("N simultaneous deliveries of one critical observation apply once: one results_received, one critical", async () => {
    const order = await seedLabOrder();
    const event = attached(order, obs(1), "HH");

    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, () => handleEvent(event)),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await eventsFor("m11.order.results_received", order)).toBe(1);
    expect(await eventsFor("m11.order.results_received_critical", order)).toBe(1);
    expect((await orderRow(order)).last_lab_observation_attached_id).toBe(obs(1));
  });

  it("two different observations racing both apply, and the first-received instant is stamped once", async () => {
    const order = await seedLabOrder();

    await Promise.all([handleEvent(attached(order, obs(2))), handleEvent(attached(order, obs(3)))]);

    expect(await eventsFor("m11.order.results_received", order)).toBe(2);
    const row = await orderRow(order);
    expect([obs(2), obs(3)]).toContain(row.last_lab_observation_attached_id);
    expect(new Date(row.results_first_received_at).toISOString()).toBe(NOW.toISOString());
  });

  it("REPORTED, NOT FIXED: a critical result bound to NO order emits nothing at all, so nobody can be told", async () => {
    await handleEvent(attached(null, obs(4), "HH"));

    expect(await eventsForObservation(obs(4))).toBe(0);
  });

  it("REPORTED, NOT FIXED: a critical result on an order with no signature flips state but emits no event", async () => {
    const order = await seedLabOrder(false);

    await handleEvent(attached(order, obs(5), "LL"));

    expect((await orderRow(order)).results_status).toBe("results_received");
    expect(await eventsFor("m11.order.results_received", order)).toBe(0);
    expect(await eventsFor("m11.order.results_received_critical", order)).toBe(0);
  });

  it("REPORTED, NOT FIXED: a corrected, non-critical observation does not withdraw the earlier critical event", async () => {
    const order = await seedLabOrder();
    await handleEvent(attached(order, obs(6), "HH"));

    await handleEvent(attached(order, obs(7), null));

    expect(await eventsFor("m11.order.results_received_critical", order)).toBe(1);
    expect(await eventsFor("m11.order.results_received", order)).toBe(2);
    const { rows } = await admin.query(
      "SELECT DISTINCT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY event_type",
      [order],
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      "m11.order.results_received",
      "m11.order.results_received_critical",
    ]);
  });

  it("REPORTED, NOT FIXED: neither critical signal has a consumer", () => {
    const declared = (
      events: readonly { eventName: string; declaredConsumers?: readonly string[] }[],
      name: string,
    ) => events.find((e) => e.eventName === name)?.declaredConsumers;

    expect(declared(M11_OUTBOX_EVENTS, "m11.order.results_received_critical")).toEqual([]);
    expect(declared(M29_OUTBOX_EVENTS, "m29.lab_observation.abnormal_flag")).toEqual([]);
  });

  it("REPORTED, NOT FIXED: a returned lab has no review step: no reviewed state, no review method, and it never leaves the queue", async () => {
    const { rows } = await admin.query(
      "SELECT unnest(enum_range(NULL::order_results_status))::text AS v",
    );
    expect(rows.map((r) => r.v)).toEqual([
      "not_expected",
      "awaiting_results",
      "partial_results_received",
      "results_received",
      "results_overdue",
    ]);
    const service = createDbOrderBackend(handle.db, outbox);
    expect(Object.keys(service).filter((k) => /review|acknowledg/i.test(k))).toEqual([
      "resultsPendingReview",
    ]);
    const order = await seedLabOrder();
    await handleEvent(attached(order, obs(8)));
    const { orders: first } = await service.resultsPendingReview(ORG);
    const { orders: again } = await service.resultsPendingReview(ORG);
    expect(first.map((o) => o.id)).toContain(order);
    expect(again.map((o) => o.id)).toContain(order);
  });
});
