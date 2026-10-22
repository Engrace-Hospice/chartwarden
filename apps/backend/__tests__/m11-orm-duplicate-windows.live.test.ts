/**
 * F-183 (#248) — every window in which ONE lab order could become TWO outbound ORM messages, reproduced on the
 * real path over real Postgres. F-182's in_flight-sweep fork flagged "the M11 emitter's crash-after-send window"
 * as a separate duplicate hazard; this suite is the proof of which windows are real and which are already shut.
 *
 * The emitter itself never touches a socket — it publishes `m11.order.hl7_orm_requested` into the outbox INSIDE the
 * sign transaction — so the "crash after send" that can duplicate is really: the M29 consumer sends, the process
 * dies before the dispatcher writes the `(event, consumer)` receipt, the event is redelivered. Windows:
 *
 *   W1  two CONCURRENT signs of one order          → CLOSED  `order_signature_target_signature_uq` (DB unique index)
 *   W2  sign transaction fails after the emitter   → CLOSED  one transaction: no signature, no event, retry = one
 *   W3  redelivery, receipt lost, routing unchanged → CLOSED  M29 idempotency key + advisory lock (F-181)
 *   W4  redelivery, receipt lost, ROUTING CHANGED   → REAL    the key hashes the feed the resolver picked NOW
 *   W5  resend racing the applier / a request already at M29 → UNREACHABLE  see the F-182 resend suite + the pin below
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:orm-duplicate-windows:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { hl7OrmDemographicsInTx } from "../src/modules/05-patient/seams/hl7-orm-demographics";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { buildM11OrmRequestedPorts } from "../src/modules/11-orders/orm-request/ports";
import { buildM11LabTransmissionApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-transmission-applier";
import { SYSTEM_ORDER_ACTOR } from "../src/modules/11-orders/routes/service";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/events-by-m29";
import { parseMshEnvelope } from "../src/modules/29-external-interfaces/listener/mllp-framing";
import type { OutboundTenantKeyProvider } from "../src/modules/29-external-interfaces/outbound/dispatch-crypto";
import { buildM29OutboundDispatchConsumer } from "../src/modules/29-external-interfaces/outbound/dispatch-worker";
import { buildDrizzleOutboundFeedResolver } from "../src/modules/29-external-interfaces/outbound/feed-resolver";
import type {
  MllpTransport,
  MllpTransportSendInput,
} from "../src/modules/29-external-interfaces/outbound/mllp-transport";
import { ormDispatchExistsForOrder } from "../src/modules/29-external-interfaces/outbound/order-dispatch-dedupe";
import { createDbMdmStore, registerMdmSeams } from "../src/modules/40-mdm/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PH_ACTIVE = "a0000000-0000-0000-0000-000000000001";
const FAC_ACTIVE = "b0000000-0000-0000-0000-000000000001";
const FAC_OTHER = "b0000000-0000-0000-0000-000000000002";
const PORT_X = 2575;
const PORT_Y = 2576;

const TEST_DEK = Buffer.alloc(32, 7);
const keys: OutboundTenantKeyProvider = {
  async dekForOrg() {
    return { version: "v1", key: TEST_DEK };
  },
  async dekForOrgVersion(_orgId, version) {
    return { version, key: TEST_DEK };
  },
};
const LOINC = [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }];

describe.skipIf(!DB_URL)("F-183 — duplicate-ORM windows for one lab order, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let ports: ReturnType<typeof buildM11OrmRequestedPorts>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let member: string;
  let sent: { port: number; wire: string }[] = [];
  const P_OK = randomUUID();

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Records which FEED (port) each wire was sent to; answers AA echoing the request's own MSH-10. */
  const transport: MllpTransport = {
    async send(input: MllpTransportSendInput) {
      sent.push({ port: input.port, wire: input.wireMessage });
      const env = parseMshEnvelope(input.wireMessage);
      const msh = [
        "MSH",
        "^~\\&",
        env.receivingApplication,
        env.receivingFacility,
        env.sendingApplication,
        env.sendingFacility,
        "20260101000000",
        "",
        "ACK",
        `${env.messageControlId}-ack`,
        "P",
        "2.5.1",
      ].join("|");
      return {
        kind: "ack" as const,
        rawAckPayload: [msh, ["MSA", "AA", env.messageControlId, ""].join("|")].join("\r"),
      };
    },
  };

  async function seedFeed(
    port: number,
    facilityId: string | null,
    status = "active",
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, host, port, protocol, channel_cert_pin,
          status, proposed_by_membership_id, rate_limit_msg_per_sec, lab_destination_facility_id,
          msh_sending_application, msh_sending_facility, msh_receiving_application, msh_receiving_facility)
       VALUES ($1,$2,'orm_outbound',$3,'127.0.0.1',$4,'mllp_plain',NULL,$5,$6,1000,$7,
               'CHARTWARDEN','HOSPICE-A','REFLAB','REFLAB-FAC')`,
      [id, ORG_A, `Lab ${port}`, port, status, randomUUID(), facilityId],
    );
    return id;
  }

  async function draftAndRequest(service = svc): Promise<string> {
    const draft = await service.createDraft(
      ORG_A,
      member,
      {
        patientId: P_OK,
        admissionId: ADMISSION,
        kind: "lab" as never,
        drafterDiscipline: "rn_case_manager",
        data: { testCodes: LOINC, fastingRequired: false, routingLabId: FAC_ACTIVE },
        orderingPhysicianMdmId: PH_ACTIVE,
      },
      SYSTEM_ORDER_ACTOR,
    );
    await service.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    return draft.id;
  }
  const signArgs = () => ({
    signerDiscipline: "rn_case_manager",
    signedAtClient: new Date().toISOString(),
  });

  async function count(sqlText: string, args: unknown[]): Promise<number> {
    const { rows } = await admin.query(sqlText, args);
    return Number(rows[0].n);
  }
  const requestEvents = (id: string) =>
    count(
      "SELECT count(*) n FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.hl7_orm_requested'",
      [id],
    );
  const outboundRows = (id: string) =>
    count("SELECT count(*) n FROM hl7_message_outbound WHERE source_aggregate_id=$1", [id]);
  async function orderRow(id: string) {
    const { rows } = await admin.query(
      "SELECT status, transmission_status, transmission_failure_reason FROM order_record WHERE id=$1",
      [id],
    );
    return rows[0];
  }
  async function settle() {
    for (let i = 0; i < 4; i++) await dispatcher.tick();
  }
  /**
   * The crash window: the M29 consumer ran to completion (the wire went out, the row is committed) but the process
   * died BEFORE the dispatcher wrote the `(event, consumer)` receipt — so on the next tick the event is claimed and
   * delivered again. Undo exactly what the dispatcher records after a successful delivery.
   */
  async function loseTheReceipt(orderId: string) {
    await admin.query(
      `DELETE FROM outbox_consumer_receipt WHERE event_id IN
         (SELECT id FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.hl7_orm_requested')`,
      [orderId],
    );
    await admin.query(
      `UPDATE outbox_event SET status='pending', dispatched_at=NULL, next_attempt_at=NULL, attempt_count=0
        WHERE aggregate_id=$1 AND event_type='m11.order.hl7_orm_requested'`,
      [orderId],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')`,
      [ORG_A],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f180@x.test')`, [USER]);
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, status) VALUES ('${PH_ACTIVE}','1234567893','Sam','Smith','active')`,
    );
    await admin.query(
      `INSERT INTO facility (id, kind, name, status) VALUES ('${FAC_ACTIVE}','other','Reference Lab','active'),('${FAC_OTHER}','other','Other Lab','active')`,
    );
    registerMdmSeams({ store: createDbMdmStore(handle.db) });
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: true, status: "executed", expiresOn: null }),
    } as never);

    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,'MRN-OK','Jane','Doe','1950-04-05','F')`,
      [P_OK, ORG_A],
    );
    await admin.query(
      `INSERT INTO patient_address (patient_id, organization_id, kind, line1, city, state, postal_code, is_primary, effective_from)
       VALUES ($1,$2,'home','1 Main St','Springfield','OR','97477',true,'2020-01-01')`,
      [P_OK, ORG_A],
    );

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M29_OUTBOX_EVENTS]);
    publisher = buildTxOutboxPublisher(catalog);
    const m11Outbox = {
      publish: (tx: unknown, e: any) =>
        publisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    const m29Outbox = {
      publish: (tx: any, e: any) => publisher.publish(tx, { ...e, callerModule: "m29" }),
    };
    ports = buildM11OrmRequestedPorts({
      patient: hl7OrmDemographicsInTx,
      feeds: buildDrizzleOutboundFeedResolver(),
    });
    svc = createDbOrderBackend(handle.db, m11Outbox, ports);

    const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG_A }] };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM29OutboundDispatchConsumer({
          db: handle.db,
          outbox: m29Outbox,
          keys,
          transport,
          alerts: { emit: async () => undefined } as never,
          destinationPolicy: { allowPlain: true, allowLoopback: true },
        }),
        buildM11LabTransmissionApplierConsumer({ db: handle.db, outbox: m11Outbox }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    sent = [];
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id=$1", [ORG_A]);
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
  });

  // ── W1 ──────────────────────────────────────────────────────────────────────────────────────────────────
  it("W1: two CONCURRENT signs of one order publish ONE ORM request and put ONE message on the wire", async () => {
    await seedFeed(PORT_X, FAC_ACTIVE);
    const id = await draftAndRequest();
    const results = await Promise.allSettled([
      svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR),
      svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await requestEvents(id)).toBe(1);
    expect(
      await count(
        "SELECT count(*) n FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.signed'",
        [id],
      ),
    ).toBe(1);
    await settle();
    expect(sent).toHaveLength(1);
    expect(await outboundRows(id)).toBe(1);
  });

  it("W1b: a SEQUENTIAL second sign is refused by the state machine and adds no request", async () => {
    await seedFeed(PORT_X, FAC_ACTIVE);
    const id = await draftAndRequest();
    await svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR);
    await expect(
      svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR),
    ).rejects.toBeTruthy();
    expect(await requestEvents(id)).toBe(1);
    await settle();
    expect(sent).toHaveLength(1);
  });

  // ── W2 ──────────────────────────────────────────────────────────────────────────────────────────────────
  it("W2: a sign whose ORM publish FAILS rolls back the whole sign (no signature, no event); the retry publishes exactly one", async () => {
    await seedFeed(PORT_X, FAC_ACTIVE);
    const id = await draftAndRequest();
    const crashing = createDbOrderBackend(
      handle.db,
      {
        publish: (tx: unknown, e: any) => {
          if (e.eventName === "m11.order.hl7_orm_requested")
            throw new Error("simulated crash at the emit");
          return publisher.publish(tx as never, { ...e, callerModule: "m11" });
        },
      },
      ports,
    );
    await expect(
      crashing.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR),
    ).rejects.toThrow(/simulated crash/);
    expect((await orderRow(id)).status).toBe("pending_signature");
    expect(await requestEvents(id)).toBe(0);
    expect(
      await count(
        "SELECT count(*) n FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.signed'",
        [id],
      ),
    ).toBe(0);
    expect(await count("SELECT count(*) n FROM order_signature WHERE target_id=$1", [id])).toBe(0);

    await svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR);
    expect(await requestEvents(id)).toBe(1);
    await settle();
    expect(sent).toHaveLength(1);
  });

  // ── W3 ──────────────────────────────────────────────────────────────────────────────────────────────────
  it("W3: a redelivery after a lost receipt, routing UNCHANGED, sends nothing more (M29 idempotency)", async () => {
    await seedFeed(PORT_X, FAC_ACTIVE);
    const id = await draftAndRequest();
    await svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR);
    await settle();
    expect(sent).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");

    await loseTheReceipt(id);
    await settle();
    expect(sent).toHaveLength(1);
    expect(await outboundRows(id)).toBe(1);
  });

  // ── W4 ──────────────────────────────────────────────────────────────────────────────────────────────────
  // REAL, and reproduced here. M29's dedup key hashes the feed the resolver picks at delivery time (§2.6), so a
  // redelivery after a relink resolves another feed, computes another key and sent a SECOND message for the same
  // order. Closed by the worker calling `ormDispatchExistsForOrder` under an order-level advisory lock at the top
  // of its claim transaction (mutation: removing that call brings the second wire back).
  it("W4: a redelivery after the routing CHANGED (facility relinked to another feed) must NOT send a second message", async () => {
    const feedX = await seedFeed(PORT_X, FAC_ACTIVE);
    const feedY = await seedFeed(PORT_Y, null);
    const id = await draftAndRequest();
    await svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR);
    await settle();
    expect(sent.map((s) => s.port)).toEqual([PORT_X]);

    // An operator relinks the destination: the SAME facility now resolves to feed Y.
    await admin.query("UPDATE external_feed SET lab_destination_facility_id=$2 WHERE id=$1", [
      feedX,
      FAC_OTHER,
    ]);
    await admin.query("UPDATE external_feed SET lab_destination_facility_id=$2 WHERE id=$1", [
      feedY,
      FAC_ACTIVE,
    ]);

    await loseTheReceipt(id);
    await settle();

    // One order, one message — on the feed it originally went to.
    expect(sent.map((s) => s.port)).toEqual([PORT_X]);
    expect(await outboundRows(id)).toBe(1);
  });

  it("W4 seam: ormDispatchExistsForOrder sees an order's outbound row on ANY feed, and only that order's, only in its own tenant", async () => {
    const feedX = await seedFeed(PORT_X, FAC_ACTIVE);
    const id = await draftAndRequest();
    const other = await draftAndRequest();
    await svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR);
    await svc.signOrder(ORG_A, member, other, signArgs(), SYSTEM_ORDER_ACTOR);
    const exists = (org: string, orderId: string) =>
      withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
        ormDispatchExistsForOrder(tx as unknown as DbClient, org, orderId),
      );
    // Signed but not yet delivered to M29 → no outbound row yet.
    expect(await exists(ORG_A, id)).toBe(false);
    await settle();
    expect(await exists(ORG_A, id)).toBe(true);
    expect(await exists(ORG_A, other)).toBe(true);
    // Still true after the feed it went out on is deactivated: the row, not the feed, is the fact.
    await admin.query("UPDATE external_feed SET status='suspended' WHERE id=$1", [feedX]);
    expect(await exists(ORG_A, id)).toBe(true);
    // Not another order, not another tenant (RLS + the explicit org predicate).
    expect(await exists(ORG_A, randomUUID())).toBe(false);
    expect(await exists("99999999-9999-9999-9999-999999999999", id)).toBe(false);
  });

  // ── W5 ──────────────────────────────────────────────────────────────────────────────────────────────────
  it("W5: an order whose request is already at M29 (pending) or delivered (transmitted) is not resendable and publishes nothing", async () => {
    await seedFeed(PORT_X, FAC_ACTIVE);
    const id = await draftAndRequest();
    await svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR);
    // pending — the request is in the outbox / at M29, nothing has come back yet.
    expect((await orderRow(id)).transmission_status).toBe("pending");
    await expect(svc.resendLabTransmission(ORG_A, member, id)).rejects.toThrow(/not_failed/);
    expect(await requestEvents(id)).toBe(1);

    await settle(); // transmitted
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    await expect(svc.resendLabTransmission(ORG_A, member, id)).rejects.toThrow(/not_failed/);
    expect(await requestEvents(id)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("W5b: a late M29 transmission_failed never regresses an order the applier already marked transmitted", async () => {
    await seedFeed(PORT_X, FAC_ACTIVE);
    const id = await draftAndRequest();
    await svc.signOrder(ORG_A, member, id, signArgs(), SYSTEM_ORDER_ACTOR);
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    // A stale/duplicate M29 failure for the same order arrives late: it must not flip a delivered order.
    const { rows } = await admin.query(
      "SELECT id FROM hl7_message_outbound WHERE source_aggregate_id=$1 LIMIT 1",
      [id],
    );
    await admin.query(
      `INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload, status)
       VALUES ($1,'m29.lab_order.transmission_failed','hl7_message_outbound',$2,$3::jsonb,'pending')`,
      [
        ORG_A,
        rows[0].id,
        JSON.stringify({
          orderId: id,
          outboundMessageId: rows[0].id,
          reason: "dlq_exhausted",
          attemptCount: 5,
        }),
      ],
    );
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });
});
