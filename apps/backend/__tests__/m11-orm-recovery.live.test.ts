/**
 * F-184 (#248) — RECOVERY of lab orders that can never reach the lab, proven end to end over real Postgres.
 *
 * Two gaps left a signed lab order stuck with no way out:
 *
 *  1. AN M29 TERMINAL FAILURE (`dlq_exhausted` — incl. F-183's "held, delivery unverified" — or `application_reject`).
 *     The message WAS built and may have been received, so F-182's plain resend refuses it (a blind re-send orders the
 *     test twice). `recoverLabTransmission` is the way out, and it needs a HUMAN to establish what the lab holds:
 *       `not_received_by_lab` → re-dispatch exactly once (the single sanctioned exception to F-183's one-ORM-per-order),
 *       `received_by_lab`     → mark `transmitted`, send nothing.
 *     The attestation is recorded in the order's M4 write-audit diff (who / when / what).
 *  2. AN ORDER THE M29 WORKER REFUSED TO PERSIST (no/ambiguous/unlinked feed, incomplete MSH identity, lapsed BAA).
 *     F-175 returned silently, so the order stayed `pending` FOREVER and F-182's resend (which needs `failed`) could not
 *     reach it. The worker now publishes `m29.lab_order.dispatch_refused`; F-177's applier flips the order to `failed`
 *     (`dispatch_refused:<reason>`) and F-182's resend then re-runs it once the operator fixed the cause.
 *
 * Everything runs as the NOBYPASSRLS `wardenx_app` role, through the real catalog-validating publisher, M29's real T08
 * worker (a STUB `MllpTransport` — a permanent refusal to reach a real `dlq_exhausted`, then an AA), and F-177's real
 * applier. Every guard is negative-tested (the assertion fails with the guard removed).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m11:orm-recovery:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
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
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/events-by-m29";
import { parseMshEnvelope } from "../src/modules/29-external-interfaces/listener/mllp-framing";
import type { OutboundTenantKeyProvider } from "../src/modules/29-external-interfaces/outbound/dispatch-crypto";
import { buildM29OutboundDispatchConsumer } from "../src/modules/29-external-interfaces/outbound/dispatch-worker";
import { buildDrizzleOutboundFeedResolver } from "../src/modules/29-external-interfaces/outbound/feed-resolver";
import type {
  MllpTransport,
  MllpTransportSendInput,
} from "../src/modules/29-external-interfaces/outbound/mllp-transport";
import { createDbMdmStore, registerMdmSeams } from "../src/modules/40-mdm/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER_B = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

const PH_ACTIVE = "a0000000-0000-0000-0000-000000000001";
const FAC_ACTIVE = "b0000000-0000-0000-0000-000000000001";

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
const LAB_DATA = { testCodes: LOINC, fastingRequired: false, routingLabId: FAC_ACTIVE };

describe.skipIf(!DB_URL)("F-184 — recovery of lab orders that cannot reach the lab, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let applier: ReturnType<typeof buildM11LabTransmissionApplierConsumer>;
  let member: string;
  let memberB: string;
  let wires: string[] = [];
  /** `refuse` → a permanent destination refusal (a real `dlq_exhausted` through the real worker); `ack` → AA. */
  let mode: "ack" | "refuse" = "ack";
  let baaActive = true;

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

  const transport: MllpTransport = {
    async send(input: MllpTransportSendInput) {
      if (mode === "refuse") return { kind: "destination_refused" as const, errorClass: "loopback_refused" as never };
      wires.push(input.wireMessage);
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

  async function seedFeed(organizationId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, host, port, protocol, channel_cert_pin,
          status, proposed_by_membership_id, rate_limit_msg_per_sec, lab_destination_facility_id,
          msh_sending_application, msh_sending_facility, msh_receiving_application, msh_receiving_facility)
       VALUES ($1,$2,'orm_outbound','Reference Lab','127.0.0.1',2575,'mllp_plain',NULL,'active',$3,1000,$4,
               'WARDENX','HOSPICE-A','REFLAB','REFLAB-FAC')`,
      [id, organizationId, randomUUID(), FAC_ACTIVE],
    );
    return id;
  }

  async function seedPatient(id: string, organizationId: string, mrn: string): Promise<void> {
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,$3,'Jane','Doe','1950-04-05','F')`,
      [id, organizationId, mrn],
    );
  }

  async function signedLab(kind = "lab", data: Record<string, unknown> = LAB_DATA): Promise<string> {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const draft = await svc.createDraft(ORG_A, member, {
      patientId,
      admissionId: ADMISSION,
      kind: kind as never,
      drafterDiscipline: "rn_case_manager",
      data,
      orderingPhysicianMdmId: PH_ACTIVE,
    });
    await svc.requestSignature(ORG_A, draft.id, { signerDiscipline: "rn_case_manager" });
    await svc.signOrder(ORG_A, member, draft.id, {
      signerDiscipline: "rn_case_manager",
      signedAtClient: new Date().toISOString(),
    });
    return draft.id;
  }

  /** A lab order that went out, was permanently refused, and the REAL applier marked `failed` / `dlq_exhausted`. */
  async function heldOrder(): Promise<string> {
    mode = "refuse";
    const id = await signedLab();
    await settle();
    mode = "ack";
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq"]);
    expect(wires).toHaveLength(0);
    return id;
  }

  async function count(aggregateId: string, eventType: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [aggregateId, eventType],
    );
    return rows[0].n as number;
  }
  async function orderRow(id: string) {
    const { rows } = await admin.query(
      "SELECT status, transmission_status, transmission_ack_code, transmission_failure_reason FROM order_record WHERE id=$1",
      [id],
    );
    return rows[0];
  }
  async function outboundRows(orderId: string) {
    const { rows } = await admin.query(
      `SELECT status, message_control_id, idempotency_key FROM hl7_message_outbound
        WHERE organization_id=$1 AND source_aggregate_id=$2 ORDER BY queued_at, id`,
      [ORG_A, orderId],
    );
    return rows as { status: string; message_control_id: string; idempotency_key: string }[];
  }
  async function settle() {
    for (let i = 0; i < 5; i++) await dispatcher.tick();
  }

  const recover = (
    id: string,
    attestation: "not_received_by_lab" | "received_by_lab",
    org = ORG_A,
    membership = member,
    user = USER,
  ) => svc.recoverLabTransmission(org, membership, id, attestation, undefined, user);
  const resend = (id: string) => svc.resendLabTransmission(ORG_A, member, id, undefined, USER);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f184@x.test'),($2,'f184b@x.test')`, [USER, USER_B]);
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    memberB = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_B, ORG_B],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, status) VALUES
         ('${PH_ACTIVE}', '1234567893', 'Sam', 'Smith', 'active')`,
    );
    await admin.query(
      `INSERT INTO facility (id, kind, name, status) VALUES ('${FAC_ACTIVE}', 'other', 'Reference Lab', 'active')`,
    );
    registerMdmSeams({ store: createDbMdmStore(handle.db) });
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({
        isActive: baaActive,
        status: baaActive ? "executed" : "missing",
        expiresOn: null,
      }),
    } as never);

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M29_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m11Outbox = { publish: (tx: unknown, e: any) => publisher.publish(tx as never, { ...e, callerModule: "m11" }) };
    const m29Outbox = { publish: (tx: any, e: any) => publisher.publish(tx, { ...e, callerModule: "m29" }) };

    svc = createDbOrderBackend(
      handle.db,
      m11Outbox,
      buildM11OrmRequestedPorts({ patient: hl7OrmDemographicsInTx, feeds: buildDrizzleOutboundFeedResolver() }),
    );
    applier = buildM11LabTransmissionApplierConsumer({ db: handle.db, outbox: m11Outbox });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
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
        applier,
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
    wires = [];
    mode = "ack";
    baaActive = true;
    await admin.query("DELETE FROM outbox_event WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM external_feed WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await seedFeed(ORG_A);
  });

  // ── 1. Attested `not_received_by_lab` → re-dispatched exactly once ────────────────────────────────────────

  it("a HELD order (real permanent refusal → dlq_exhausted) is re-dispatched ONCE on `not_received_by_lab`: new row, new MSH-10, delivered, transmitted", async () => {
    const id = await heldOrder();
    const [first] = await outboundRows(id);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);

    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
    expect(res.refusalReason).toBeNull();
    expect(res.order.transmissionStatus).toBe("pending");

    // State + event committed together; the attestation rides on the reason (the audit-diff carrier).
    const pending = await orderRow(id);
    expect(pending.transmission_status).toBe("pending");
    expect(pending.transmission_failure_reason).toMatch(/^recovery_attested:not_received_by_lab:[0-9a-f-]{36}$/);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(2);

    await settle();
    expect(wires).toHaveLength(1);
    expect(wires[0]).toContain("ORM^O01");
    const after = await orderRow(id);
    expect(after.transmission_status).toBe("transmitted");
    expect(after.transmission_ack_code).toBe("AA");
    expect(after.transmission_failure_reason).toBeNull();

    const rows = await outboundRows(id);
    expect(rows.map((r) => r.status)).toEqual(["dlq", "acked"]);
    // A genuinely NEW attempt: its own MSH-10 and its own attestation-scoped idempotency key.
    expect(rows[1]!.message_control_id).not.toBe(first!.message_control_id);
    expect(rows[1]!.idempotency_key).not.toBe(first!.idempotency_key);
  });

  it("the attestation is the AUDIT RECORD: the M4 diff carries WHO (the real user), the prior M29 reason and the attestation", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    const { rows } = await admin.query(
      `SELECT actor_user_id, before->>'transmission_failure_reason' AS br, after->>'transmission_failure_reason' AS ar
         FROM audit_event
        WHERE resource_kind='order_record' AND resource_id=$1 AND event_type='order_record.update'
          AND before->>'transmission_status'='failed' AND after->>'transmission_status'='pending'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(USER);
    expect(rows[0].br).toBe("dlq_exhausted");
    expect(rows[0].ar).toMatch(/^recovery_attested:not_received_by_lab:/);
  });

  it("two CONCURRENT attested recoveries dispatch ONE message; the loser is refused 409 (not_failed)", async () => {
    const id = await heldOrder();
    const results = await Promise.allSettled([recover(id, "not_received_by_lab"), recover(id, "not_received_by_lab")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(String(bad[0]!.reason.message)).toMatch(/Transmission recovery not allowed \(not_failed\)/);
    expect(bad[0]!.reason.statusCode).toBe(409);

    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(2); // the original + ONE attested
    await settle();
    expect(wires).toHaveLength(1);
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq", "acked"]);
  });

  it("a SEQUENTIAL second recovery after success is refused and sends nothing more", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    await settle();
    await expect(recover(id, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_failed"),
    });
    expect(wires).toHaveLength(1);
  });

  it("if the re-dispatch is refused AGAIN, a second attestation may try again — each attempt its own row, never a re-use", async () => {
    const id = await heldOrder();
    mode = "refuse";
    await recover(id, "not_received_by_lab");
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("dlq_exhausted");
    mode = "ack";
    await recover(id, "not_received_by_lab");
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq", "dlq", "acked"]);
    expect(wires).toHaveLength(1);
  });

  it("if the producer now REFUSES (a fact is missing) the order is left EXACTLY as it was — never rewritten to orm_refused:*", async () => {
    const id = await heldOrder();
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("still_refused");
    expect(res.refusalReason).toBe("no_active_feed");
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    // NOT `orm_refused:no_active_feed`: that would make F-182's plain resend (no attestation) reachable for an
    // order whose first attempt may have reached the lab.
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");
    await expect(resend(id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("not_an_orm_refusal") });
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
  });

  // ── 2. Attested `received_by_lab` → transmitted, nothing sent ─────────────────────────────────────────────

  it("`received_by_lab` marks the order transmitted WITHOUT sending, publishes the status change, and audits the attestation", async () => {
    const id = await heldOrder();
    const res = await recover(id, "received_by_lab");
    expect(res.outcome).toBe("marked_transmitted");
    expect(res.order.transmissionStatus).toBe("transmitted");

    await settle();
    expect(wires).toHaveLength(0);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1); // no new request
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq"]);
    const { rows: ev } = await admin.query(
      `SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.transmission_status_changed'
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(ev[0].payload).toMatchObject({ fromStatus: "failed", toStatus: "transmitted" });

    const { rows } = await admin.query(
      `SELECT actor_user_id, after->>'transmission_failure_reason' AS ar FROM audit_event
        WHERE resource_kind='order_record' AND resource_id=$1 AND event_type='order_record.update'
          AND before->>'transmission_status'='failed' AND after->>'transmission_status'='transmitted'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(USER);
    expect(rows[0].ar).toMatch(/^recovery_attested:received_by_lab:/);
  });

  it("an AR-rejected order cannot be marked received (the lab explicitly refused it) — but can be re-dispatched", async () => {
    const id = await heldOrder();
    await admin.query("UPDATE order_record SET transmission_failure_reason='application_reject' WHERE id=$1", [id]);
    await expect(recover(id, "received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("lab_rejected_order"),
    });
    expect((await orderRow(id)).transmission_status).toBe("failed");
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
  });

  // ── 3. Eligibility: only an M29 terminal failure ──────────────────────────────────────────────────────────

  it("a DELIVERED order, a PENDING order and an emit-time refusal are NOT recoverable", async () => {
    const delivered = await signedLab();
    await settle();
    expect((await orderRow(delivered)).transmission_status).toBe("transmitted");
    await expect(recover(delivered, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_failed"),
    });

    const refused = await signedLab();
    await admin.query(
      "UPDATE order_record SET transmission_status='failed', transmission_failure_reason='orm_refused:patient_dob_missing' WHERE id=$1",
      [refused],
    );
    await expect(recover(refused, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_an_m29_terminal_failure"),
    });
    expect(wires).toHaveLength(1); // only the delivered order's original
  });

  it("a non-lab order is not recoverable (not_a_lab_order)", async () => {
    const id = await signedLab("dme", { hcpcs: "E0260" });
    await expect(recover(id, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_a_lab_order"),
    });
  });

  it("another tenant's order is 404 (RLS) and left untouched; an unknown id is 404", async () => {
    const id = await heldOrder();
    await expect(recover(id, "not_received_by_lab", ORG_B, memberB, USER_B)).rejects.toMatchObject({ statusCode: 404 });
    expect((await orderRow(id)).transmission_failure_reason).toBe("dlq_exhausted");
    await expect(recover(randomUUID(), "not_received_by_lab")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("without the ORM ports (not configured) recovery is refused, never a silent no-op", async () => {
    const bare = createDbOrderBackend(handle.db);
    const id = await heldOrder();
    await expect(bare.recoverLabTransmission(ORG_A, member, id, "not_received_by_lab", undefined, USER)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_configured"),
    });
  });

  // ── 4. PENDING FOREVER: the worker's "wrote no row" exits now end in a terminal, resendable `failed` ──────

  it("a LAPSED BAA no longer leaves the order pending forever: it becomes failed (dispatch_refused:baa_inactive), alerts once, and F-182's resend delivers after the BAA is renewed", async () => {
    baaActive = false;
    const id = await signedLab();
    expect((await orderRow(id)).transmission_status).toBe("pending");
    await settle();

    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    expect(await outboundRows(id)).toHaveLength(0); // no row: nothing was ever sent
    expect(wires).toHaveLength(0);
    expect(await count(id, "m29.lab_order.dispatch_refused")).toBe(1);
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1); // M36's ordering-provider alert
    expect(await count(id, "m11.order.transmission_status_changed")).toBe(1);

    baaActive = true; // the compliance officer renews the BAA
    const res = await resend(id);
    expect(res.outcome).toBe("requested");
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["acked"]);
  });

  it("a feed removed after sign (no_active_feed at dispatch) becomes failed (dispatch_refused:no_active_feed) and resends once a feed is back", async () => {
    const id = await signedLab();
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:no_active_feed");
    expect(wires).toHaveLength(0);

    await seedFeed(ORG_A);
    await resend(id);
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });

  it("an MSH identity that goes incomplete after sign becomes failed (dispatch_refused:feed_identity_incomplete) with a PHI-free event, and resends once the operator completes the feed", async () => {
    // (The F-181 emitter already refuses an incomplete identity AT SIGN as `orm_refused:*`; this is the window
    // between sign and dispatch — an operator edits the feed while the request is in the outbox.)
    const id = await signedLab();
    await admin.query("UPDATE external_feed SET msh_receiving_facility=NULL WHERE organization_id=$1", [ORG_A]);
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:feed_identity_incomplete");
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.dispatch_refused'",
      [id],
    );
    expect(JSON.stringify(rows[0].payload)).not.toMatch(/Doe|Jane|MRN|msh_receiving/);

    await admin.query("UPDATE external_feed SET msh_receiving_facility='REFLAB-FAC' WHERE organization_id=$1", [ORG_A]);
    await resend(id);
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });

  it("a STALE or redelivered refusal never disturbs an order that has moved on (applier applies it to `pending` only)", async () => {
    const id = await signedLab();
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    const before = await count(id, "m11.order.transmission_status_changed");
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: { orderId: id, organizationId: ORG_A, feedId: null, refusalId: randomUUID(), reason: "baa_inactive" },
    });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("transmitted");
    expect(row.transmission_failure_reason).toBeNull();
    expect(await count(id, "m11.order.transmission_status_changed")).toBe(before);
  });
});
