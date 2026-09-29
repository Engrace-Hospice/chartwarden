/**
 * F-187 (#248) — RECOVERY of lab orders that can never reach the lab, proven end to end over real Postgres.
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
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
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
import { ormOutboundEvidenceForOrder } from "../src/modules/29-external-interfaces/outbound/order-dispatch-dedupe";
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

describe.skipIf(!DB_URL)("F-187 — recovery of lab orders that cannot reach the lab, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let applier: ReturnType<typeof buildM11LabTransmissionApplierConsumer>;
  /** The real catalog-validating M11 publisher, kept so a case can build a second backend over it. */
  let m11OutboxPort: NonNullable<Parameters<typeof createDbOrderBackend>[1]>;
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
      "SELECT status, transmission_status, transmission_ack_code, transmission_failure_reason, transmission_attempt_id FROM order_record WHERE id=$1",
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

  /** F-188 — the STRUCTURED evidence every attestation now carries (who at the lab + the lab's own reference). */
  const EVIDENCE = { contactName: "Dana Reyes", labReference: "REF-2026-0041" };
  const recover = (
    id: string,
    attestation: "not_received_by_lab" | "received_by_lab",
    org = ORG_A,
    membership = member,
    user = USER,
    evidence: { contactName: string; labReference: string } = EVIDENCE,
  ) => svc.recoverLabTransmission(org, membership, id, attestation, evidence, undefined, user);
  /** Every `order_transmission_attestation` row for an order, oldest first (read as the superuser). */
  async function attestations(orderId: string) {
    const { rows } = await admin.query(
      `SELECT id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id,
              attested_by_membership_id, attested_by_user_id
         FROM order_transmission_attestation WHERE order_record_id=$1 ORDER BY created_at, id`,
      [orderId],
    );
    return rows as {
      id: string;
      attestation: string;
      outcome: string;
      lab_contact_name: string;
      lab_reference: string;
      prior_failure_reason: string;
      attempt_id: string | null;
      attested_by_membership_id: string | null;
      attested_by_user_id: string | null;
    }[];
  }
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
    m11OutboxPort = m11Outbox as never;
    const m29Outbox = { publish: (tx: any, e: any) => publisher.publish(tx, { ...e, callerModule: "m29" }) };

    svc = createDbOrderBackend(
      handle.db,
      m11Outbox,
      buildM11OrmRequestedPorts({
        patient: hl7OrmDemographicsInTx,
        feeds: buildDrizzleOutboundFeedResolver(),
        // F-188 — the evidence the attested recovery checks a `not_received_by_lab` against.
        outboundEvidence: ormOutboundEvidenceForOrder,
      }),
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

    // State + event committed together. F-188: a `pending` order carries NO failure reason (F-187 parked a
    // `recovery_attested:` marker here); the attestation lives in `order_transmission_attestation`.
    const pending = await orderRow(id);
    expect(pending.transmission_status).toBe("pending");
    expect(pending.transmission_failure_reason).toBeNull();
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

  it("F-188 — the attestation has a PROPER HOME: one append-only row (who, what, the evidence, the prior reason, the attempt) and the M4 diff carries the real user on BOTH the order and the attestation", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");

    const [att] = await attestations(id);
    expect(await attestations(id)).toHaveLength(1);
    expect(att).toMatchObject({
      attestation: "not_received_by_lab",
      outcome: "redispatched",
      lab_contact_name: "Dana Reyes",
      lab_reference: "REF-2026-0041",
      prior_failure_reason: "dlq_exhausted",
      attested_by_membership_id: member,
      attested_by_user_id: USER,
    });
    // The attestation started THE current attempt: the order row and the row agree, and the event carries it too.
    const order = await orderRow(id);
    expect(att!.attempt_id).toBe(order.transmission_attempt_id);
    const { rows: ev } = await admin.query(
      `SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.hl7_orm_requested'
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(ev[0].payload).toMatchObject({ attemptId: att!.attempt_id, redispatchAttestationId: att!.id });

    // The order's own write-audit diff still records WHO moved it failed → pending, and the reason is cleared.
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
    expect(rows[0].ar).toBeNull();
    // ... and the attestation row is audited under the same user, with the contact NAME scrubbed out of the diff.
    const { rows: aud } = await admin.query(
      `SELECT actor_user_id, after FROM audit_event
        WHERE resource_kind='order_transmission_attestation' AND resource_id=$1 AND event_type='order_transmission_attestation.insert'`,
      [att!.id],
    );
    expect(aud).toHaveLength(1);
    expect(aud[0].actor_user_id).toBe(USER);
    expect(JSON.stringify(aud[0].after)).not.toContain("Dana Reyes");
    expect(aud[0].after.lab_reference).toBe("REF-2026-0041");
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
    // F-188 — a DELIVERED order carries no failure reason and no attestation marker (F-187 left
    // `recovery_attested:received_by_lab:<uuid>` here forever); the attestation is in its own table.
    expect(rows[0].ar).toBeNull();
    const order = await orderRow(id);
    expect(order.transmission_status).toBe("transmitted");
    expect(order.transmission_failure_reason).toBeNull();
    const atts = await attestations(id);
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      attestation: "received_by_lab",
      outcome: "marked_transmitted",
      attempt_id: null, // nothing was sent, so no attempt was started
      prior_failure_reason: "dlq_exhausted",
      lab_reference: "REF-2026-0041",
    });
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
    await expect(
      bare.recoverLabTransmission(ORG_A, member, id, "not_received_by_lab", EVIDENCE, undefined, USER),
    ).rejects.toMatchObject({
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

  it("a refusal applies ONLY to a `pending` order — not to `pending_retry` or `not_required`, which the terminal-state check alone would let through", async () => {
    for (const status of ["pending_retry", "not_required"]) {
      const id = await signedLab();
      await admin.query("UPDATE order_record SET transmission_status=$2 WHERE id=$1", [id, status]);
      const before = await count(id, "m11.order.transmission_status_changed");
      await applier.handle({
        eventType: "m29.lab_order.dispatch_refused",
        organizationId: ORG_A,
        payload: { orderId: id, organizationId: ORG_A, feedId: null, refusalId: randomUUID(), reason: "no_active_feed" },
      });
      const row = await orderRow(id);
      expect(row.transmission_status, `status=${status}`).toBe(status);
      expect(await count(id, "m11.order.transmission_status_changed"), `status=${status}`).toBe(before);
    }
  });

  // ══ F-188 ════════════════════════════════════════════════════════════════════════════════════════════════════
  // Four residual risks of the F-187 attested recovery, closed. Every guard below is mutation-tested: the case named
  // in its comment fails with the guard removed.

  /** Assert a recovery was refused with a specific 409 code and changed NOTHING. */
  async function expectRefusedUntouched(
    id: string,
    attestation: "not_received_by_lab" | "received_by_lab",
    code: string,
  ): Promise<void> {
    const before = await orderRow(id);
    const requested = await count(id, "m11.order.hl7_orm_requested");
    const atts = (await attestations(id)).length;
    await expect(recover(id, attestation)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(code),
    });
    expect(await orderRow(id)).toEqual(before);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(requested);
    expect((await attestations(id)).length).toBe(atts);
  }

  async function firstEnum(type: string): Promise<string> {
    const { rows } = await admin.query(`SELECT (enum_range(NULL::${type}))[1] AS v`);
    return rows[0].v as string;
  }
  /** A REAL M29 `lab_observation` matched to the order — the lab has already returned a result for it. */
  async function labObservationFor(orderId: string): Promise<void> {
    const { rows: pat } = await admin.query("SELECT patient_id FROM order_record WHERE id=$1", [orderId]);
    await admin.query(
      `INSERT INTO lab_observation
         (organization_id, provider_entity_id, source_message_id, patient_id, order_id, observation_date,
          result_status, loinc_code, loinc_display_text, terminology_validation, abnormal_summary)
       VALUES ($1,$2,$3,$4,$5, now(), $6, '2345-7','Glucose', $7, $8)`,
      [
        ORG_A,
        randomUUID(),
        randomUUID(),
        pat[0].patient_id,
        orderId,
        await firstEnum("lab_result_status"),
        await firstEnum("lab_terminology_validation"),
        await firstEnum("lab_abnormal_summary"),
      ],
    );
  }

  // ── Risk 1 — WRONG ATTESTATION: structured evidence + a contradiction check ─────────────────────────────

  it("F-188 risk 1: the DB itself rejects evidence that could carry a patient identifier (digits in a name, spaces in a reference) — nothing is dispatched, attested or changed", async () => {
    const id = await heldOrder();
    for (const bad of [
      { contactName: "Dana 5550100", labReference: "REF-2026-0041" }, // a phone number / MRN in the name
      { contactName: "Dana Reyes", labReference: "called about Jane Doe" }, // free text in the reference
      { contactName: "D", labReference: "REF-2026-0041" },
    ]) {
      const before = await orderRow(id);
      await expect(recover(id, "not_received_by_lab", ORG_A, member, USER, bad)).rejects.toThrow();
      // The transaction rolled back as a whole: still failed, no request event, no attestation, nothing on the wire.
      expect(await orderRow(id)).toEqual(before);
      expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
      expect(await attestations(id)).toHaveLength(0);
    }
    await settle();
    expect(wires).toHaveLength(0);
  });

  it("F-188 risk 1: a result the lab ALREADY returned (order_record.results_*) refutes `not_received_by_lab` — 409 lab_result_received, nothing changes", async () => {
    const id = await heldOrder();
    await admin.query(
      "UPDATE order_record SET results_status='partial_results_received', results_first_received_at=now() WHERE id=$1",
      [id],
    );
    await expectRefusedUntouched(id, "not_received_by_lab", "lab_result_received");
    await settle();
    expect(wires).toHaveLength(0);
  });

  it("F-188 risk 1: an M29 `lab_observation` matched to the order refutes `not_received_by_lab` — the lab cannot have returned a result for an order it never got", async () => {
    const id = await heldOrder();
    await labObservationFor(id);
    await expectRefusedUntouched(id, "not_received_by_lab", "lab_result_received");
    // ... and the SAME evidence does not stand in the way of the truthful attestation: the lab HAS it.
    const res = await recover(id, "received_by_lab");
    expect(res.outcome).toBe("marked_transmitted");
  });

  it("F-188 risk 1: an outbound row the lab ACKNOWLEDGED refutes `not_received_by_lab` (lab_acknowledged) — but `received_by_lab` is not blocked", async () => {
    const id = await signedLab();
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["acked"]);
    // A late failure signal marks the delivered order failed (e.g. a stale event); the lab's ACK is still on record.
    await admin.query(
      "UPDATE order_record SET transmission_status='failed', transmission_failure_reason='dlq_exhausted' WHERE id=$1",
      [id],
    );
    await expectRefusedUntouched(id, "not_received_by_lab", "lab_acknowledged");
    expect(wires).toHaveLength(1); // the original only
    const res = await recover(id, "received_by_lab");
    expect(res.outcome).toBe("marked_transmitted");
  });

  it("F-188 risk 1: a send still queued or in flight refutes `not_received_by_lab` (send_in_progress) — a second send would duplicate it", async () => {
    for (const status of ["queued", "in_flight"]) {
      const id = await heldOrder();
      await admin.query("UPDATE hl7_message_outbound SET status=$2 WHERE organization_id=$1 AND source_aggregate_id=$3", [
        ORG_A,
        status,
        id,
      ]);
      await expectRefusedUntouched(id, "not_received_by_lab", "send_in_progress");
    }
    expect(wires).toHaveLength(0);
  });

  it("F-188 risk 1: WITHOUT the evidence port the recovery FAILS CLOSED (evidence_unavailable) — a safety check that cannot run is not 'no contradiction'", async () => {
    const noEvidence = createDbOrderBackend(
      handle.db,
      m11OutboxPort,
      buildM11OrmRequestedPorts({ patient: hl7OrmDemographicsInTx, feeds: buildDrizzleOutboundFeedResolver() }),
    );
    const id = await heldOrder();
    await expect(
      noEvidence.recoverLabTransmission(ORG_A, member, id, "not_received_by_lab", EVIDENCE, undefined, USER),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("evidence_unavailable") });
    expect((await orderRow(id)).transmission_status).toBe("failed");
    expect(await attestations(id)).toHaveLength(0);
    // `received_by_lab` needs no outbound evidence, so it is not blocked by the missing port.
    const ok = await noEvidence.recoverLabTransmission(ORG_A, member, id, "received_by_lab", EVIDENCE, undefined, USER);
    expect(ok.outcome).toBe("marked_transmitted");
  });

  // ── Risk 2 — STALE REFUSAL: a refusal is bound to the attempt it refused ────────────────────────────────

  it("F-188 risk 2: every emission mints its own attempt id, persisted on the order and carried on the event — sign, F-182 resend and recovery", async () => {
    baaActive = false;
    const id = await signedLab();
    const signed = await orderRow(id);
    expect(signed.transmission_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    const { rows: ev0 } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.hl7_orm_requested'",
      [id],
    );
    expect(ev0[0].payload.attemptId).toBe(signed.transmission_attempt_id);
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("failed");

    await resend(id);
    const resent = await orderRow(id);
    expect(resent.transmission_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resent.transmission_attempt_id).not.toBe(signed.transmission_attempt_id);
  });

  it("F-188 risk 2: a `dispatch_refused` redelivered AFTER the operator resent does NOT flip the order failed again; the refusal for the CURRENT attempt still does", async () => {
    baaActive = false;
    const id = await signedLab();
    await settle(); // refusal #1 (attempt A1) → failed / dispatch_refused:baa_inactive
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    const { rows: r1 } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.dispatch_refused'",
      [id],
    );
    const staleRefusal = r1[0].payload; // names attempt A1

    await resend(id); // attempt A2, order `pending` again — its request is queued in the outbox, not yet dispatched
    const a2 = (await orderRow(id)).transmission_attempt_id;
    expect(a2).not.toBe(staleRefusal.attemptId);
    const changed = await count(id, "m11.order.transmission_status_changed");

    // The relay redelivers refusal #1 (its consumer receipt was lost). Before F-188 the `pending` guard alone let it
    // through and flipped the freshly re-requested order back to `failed`.
    await applier.handle({ eventType: "m29.lab_order.dispatch_refused", organizationId: ORG_A, payload: staleRefusal });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("pending");
    expect(row.transmission_failure_reason).toBeNull();
    expect(await count(id, "m11.order.transmission_status_changed")).toBe(changed);

    // The BAA is still lapsed, so the worker now refuses attempt A2 — THAT refusal names the current attempt and applies.
    await settle();
    const after = await orderRow(id);
    expect(after.transmission_status).toBe("failed");
    expect(after.transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    expect(await count(id, "m29.lab_order.dispatch_refused")).toBe(2);
  });

  it("F-188 risk 2: a stale refusal is ignored after an ATTESTED recovery too (the recovery mints a new attempt)", async () => {
    const id = await heldOrder();
    const before = (await orderRow(id)).transmission_attempt_id;
    await recover(id, "not_received_by_lab");
    const current = (await orderRow(id)).transmission_attempt_id;
    expect(current).not.toBe(before);
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: {
        orderId: id,
        organizationId: ORG_A,
        feedId: null,
        refusalId: randomUUID(),
        reason: "baa_inactive",
        attemptId: before ?? randomUUID(), // the PREVIOUS attempt
      },
    });
    expect((await orderRow(id)).transmission_status).toBe("pending");
    // The refusal that names the CURRENT attempt applies.
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: {
        orderId: id,
        organizationId: ORG_A,
        feedId: null,
        refusalId: randomUUID(),
        reason: "baa_inactive",
        attemptId: current,
      },
    });
    expect((await orderRow(id)).transmission_status).toBe("failed");
  });

  it("F-188 risk 2: a refusal from a request that predates F-188 (no attempt id) is applied exactly as before", async () => {
    const id = await signedLab();
    await admin.query("UPDATE order_record SET transmission_attempt_id=NULL WHERE id=$1", [id]);
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: { orderId: id, organizationId: ORG_A, feedId: null, refusalId: randomUUID(), reason: "no_active_feed" },
    });
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:no_active_feed");
  });

  // ── Risk 3 — the attestation's home: append-only, RLS-scoped, and the delivered order is clean ──────────

  it("F-188 risk 3: the attestation table is APPEND-ONLY — the app role cannot UPDATE or DELETE a row, and not even a superuser can (trigger)", async () => {
    const id = await heldOrder();
    await recover(id, "received_by_lab");
    const [att] = await attestations(id);
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        tx.execute(sql`UPDATE order_transmission_attestation SET lab_reference = 'TAMPERED-001' WHERE id = ${att!.id}`),
      ),
    ).rejects.toThrow();
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        tx.execute(sql`DELETE FROM order_transmission_attestation WHERE id = ${att!.id}`),
      ),
    ).rejects.toThrow();
    // A role that DOES hold the privilege is still stopped by the trigger.
    await expect(
      admin.query("UPDATE order_transmission_attestation SET lab_reference='TAMPERED-001' WHERE id=$1", [att!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(admin.query("DELETE FROM order_transmission_attestation WHERE id=$1", [att!.id])).rejects.toThrow(
      /append-only/,
    );
    expect((await attestations(id))[0]).toMatchObject({ lab_reference: "REF-2026-0041" });
  });

  it("F-188 risk 3: cross-tenant — another org's context sees NO attestation rows and cannot write one for this org (RLS, as the real app role)", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    expect(await attestations(id)).toHaveLength(1);

    const visibleTo = async (organizationId: string): Promise<number> => {
      const res = await withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
        tx.execute(sql`SELECT id FROM order_transmission_attestation WHERE order_record_id = ${id}`),
      );
      return (res as unknown as { rows: unknown[] }).rows.length;
    };
    expect(await visibleTo(ORG_B)).toBe(0);
    expect(await visibleTo(ORG_A)).toBe(1);

    await expect(
      withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
        tx.execute(sql`INSERT INTO order_transmission_attestation
          (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id)
          VALUES (${ORG_A}, ${id}, 'not_received_by_lab', 'redispatched', 'Dana Reyes', 'REF-2026-0041', 'dlq_exhausted', ${randomUUID()})`),
      ),
    ).rejects.toThrow();
  });

  it("F-188 risk 3: the two outcome constraints agree — a `received_by_lab` row cannot claim an attempt, a re-dispatch must have one", async () => {
    const id = await heldOrder();
    await expect(
      admin.query(
        `INSERT INTO order_transmission_attestation
           (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id)
         VALUES ($1,$2,'received_by_lab','marked_transmitted','Dana Reyes','REF-2026-0041','dlq_exhausted',$3)`,
        [ORG_A, id, randomUUID()],
      ),
    ).rejects.toThrow(/outcome_agrees/);
    await expect(
      admin.query(
        `INSERT INTO order_transmission_attestation
           (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id)
         VALUES ($1,$2,'not_received_by_lab','redispatched','Dana Reyes','REF-2026-0041','dlq_exhausted',NULL)`,
        [ORG_A, id],
      ),
    ).rejects.toThrow(/outcome_agrees/);
  });

  it("F-188 risk 3: a re-dispatch that is later DELIVERED ends with a clean order (no reason, no marker) and the attestation still on record", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    await settle();
    const order = await orderRow(id);
    expect(order.transmission_status).toBe("transmitted");
    expect(order.transmission_failure_reason).toBeNull();
    expect(await attestations(id)).toHaveLength(1);
  });

  // ── Risk 4 — BLOCKED ATTESTED REQUEST: never silently `pending` ─────────────────────────────────────────

  it("F-188 risk 4: an attested re-dispatch the worker cannot honour (a row appeared and owns the order) ends the order ACTIONABLE — failed / recovery_blocked:row_owns_order — not `pending` forever", async () => {
    const id = await heldOrder();
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
    const attempt = (await orderRow(id)).transmission_attempt_id;
    // Between the operator's request and the worker's claim, a send takes ownership of the order (e.g. the reclaim
    // sweep requeued the dead attempt) — the race the route-time evidence check cannot see.
    await admin.query("UPDATE hl7_message_outbound SET status='in_flight' WHERE organization_id=$1 AND source_aggregate_id=$2", [
      ORG_A,
      id,
    ]);
    await settle();

    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("recovery_blocked:row_owns_order");
    expect(wires).toHaveLength(0);
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.dispatch_refused'",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ reason: "attested_redispatch_blocked", attemptId: attempt });
    expect(JSON.stringify(rows[0].payload)).not.toMatch(/Doe|Jane|MRN/);
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBeGreaterThanOrEqual(1); // M36's alert
  });

  it("F-188 risk 4: a `recovery_blocked` order is NOT resendable (a row exists), refuses a new attestation while that row still owns it, and is recoverable once it settles", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    await admin.query("UPDATE hl7_message_outbound SET status='in_flight' WHERE organization_id=$1 AND source_aggregate_id=$2", [
      ORG_A,
      id,
    ]);
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("recovery_blocked:row_owns_order");

    // F-182's plain resend must not act on it: it would only be swallowed by F-183's order-level guard.
    await expect(resend(id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("not_an_orm_refusal") });
    // While the row still owns the order, the attested path re-verifies and refuses.
    await expectRefusedUntouched(id, "not_received_by_lab", "send_in_progress");

    // The owning row settles as a dead end (the send never reached the lab) → the attested path works again.
    await admin.query("UPDATE hl7_message_outbound SET status='dlq' WHERE organization_id=$1 AND source_aggregate_id=$2", [
      ORG_A,
      id,
    ]);
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect(await attestations(id)).toHaveLength(2); // both attestations are on record
  });

  // ── F-192 — the attempt binding for the TERMINAL events (`transmission_failed` / `transmitted`) ──────────────
  // F-188 bound `dispatch_refused` to the attempt it refused. The two events that come off an outbound ROW carried no
  // attempt, so a late or redelivered one from an EARLIER attempt was guarded only by the terminal-state check — which
  // stops protecting the order the moment an operator recovery sets it `pending` again.

  /** The payload of the M29 event of `eventType` published for `orderId` (M29 events are keyed on the row). */
  async function m29Payload(orderId: string, eventType: string, nth = 0): Promise<Record<string, unknown>> {
    const { rows } = await admin.query(
      `SELECT payload FROM outbox_event WHERE event_type=$1 AND payload->>'orderId'=$2 ORDER BY created_at, id`,
      [eventType, orderId],
    );
    expect(rows.length, `${eventType} #${nth} for the order`).toBeGreaterThan(nth);
    return rows[nth].payload as Record<string, unknown>;
  }
  const statusChanges = (id: string) => count(id, "m11.order.transmission_status_changed");

  it("F-192 window A (the real one): a `transmission_failed` from attempt 1, redelivered AFTER an attested recovery, does NOT flip the recovered order failed again", async () => {
    const id = await heldOrder(); // attempt 1 → dlq_exhausted → failed
    const a1 = (await orderRow(id)).transmission_attempt_id as string;
    const stale = await m29Payload(id, "m29.lab_order.transmission_failed");
    expect(stale.attemptId, "the terminal event names the attempt whose row produced it").toBe(a1);

    // The operator verified with the lab and recovers: attempt 2, the order is `pending` again (its request is queued).
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
    const a2 = (await orderRow(id)).transmission_attempt_id as string;
    expect(a2).not.toBe(a1);
    expect((await orderRow(id)).transmission_status).toBe("pending");
    const changed = await statusChanges(id);

    // The relay redelivers attempt 1's failure (its consumer receipt was lost). The terminal-state check does not
    // help: the order is `pending`. Without the attempt binding this flips the recovered order back to `failed`.
    await applier.handle({ eventType: "m29.lab_order.transmission_failed", organizationId: ORG_A, payload: stale });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("pending");
    expect(row.transmission_failure_reason).toBeNull();
    expect(await statusChanges(id)).toBe(changed);

    // Attempt 2 then goes out and is acked: THAT event names the current attempt and applies.
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    const ack = await m29Payload(id, "m29.lab_order.transmitted");
    expect(ack.attemptId).toBe(a2);
  });

  it("F-192 window B (defence in depth — a late `transmitted` for attempt 1 cannot be produced by M29 today, its row is a dead end): a stale `transmitted` does NOT mark a recovered order delivered", async () => {
    const id = await heldOrder();
    const a1 = (await orderRow(id)).transmission_attempt_id as string;
    const failed = await m29Payload(id, "m29.lab_order.transmission_failed");
    await recover(id, "not_received_by_lab");
    expect((await orderRow(id)).transmission_status).toBe("pending");
    const changed = await statusChanges(id);

    await applier.handle({
      eventType: "m29.lab_order.transmitted",
      organizationId: ORG_A,
      payload: {
        orderId: id,
        organizationId: ORG_A,
        feedId: failed.feedId,
        outboundMessageId: failed.outboundMessageId,
        messageControlId: "STALE1",
        ackReceivedAt: new Date().toISOString(),
        attemptId: a1,
      },
    });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("pending");
    expect(row.transmission_ack_code).toBeNull();
    expect(await statusChanges(id)).toBe(changed);
  });

  it("F-192: the terminal event of the CURRENT attempt still applies — a recovery that is refused AGAIN ends failed, and the event names the new attempt", async () => {
    const id = await heldOrder();
    const a1 = (await orderRow(id)).transmission_attempt_id as string;
    mode = "refuse";
    await recover(id, "not_received_by_lab");
    const a2 = (await orderRow(id)).transmission_attempt_id as string;
    await settle(); // attempt 2 is permanently refused too → dlq_exhausted for A2
    mode = "ack";
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");
    const second = await m29Payload(id, "m29.lab_order.transmission_failed", 1);
    expect(second.attemptId).toBe(a2);
    expect(second.attemptId).not.toBe(a1);
  });

  it("F-192: a terminal event with NO attempt id (a row queued before the migration, or an event already in the outbox) applies exactly as it always did", async () => {
    const failedId = await signedLab(); // pending, attempt on the order; nothing dispatched yet
    await applier.handle({
      eventType: "m29.lab_order.transmission_failed",
      organizationId: ORG_A,
      payload: { orderId: failedId, organizationId: ORG_A, feedId: randomUUID(), outboundMessageId: randomUUID(), reason: "dlq_exhausted", detail: null, attemptCount: 5 },
    });
    expect((await orderRow(failedId)).transmission_status).toBe("failed");

    const okId = await signedLab();
    await applier.handle({
      eventType: "m29.lab_order.transmitted",
      organizationId: ORG_A,
      payload: { orderId: okId, organizationId: ORG_A, feedId: randomUUID(), outboundMessageId: randomUUID(), messageControlId: "LEGACY1", ackReceivedAt: new Date().toISOString() },
    });
    expect((await orderRow(okId)).transmission_status).toBe("transmitted");
  });

});
