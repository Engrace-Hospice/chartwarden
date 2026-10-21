/**
 * F-182 (#248) — RESEND of a refused lab ORM, proven end to end over real Postgres.
 *
 * F-181's producer REFUSES (never fabricates) when a fact the HL7 ORM needs is unresolvable at sign time: the order
 * stays signed, `transmission_status='failed'`, `transmission_failure_reason='orm_refused:<reason>'`. After someone
 * fixes the fact nothing retried. `resendLabTransmission` is the explicit, authorized, audited re-run. This drives:
 *
 *   refused order → the fact is FIXED (real UPDATE on the M5 patient row) → resend (as the NOBYPASSRLS `wardenx_app`
 *   role, real catalog-validating publisher) → `m11.order.hl7_orm_requested` → M29's real T08 worker → a STUB
 *   `MllpTransport` AA → F-177's applier → `transmission_status='transmitted'`.
 *
 * And the guards, each of which is negative-tested (the assertion fails with the guard removed):
 *   - a double resend (two tabs / a double-click, CONCURRENT) publishes ONE request and dispatches ONE message;
 *   - only an `orm_refused:*` failure is resendable — a delivered order, a pending order, an M29 terminal failure and a
 *     non-lab order are refused with 409;
 *   - a SUD refusal is NEVER resendable (42 CFR Part 2 — a compliance decision, not a data fix), even after the flag
 *     is cleared; a refusal whose fact lives in the immutable signed order needs a corrected order instead;
 *   - a still-refused resend publishes nothing and raises NO second alert;
 *   - another tenant's order is 404 (RLS), and the M4 audit trail records WHO resent it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m11:orm-resend:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
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
const PH_PROVISIONAL = "a0000000-0000-0000-0000-000000000003";
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

describe.skipIf(!DB_URL)("F-182 — resend of a refused lab ORM, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let member: string;
  let memberB: string;
  let wires: string[] = [];

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

  /** A stub MLLP transport: records the wire, answers AA echoing the request's own MSH-10 into MSA-2. */
  const transport: MllpTransport = {
    async send(input: MllpTransportSendInput) {
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

  async function seedPatient(
    id: string,
    organizationId: string,
    mrn: string,
    over: { sex?: string; sud?: boolean } = {},
  ): Promise<void> {
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,$3,'Jane','Doe','1950-04-05',$4)`,
      [id, organizationId, mrn, over.sex ?? "F"],
    );
    if (over.sud) {
      await admin.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags) VALUES ($1,$2,ARRAY['sud'])`,
        [id, organizationId],
      );
    }
  }

  async function signedLab(over: {
    patientId: string;
    physician?: string;
    data?: Record<string, unknown>;
    kind?: string;
  }): Promise<string> {
    const draft = await svc.createDraft(
      ORG_A,
      member,
      {
        patientId: over.patientId,
        admissionId: ADMISSION,
        kind: (over.kind ?? "lab") as never,
        drafterDiscipline: "rn_case_manager",
        data: over.data ?? LAB_DATA,
        orderingPhysicianMdmId: over.physician ?? PH_ACTIVE,
      },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.signOrder(
      ORG_A,
      member,
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    return draft.id;
  }

  /** A fresh patient whose sex is unrecorded (M5's `UNK`), so the sign-time ORM is refused `patient_sex_unrecorded`. */
  async function refusedOrder(): Promise<{ id: string; patientId: string }> {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`, { sex: "UNK" });
    const id = await signedLab({ patientId });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("orm_refused:patient_sex_unrecorded");
    return { id, patientId };
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
  async function settle() {
    for (let i = 0; i < 4; i++) await dispatcher.tick();
  }

  /** `resendLabTransmission` as the real membership + Better Auth user (the audit actor). */
  const resend = (id: string, org = ORG_A, membership = member, user = USER) =>
    svc.resendLabTransmission(org, membership, id, undefined, user);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f179@x.test'),($2,'f179b@x.test')`,
      [USER, USER_B],
    );
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
         ('${PH_ACTIVE}', '1234567893', 'Sam', 'Smith', 'active'),
         ('${PH_PROVISIONAL}', NULL, 'Maybe', 'Doc', 'provisional')`,
    );
    await admin.query(
      `INSERT INTO facility (id, kind, name, status) VALUES ('${FAC_ACTIVE}', 'other', 'Reference Lab', 'active')`,
    );
    registerMdmSeams({ store: createDbMdmStore(handle.db) });
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: true, status: "executed", expiresOn: null }),
    } as never);

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M29_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m11Outbox = {
      publish: (tx: unknown, e: any) =>
        publisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    const m29Outbox = {
      publish: (tx: any, e: any) => publisher.publish(tx, { ...e, callerModule: "m29" }),
    };

    svc = createDbOrderBackend(
      handle.db,
      m11Outbox,
      buildM11OrmRequestedPorts({
        patient: hl7OrmDemographicsInTx,
        feeds: buildDrizzleOutboundFeedResolver(),
      }),
    );

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
          // The seeded feed is `mllp_plain` on loopback; the stub transport never dials, but the worker's
          // production-safe default policy (F-181) refuses plain MLLP before it reaches the transport.
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
    wires = [];
    // A test that resends without settling leaves an undelivered request in the outbox; it must not leak into the next.
    await admin.query("DELETE FROM outbox_event WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id IN ($1,$2)", [
      ORG_A,
      ORG_B,
    ]);
    await admin.query("DELETE FROM external_feed WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await seedFeed(ORG_A);
  });

  // ── The happy path: refused → fix the fact → resend → transmitted ─────────────────────────────────────────

  it("refused order → the fact is fixed → resend publishes the ORM, M29 transmits it, the applier marks it transmitted", async () => {
    const { id, patientId } = await refusedOrder();
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1); // the sign-time alert
    await settle();
    expect(wires).toHaveLength(0);

    // The office records the patient's sex — a real write on the M5 spine.
    await admin.query("UPDATE patient SET sex_assigned_at_birth='F' WHERE id=$1", [patientId]);

    const res = await resend(id);
    expect(res.outcome).toBe("requested");
    expect(res.refusalReason).toBeNull();
    expect(res.order.transmissionStatus).toBe("pending");

    // State + event committed together: `pending`, failure reason cleared, exactly ONE request published.
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("pending");
    expect(row.transmission_failure_reason).toBeNull();
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);

    await settle();
    expect(wires).toHaveLength(1);
    expect(wires[0]).toContain("ORM^O01");
    const after = await orderRow(id);
    expect(after.status).toBe("active");
    expect(after.transmission_status).toBe("transmitted");
    expect(after.transmission_ack_code).toBe("AA");
    // No new alert: the provider was told at sign, and the resend succeeded.
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1);
  });

  it("a fixed FEED refusal resends too: no active feed at sign → operator adds the feed → resend transmits", async () => {
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const id = await signedLab({ patientId });
    expect((await orderRow(id)).transmission_failure_reason).toBe("orm_refused:no_active_feed");

    await seedFeed(ORG_A);
    const res = await resend(id);
    expect(res.outcome).toBe("requested");
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });

  it("the M4 audit trail records WHO resent it (the real user, on the order_record update)", async () => {
    const { id, patientId } = await refusedOrder();
    await admin.query("UPDATE patient SET sex_assigned_at_birth='F' WHERE id=$1", [patientId]);
    await resend(id);
    const { rows } = await admin.query(
      `SELECT actor_user_id, before->>'transmission_status' AS b, after->>'transmission_status' AS a,
              before->>'transmission_failure_reason' AS br
         FROM audit_event
        WHERE resource_kind='order_record' AND resource_id=$1 AND event_type='order_record.update'
          AND before->>'transmission_status'='failed' AND after->>'transmission_status'='pending'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: USER,
      b: "failed",
      a: "pending",
      br: "orm_refused:patient_sex_unrecorded",
    });
  });

  // ── Still refused: nothing published, no alert spam ───────────────────────────────────────────────────────

  it("a resend while the fact is STILL missing publishes nothing, raises no second alert, and leaves the order failed", async () => {
    const { id } = await refusedOrder();
    const res = await resend(id);
    expect(res.outcome).toBe("still_refused");
    expect(res.refusalReason).toBe("patient_sex_unrecorded");
    expect(res.order.transmissionStatus).toBe("failed");
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(0);
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1); // still just the sign-time alert
    await settle();
    expect(wires).toHaveLength(0);
  });

  it("a resend whose blocker CHANGED refreshes the recorded reason (still no publish, no alert)", async () => {
    const { id, patientId } = await refusedOrder();
    await admin.query("UPDATE patient SET sex_assigned_at_birth='F' WHERE id=$1", [patientId]);
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]); // sex fixed, but no feed now
    const res = await resend(id);
    expect(res.outcome).toBe("still_refused");
    expect(res.refusalReason).toBe("no_active_feed");
    expect((await orderRow(id)).transmission_failure_reason).toBe("orm_refused:no_active_feed");
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(0);
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1);
  });

  // ── Concurrency: a double resend is single-dispatch ───────────────────────────────────────────────────────

  it("two CONCURRENT resends publish ONE request and dispatch ONE message; the loser is refused 409", async () => {
    const { id, patientId } = await refusedOrder();
    await admin.query("UPDATE patient SET sex_assigned_at_birth='F' WHERE id=$1", [patientId]);

    const results = await Promise.allSettled([resend(id), resend(id)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(String(bad[0]!.reason.message)).toMatch(/ORM resend not allowed \(not_failed\)/);
    expect(bad[0]!.reason.statusCode).toBe(409);

    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
    await settle();
    expect(wires).toHaveLength(1);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM hl7_message_outbound WHERE organization_id=$1",
      [ORG_A],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a SEQUENTIAL second resend after success is refused (not_failed) and publishes nothing more", async () => {
    const { id, patientId } = await refusedOrder();
    await admin.query("UPDATE patient SET sex_assigned_at_birth='F' WHERE id=$1", [patientId]);
    await resend(id);
    await expect(resend(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_failed"),
    });
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
  });

  // ── Only an orm_refused:* failure is resendable ───────────────────────────────────────────────────────────

  it("a DELIVERED order is not resendable (not_failed)", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const id = await signedLab({ patientId });
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    await expect(resend(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_failed"),
    });
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
  });

  it("an M29 terminal failure (the message WAS built and sent) is not resendable — no duplicate outbound message", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const id = await signedLab({ patientId });
    await settle();
    // What F-177's applier writes on `m29.lab_order.transmission_failed`.
    await admin.query(
      "UPDATE order_record SET transmission_status='failed', transmission_failure_reason='dlq_exhausted' WHERE id=$1",
      [id],
    );
    await expect(resend(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_an_orm_refusal"),
    });
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
    expect((await orderRow(id)).transmission_failure_reason).toBe("dlq_exhausted");
  });

  it("a non-lab order is not resendable (not_a_lab_order)", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const id = await signedLab({ patientId, kind: "dme", data: { hcpcs: "E0260" } });
    await expect(resend(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_a_lab_order"),
    });
  });

  // ── Never resendable ──────────────────────────────────────────────────────────────────────────────────────

  it("a SUD refusal is NEVER resendable — not even after the flag is cleared (compliance decision, not a data fix)", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`, { sud: true });
    const id = await signedLab({ patientId });
    expect((await orderRow(id)).transmission_failure_reason).toBe("orm_refused:sud_restricted");

    await expect(resend(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("sud_restricted"),
    });
    // Clearing the M5 flag does NOT turn the resend into an override: the refusal is still not resendable.
    await admin.query("DELETE FROM patient_privacy_flag_snapshot WHERE patient_id=$1", [patientId]);
    await expect(resend(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("sud_restricted"),
    });

    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(0);
    expect((await orderRow(id)).transmission_failure_reason).toBe("orm_refused:sud_restricted");
    await settle();
    expect(wires).toHaveLength(0);
  });

  it("a refusal whose fact lives in the immutable signed order needs a corrected order (needs_corrected_order)", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const id = await signedLab({ patientId, data: { testCodes: LOINC, fastingRequired: false } }); // no routingLabId
    expect((await orderRow(id)).transmission_failure_reason).toBe("orm_refused:no_routing_lab");
    await expect(resend(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("needs_corrected_order"),
    });
  });

  // ── The order DETAIL read the resend UI keys on ──────────────────────────────────────────────────────────

  const RECOVERER = {
    membershipId: "",
    roles: [],
    disciplines: [],
    permissions: new Set(["orders.read", "orders.transmission.recover"]),
  };
  const READER = { ...RECOVERER, permissions: new Set(["orders.read", "orders.amend"]) };

  it("the detail read (as wardenx_app) carries the failure reason + resend_transmission for a recover holder only", async () => {
    const { id, patientId } = await refusedOrder();

    const asRecoverer = await svc.getOrder(ORG_A, id, RECOVERER);
    expect(asRecoverer.transmissionStatus).toBe("failed");
    expect(asRecoverer.transmissionFailureReason).toBe("orm_refused:patient_sex_unrecorded");
    expect(asRecoverer.allowedActions.resend_transmission).toBe(true);

    // A reader without a transmission-authority key sees neither the token nor the action.
    const asReader = await svc.getOrder(ORG_A, id, READER);
    expect(asReader.transmissionFailureReason).toBeNull();
    expect(asReader.allowedActions.resend_transmission).toBe(false);

    // Another tenant cannot read it at all (RLS), so the reason never crosses the boundary.
    await expect(svc.getOrder(ORG_B, id, RECOVERER)).rejects.toMatchObject({ statusCode: 404 });

    // After a successful resend the order is `pending`: no reason, nothing to resend.
    await admin.query("UPDATE patient SET sex_assigned_at_birth='F' WHERE id=$1", [patientId]);
    await resend(id);
    const after = await svc.getOrder(ORG_A, id, RECOVERER);
    expect(after.transmissionFailureReason).toBeNull();
    expect(after.allowedActions.resend_transmission).toBe(false);
  });

  it("a SUD refusal shows its reason to the recover holder but is never offered for resend", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`, { sud: true });
    const id = await signedLab({ patientId });
    const view = await svc.getOrder(ORG_A, id, RECOVERER);
    expect(view.transmissionFailureReason).toBe("orm_refused:sud_restricted");
    expect(view.allowedActions.resend_transmission).toBe(false);
    expect((await svc.getOrder(ORG_A, id, READER)).transmissionFailureReason).toBeNull();
  });

  it("the list read does not carry the failure reason (detail-only)", async () => {
    const { id, patientId } = await refusedOrder();
    const { orders } = await svc.listOrders(ORG_A, { patientId });
    const listed = orders.find((o) => o.id === id) as Record<string, unknown> | undefined;
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("transmissionFailureReason");
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────────────────────────────────────

  it("another tenant's order is 404 (RLS) and is left untouched", async () => {
    const { id, patientId } = await refusedOrder();
    await admin.query("UPDATE patient SET sex_assigned_at_birth='F' WHERE id=$1", [patientId]);
    await expect(resend(id, ORG_B, memberB, USER_B)).rejects.toMatchObject({ statusCode: 404 });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(0);
  });

  it("an unknown order id is 404", async () => {
    await expect(resend(randomUUID())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("without the ORM ports (not configured) a resend is refused, never a silent no-op", async () => {
    const bare = createDbOrderBackend(handle.db);
    const { id } = await refusedOrder();
    await expect(
      bare.resendLabTransmission(ORG_A, member, id, undefined, USER),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_configured"),
    });
  });
});
