/**
 * F-187 (#248) — a lab order SUPERSEDED (discontinued, or replaced by a corrected order) after its ORM may already be
 * at the laboratory raises an operator alert — proven end to end over real Postgres.
 *
 * T-29.08 defines ONE outbound message (`ORM^O01`, `ORC-1 = NW`) and no cancel, so nothing withdraws an ORM that was
 * already sent. The specs DO support telling a human: `lab-cancellation-required.ts` consumes `m11.order.discontinued`
 * and `m11.order.corrected` and raises the M36 alert (ids only) when the order may still be at the lab. This drives:
 *
 *   sign (as the NOBYPASSRLS `chartwarden_app` role, real catalog-validating publisher) → `m11.order.hl7_orm_requested` →
 *   M29's real T08 worker → a STUB `MllpTransport` AA → F-177's applier → `transmitted` → discontinue / correct →
 *   the relay → the consumer → ONE alert.
 *
 * And the guards, each negative-tested (the assertion fails with the guard removed):
 *   - an order whose ORM was REFUSED (`orm_refused:*`) never left the building → NO alert;
 *   - results already received → NO alert; a never-signed order → NO alert;
 *   - a double discontinue (the second is an illegal transition) and repeated relay ticks → exactly ONE alert;
 *   - a correction alerts about the ORIGINAL and carries the replacement's id (the pair is linked by
 *     `replaces_order_id`, which the order detail already exposes);
 *   - another tenant's order id is invisible to the consumer (RLS) → NO alert; no PHI in the alert payload.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:lab-cancellation:live
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
import {
  M11_LAB_CANCELLATION_ALERT_TYPE,
  M11_OUTBOX_EVENTS,
  buildM11LabCancellationConsumer,
} from "../src/modules/11-orders/index";
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

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

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
const DISCONTINUE = { reason: "clinical_judgement" as const };

interface CapturedAlert {
  readonly organizationId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly severity: string;
  readonly correlationId: string;
}

describe.skipIf(!DB_URL)("F-187 — lab-order supersession alert, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let cancellation: ReturnType<typeof buildM11LabCancellationConsumer>;
  let member: string;
  let alerts: CapturedAlert[] = [];
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

  async function seedFeed(organizationId: string): Promise<void> {
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, host, port, protocol, channel_cert_pin,
          status, proposed_by_membership_id, rate_limit_msg_per_sec, lab_destination_facility_id,
          msh_sending_application, msh_sending_facility, msh_receiving_application, msh_receiving_facility)
       VALUES ($1,$2,'orm_outbound','Reference Lab','127.0.0.1',2575,'mllp_plain',NULL,'active',$3,1000,$4,
               'WARDENX','HOSPICE-A','REFLAB','REFLAB-FAC')`,
      [randomUUID(), organizationId, randomUUID(), FAC_ACTIVE],
    );
  }

  async function seedPatient(
    id: string,
    organizationId: string,
    mrn: string,
    sex = "F",
  ): Promise<void> {
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,$3,'Jane','Doe','1950-04-05',$4)`,
      [id, organizationId, mrn, sex],
    );
  }

  async function draftLab(patientId: string): Promise<string> {
    const draft = await svc.createDraft(
      ORG_A,
      member,
      {
        patientId,
        admissionId: ADMISSION,
        kind: "lab" as never,
        drafterDiscipline: "rn_case_manager",
        data: LAB_DATA,
        orderingPhysicianMdmId: PH_ACTIVE,
      },
      SYSTEM_ORDER_ACTOR,
    );
    return draft.id;
  }
  async function signedLab(patientId: string): Promise<string> {
    const id = await draftLab(patientId);
    await svc.requestSignature(
      ORG_A,
      id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.signOrder(
      ORG_A,
      member,
      id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    return id;
  }

  async function settle() {
    for (let i = 0; i < 4; i++) await dispatcher.tick();
  }
  async function orderRow(id: string) {
    const { rows } = await admin.query(
      "SELECT status, transmission_status, transmission_failure_reason, results_status, replaces_order_id, signed_at FROM order_record WHERE id=$1",
      [id],
    );
    return rows[0];
  }

  /** A good patient's lab order, signed, sent by the real worker and applied → `transmitted`. */
  async function transmittedOrder(): Promise<{ id: string; patientId: string }> {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const id = await signedLab(patientId);
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    return { id, patientId };
  }

  const discontinue = (id: string) =>
    svc.discontinueOrder(
      ORG_A,
      member,
      id,
      {
        ...DISCONTINUE,
        effectiveAt: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
  const alertsFor = (orderId: string) => alerts.filter((a) => a.payload.orderId === orderId);

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
      `INSERT INTO "user" (id,email) VALUES ($1,'f184@x.test'),($2,'f184b@x.test')`,
      [USER, USER_B],
    );
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [USER_B, ORG_B],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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

    cancellation = buildM11LabCancellationConsumer({
      db: handle.db,
      alerts: {
        emit: async (organizationId, input) => {
          alerts.push({ organizationId, ...input });
        },
      },
    });

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
        buildM11LabTransmissionApplierConsumer({ db: handle.db, outbox: m11Outbox }),
        cancellation,
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
    alerts = [];
    await admin.query("DELETE FROM outbox_event WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id IN ($1,$2)", [
      ORG_A,
      ORG_B,
    ]);
    await admin.query("DELETE FROM external_feed WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await seedFeed(ORG_A);
  });

  // ── A transmitted order that is discontinued must reach a human ───────────────────────────────────────────

  it("a TRANSMITTED lab order is discontinued → exactly one alert, ids only, to the patient's care team", async () => {
    const { id, patientId } = await transmittedOrder();
    await discontinue(id);
    await settle();

    const got = alertsFor(id);
    expect(got).toHaveLength(1);
    const alert = got[0] as CapturedAlert;
    expect(alert.organizationId).toBe(ORG_A);
    expect(alert.eventType).toBe(M11_LAB_CANCELLATION_ALERT_TYPE);
    expect(alert.severity).toBe("warn");
    expect(alert.correlationId).toBe(`m11-lab-cancel:${id}`);
    expect(alert.payload).toMatchObject({
      orderId: id,
      patientId, // the care-team resolver's `patientIdPath`
      supersededBy: "discontinued",
      discontinuationReason: "clinical_judgement",
      labState: "transmitted",
      replacedByOrderId: null,
    });
    // No PHI content: the seeded patient's name / MRN never appear in the alert.
    const blob = JSON.stringify(alert);
    expect(blob).not.toContain("Jane");
    expect(blob).not.toContain("Doe");
    expect(blob).not.toContain("MRN-");
  });

  it("a double discontinue (the second is an illegal transition) and repeated relay ticks yield ONE alert", async () => {
    const { id } = await transmittedOrder();
    await discontinue(id);
    await expect(discontinue(id)).rejects.toThrow();
    for (let i = 0; i < 3; i++) await settle();
    expect(alertsFor(id)).toHaveLength(1);
  });

  // ── Nothing is at the lab: no alert ────────────────────────────────────────────────────────────────────────

  it("an order whose ORM was REFUSED at sign time never left the building → NO alert", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`, "UNK"); // → orm_refused:patient_sex_unrecorded
    const id = await signedLab(patientId);
    await settle();
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("orm_refused:patient_sex_unrecorded");

    await discontinue(id);
    await settle();
    expect(wires).toHaveLength(0);
    expect(alertsFor(id)).toHaveLength(0);
  });

  it("a lab order that was never signed (nothing was requested) is superseded → NO alert", async () => {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const id = await draftLab(patientId);
    await svc.requestSignature(
      ORG_A,
      id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    ); // pending_signature, never signed
    const replacement = await svc.correctOrder(
      ORG_A,
      member,
      id,
      {
        patientId,
        admissionId: ADMISSION,
        kind: "lab" as never,
        drafterDiscipline: "rn_case_manager",
        data: LAB_DATA,
        orderingPhysicianMdmId: PH_ACTIVE,
      },
      SYSTEM_ORDER_ACTOR,
    );
    await settle();
    // The correction really happened (so this is not vacuous). The trap this pins: `insertDraft` writes
    // transmission_status='pending' on EVERY lab draft, so `pending` alone must NOT read as "an ORM is in flight" —
    // only `signed_at` says the emitter ever ran.
    const original = await orderRow(id);
    expect(original.status).toBe("discontinued");
    expect(original.transmission_status).toBe("pending");
    expect(original.signed_at).toBeNull();
    expect(replacement.replacesOrderId).toBe(id);
    expect(wires).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it("results are already back (the lab has finished) → NO alert", async () => {
    const { id } = await transmittedOrder();
    await admin.query("UPDATE order_record SET results_status='results_received' WHERE id=$1", [
      id,
    ]);
    await discontinue(id);
    await settle();
    expect(alertsFor(id)).toHaveLength(0);
  });

  // ── The other states where the ORM may still be (or have been) at the lab ────────────────────────────────

  it.each([
    ["pending", null, "in_flight"],
    ["pending_retry", null, "in_flight"],
    ["failed", "dlq_exhausted", "delivery_unverified"],
    ["failed", "application_reject", "delivery_unverified"],
  ])(
    "transmission_status=%s (%s) at discontinuation → alert labState=%s",
    async (status, reason, labState) => {
      const { id } = await transmittedOrder();
      await admin.query(
        "UPDATE order_record SET transmission_status=$2, transmission_failure_reason=$3 WHERE id=$1",
        [id, status, reason],
      );
      await discontinue(id);
      await settle();
      const got = alertsFor(id);
      expect(got).toHaveLength(1);
      expect(got[0]?.payload.labState).toBe(labState);
    },
  );

  // ── A correction: the ORIGINAL is at the lab; the replacement goes out as a second ORM ─────────────────────

  it("correcting a TRANSMITTED lab order alerts about the ORIGINAL and links the replacement", async () => {
    const { id, patientId } = await transmittedOrder();
    const replacement = await svc.correctOrder(
      ORG_A,
      member,
      id,
      {
        patientId,
        admissionId: ADMISSION,
        kind: "lab" as never,
        drafterDiscipline: "rn_case_manager",
        data: { ...LAB_DATA, fastingRequired: true },
        orderingPhysicianMdmId: PH_ACTIVE,
      },
      SYSTEM_ORDER_ACTOR,
    );
    await settle();

    // The supersede trigger discontinued the original silently and linked the pair.
    expect((await orderRow(id)).status).toBe("discontinued");
    expect((await orderRow(replacement.id)).replaces_order_id).toBe(id);
    expect(replacement.replacesOrderId).toBe(id);

    const got = alertsFor(id);
    expect(got).toHaveLength(1);
    expect(got[0]?.payload).toMatchObject({
      orderId: id,
      supersededBy: "corrected",
      replacedByOrderId: replacement.id,
      labState: "transmitted",
      discontinuationReason: null,
    });
    // The replacement is an unsigned draft: nothing is at the lab for IT, so it raises nothing itself.
    expect(alertsFor(replacement.id)).toHaveLength(0);
    expect(alerts).toHaveLength(1);
  });

  it("a stale/misrouted event for an order that is NOT discontinued raises nothing (state is re-read, never trusted)", async () => {
    const { id } = await transmittedOrder(); // still `active`
    await cancellation.handle({
      eventType: "m11.order.discontinued",
      organizationId: ORG_A,
      payload: { orderId: id, discontinuationId: randomUUID(), reason: "clinical_judgement" },
    });
    expect(alerts).toHaveLength(0);
  });

  // ── Tenancy ────────────────────────────────────────────────────────────────────────────────────────────────

  it("another tenant's order id is invisible to the consumer (RLS as chartwarden_app) → NO alert", async () => {
    const { id } = await transmittedOrder();
    await discontinue(id);
    alerts = [];
    // The same event, mis-addressed to ORG_B: the order row is not visible in ORG_B's tenancy context.
    await cancellation.handle({
      eventType: "m11.order.discontinued",
      organizationId: ORG_B,
      payload: { orderId: id, discontinuationId: randomUUID(), reason: "clinical_judgement" },
    });
    expect(alerts).toHaveLength(0);
    // …and the real tenant still gets its alert (the negative above is not a broken consumer).
    await cancellation.handle({
      eventType: "m11.order.discontinued",
      organizationId: ORG_A,
      payload: { orderId: id, discontinuationId: randomUUID(), reason: "clinical_judgement" },
    });
    expect(alerts).toHaveLength(1);
  });
});
