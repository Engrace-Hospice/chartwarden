/**
 * F-178 (#248) — M11's PRODUCER of `m11.order.hl7_orm_requested`, proven end to end over real Postgres.
 *
 * F-175 built M29's outbound T08 worker and F-177 built M11's `LabTransmissionApplier`, and NOTHING published the
 * event between them: a signed lab order never became an HL7 ORM and `transmission_status` never left `pending`.
 * This drives the WHOLE chain with nothing stubbed but the wire and the vendor seams:
 *
 *   real M11 write service (SIGN, as the NOBYPASSRLS `wardenx_app` role)
 *     → gathers M5 demographics + the M40 physician + the M40 facility + M29's single active feed IN the sign tx
 *     → the real catalog-validating publisher writes `m11.order.hl7_orm_requested`
 *     → the real dispatcher delivers it to M29's real T08 worker
 *     → a STUB `MllpTransport` returns an AA ack (the only fake — there is no network)
 *     → M29 publishes `m29.lab_order.transmitted`
 *     → the real dispatcher delivers it to F-177's applier → `order_record.transmission_status = 'transmitted'`.
 *
 * And the other half of the contract — REFUSE, NEVER FABRICATE: SUD-restricted patient, unrecorded sex, a
 * deactivated or provisional physician, no routing lab, an inactive lab facility, a multi-test order, another
 * tenant's patient, no/ambiguous outbound feed, and a throwing dependency each leave the order signed, mark
 * `transmission_status = 'failed'` with `orm_refused:<reason>`, alert the ordering provider
 * (`m11.order.transmission_terminal_failed`, `transmittedAttempts: 0`), and put NOTHING on the wire.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m11:orm-requested:live
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
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { buildM11OrmRequestedPorts } from "../src/modules/11-orders/orm-request/ports";
import { buildM11LabTransmissionApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-transmission-applier";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { hl7OrmDemographicsInTx } from "../src/modules/05-patient/seams/hl7-orm-demographics";
import { createDbMdmStore, registerMdmSeams } from "../src/modules/40-mdm/index";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/events-by-m29";
import type { OutboundTenantKeyProvider } from "../src/modules/29-external-interfaces/outbound/dispatch-crypto";
import { buildM29OutboundDispatchConsumer } from "../src/modules/29-external-interfaces/outbound/dispatch-worker";
import { buildDrizzleOutboundFeedResolver } from "../src/modules/29-external-interfaces/outbound/feed-resolver";
import { parseMshEnvelope } from "../src/modules/29-external-interfaces/listener/mllp-framing";
import type {
  MllpTransport,
  MllpTransportSendInput,
} from "../src/modules/29-external-interfaces/outbound/mllp-transport";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

const PH_ACTIVE = "a0000000-0000-0000-0000-000000000001";
const PH_DEACTIVATED = "a0000000-0000-0000-0000-000000000002";
const PH_PROVISIONAL = "a0000000-0000-0000-0000-000000000003";
const FAC_ACTIVE = "b0000000-0000-0000-0000-000000000001";
const FAC_INACTIVE = "b0000000-0000-0000-0000-000000000002";
const FAC_UNKNOWN = "b0000000-0000-0000-0000-0000000000ff";

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

describe.skipIf(!DB_URL)("F-178 — M11 lab-order ORM producer → M29 worker → F-177 applier, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let member: string;
  let wires: string[] = [];

  // Patients (all ORG_A unless named).
  const P_OK = randomUUID();
  const P_SUD = randomUUID();
  const P_UNK_SEX = randomUUID();
  const P_OF_ORG_B = randomUUID();

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

  async function seedFeed(organizationId: string, port: number): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, host, port, protocol, channel_cert_pin,
          status, proposed_by_membership_id, rate_limit_msg_per_sec, lab_destination_facility_id,
          msh_sending_application, msh_sending_facility, msh_receiving_application, msh_receiving_facility)
       VALUES ($1,$2,'orm_outbound','Reference Lab','127.0.0.1',$3,'mllp_plain',NULL,'active',$4,1000,$5,
               'WARDENX','HOSPICE-A','REFLAB','REFLAB-FAC')`,
      [id, organizationId, port, randomUUID(), FAC_ACTIVE],
    );
    return id;
  }

  async function seedPatient(
    id: string,
    organizationId: string,
    mrn: string,
    over: { sex?: string; sud?: boolean; address?: boolean } = {},
  ): Promise<void> {
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,$3,'Jane','Doe','1950-04-05',$4)`,
      [id, organizationId, mrn, over.sex ?? "F"],
    );
    if (over.address !== false) {
      await admin.query(
        `INSERT INTO patient_address (patient_id, organization_id, kind, line1, city, state, postal_code, is_primary, effective_from)
         VALUES ($1,$2,'home','1 Main St','Springfield','OR','97477',true,'2020-01-01')`,
        [id, organizationId],
      );
    }
    if (over.sud) {
      await admin.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags) VALUES ($1,$2,ARRAY['sud'])`,
        [id, organizationId],
      );
    }
  }

  async function signedLab(over: {
    patientId?: string;
    physician?: string;
    data?: Record<string, unknown>;
    kind?: string;
    service?: ReturnType<typeof createDbOrderBackend>;
  } = {}): Promise<string> {
    const s = over.service ?? svc;
    const draft = await s.createDraft(ORG_A, member, {
      patientId: over.patientId ?? P_OK,
      admissionId: ADMISSION,
      kind: (over.kind ?? "lab") as never,
      drafterDiscipline: "rn_case_manager",
      data:
        over.data ??
        { testCodes: LOINC, fastingRequired: true, collectionInstructions: "Draw before 8am", routingLabId: FAC_ACTIVE },
      orderingPhysicianMdmId: over.physician ?? PH_ACTIVE,
    });
    await s.requestSignature(ORG_A, draft.id, { signerDiscipline: "rn_case_manager" });
    await s.signOrder(ORG_A, member, draft.id, {
      signerDiscipline: "rn_case_manager",
      signedAtClient: new Date().toISOString(),
    });
    return draft.id;
  }

  async function events(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }
  async function payloadOf(aggregateId: string, eventType: string) {
    const { rows } = await admin.query(
      "SELECT payload, organization_id FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [aggregateId, eventType],
    );
    return rows[0] as { payload: Record<string, any>; organization_id: string } | undefined;
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

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f178@x.test')`, [USER]);
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // M40 — the REAL canonical store, as production binds it. Physicians: one active + confirmed NPI, one
    // deactivated, one provisional (no NPI). Facilities: one active lab, one deactivated.
    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, status) VALUES
         ('${PH_ACTIVE}', '1234567893', 'Sam', 'Smith', 'active'),
         ('${PH_DEACTIVATED}', '1122334455', 'Old', 'Doc', 'deactivated'),
         ('${PH_PROVISIONAL}', NULL, 'Maybe', 'Doc', 'provisional')`,
    );
    await admin.query(
      `INSERT INTO facility (id, kind, name, status) VALUES
         ('${FAC_ACTIVE}', 'other', 'Reference Lab', 'active'),
         ('${FAC_INACTIVE}', 'other', 'Closed Lab', 'deactivated')`,
    );
    registerMdmSeams({ store: createDbMdmStore(handle.db) });
    // M29's D16 BAA gate: an executed BAA for every facility (the gate's own logic is M29's, proven in F-175).
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: true, status: "executed", expiresOn: null }),
    } as never);

    await seedPatient(P_OK, ORG_A, "MRN-OK");
    await seedPatient(P_SUD, ORG_A, "MRN-SUD", { sud: true });
    await seedPatient(P_UNK_SEX, ORG_A, "MRN-UNK", { sex: "UNK" });
    await seedPatient(P_OF_ORG_B, ORG_B, "MRN-B");

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M29_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m11Outbox = { publish: (tx: unknown, e: any) => publisher.publish(tx as never, { ...e, callerModule: "m11" }) };
    const m29Outbox = { publish: (tx: any, e: any) => publisher.publish(tx, { ...e, callerModule: "m29" }) };

    svc = createDbOrderBackend(
      handle.db,
      m11Outbox,
      buildM11OrmRequestedPorts({ patient: hl7OrmDemographicsInTx, feeds: buildDrizzleOutboundFeedResolver() }),
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
          // F-178 — the seeded feed is `mllp_plain` on loopback; the stub transport never dials, but the
          // worker's production-safe default policy refuses plain MLLP before it reaches the transport.
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
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM external_feed WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await seedFeed(ORG_A, 2575);
  });

  // ── The whole chain ────────────────────────────────────────────────────────────────────────────────────

  it("a signed lab order publishes the catalogued ORM request, M29 transmits it, and the applier marks the order transmitted", async () => {
    const id = await signedLab();

    // Produced IN the sign transaction, with every fact resolved — not fabricated.
    const requested = await payloadOf(id, "m11.order.hl7_orm_requested");
    expect(requested, "no ORM request was published").toBeDefined();
    expect(requested?.organization_id).toBe(ORG_A);
    expect(requested?.payload).toMatchObject({
      orderId: id,
      organizationId: ORG_A,
      labDestinationFacilityId: FAC_ACTIVE,
      priority: "R",
      labOrderPayload: {
        patientId: P_OK,
        placerOrderNumber: id.replace(/-/g, ""),
        observationIdentifier: { code: "2345-7", text: "Glucose", codingSystem: "LN" },
        orderingProviderNpi: "1234567893",
        orderingProviderName: { family: "Smith", given: "Sam" },
        clinicalNotes: ["FASTING REQUIRED", "Draw before 8am"],
        patientDemographics: {
          mrn: "MRN-OK",
          internalMrnAuthority: `WARDENX-${ORG_A}`,
          familyName: "Doe",
          givenName: "Jane",
          dateOfBirth: "1950-04-05",
          administrativeSex: "F",
          addressLine1: "1 Main St",
          addressCity: "Springfield",
          addressState: "OR",
          addressPostal: "97477",
        },
      },
    });
    expect((await orderRow(id)).transmission_status).toBe("pending");

    await settle();

    // M29's worker built and "sent" the real ORM^O01 wire.
    expect(wires).toHaveLength(1);
    expect(wires[0]).toContain("ORM^O01");
    expect(wires[0]).toContain("MRN-OK^^^WARDENX-");
    expect(wires[0]).toContain("Doe^Jane");
    expect(wires[0]).toContain("1234567893^Smith^Sam");
    expect(wires[0]).toContain("2345-7^Glucose^LN");

    // …and F-177's applier moved the order off `pending`.
    const row = await orderRow(id);
    expect(row.status).toBe("active");
    expect(row.transmission_status).toBe("transmitted");
    expect(row.transmission_ack_code).toBe("AA");
    expect(await events(id)).toEqual(
      expect.arrayContaining(["m11.order.hl7_orm_requested", "m11.order.transmission_status_changed"]),
    );
    expect(await events(id)).not.toContain("m11.order.transmission_terminal_failed");
  });

  it("a signed NON-lab order emits no ORM and never touches transmission_status", async () => {
    const id = await signedLab({ kind: "dme", data: { hcpcs: "E0260" } });
    expect(await events(id)).not.toContain("m11.order.hl7_orm_requested");
    expect(await events(id)).not.toContain("m11.order.transmission_terminal_failed");
    expect((await orderRow(id)).transmission_status).toBe("not_required");
    await settle();
    expect(wires).toHaveLength(0);
  });

  it("without the ORM ports (the default) a signed lab emits nothing — the pre-F-178 behavior is preserved", async () => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
    const bare = createDbOrderBackend(handle.db, {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m11" }),
    });
    const id = await signedLab({ service: bare });
    expect(await events(id)).not.toContain("m11.order.hl7_orm_requested");
    expect((await orderRow(id)).transmission_status).toBe("pending");
  });

  // ── REFUSE, NEVER FABRICATE ─────────────────────────────────────────────────────────────────────────────

  async function expectRefused(id: string, reason: string) {
    const row = await orderRow(id);
    // The order is still SIGNED — the ORM failing must never un-sign or block the order itself.
    expect(row.status).toBe("active");
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe(`orm_refused:${reason}`);
    const ev = await events(id);
    expect(ev).toContain("m11.order.signed");
    expect(ev).not.toContain("m11.order.hl7_orm_requested");
    const alert = await payloadOf(id, "m11.order.transmission_terminal_failed");
    expect(alert?.payload).toMatchObject({
      orderId: id,
      organizationId: ORG_A,
      failureReason: `orm_refused:${reason}`,
      transmittedAttempts: 0,
      orderingPhysicianMdmId: expect.any(String),
    });
    // Nothing went on the wire, ever.
    await settle();
    expect(wires).toHaveLength(0);
  }

  it("a SUD-restricted patient is REFUSED (42 CFR Part 2) — no demographics leave", async () => {
    const id = await signedLab({ patientId: P_SUD });
    await expectRefused(id, "sud_restricted");
  });

  it("an invalidated SUD snapshot still refuses (fail-closed: stale is not evidence the restriction lapsed)", async () => {
    const p = randomUUID();
    await seedPatient(p, ORG_A, `MRN-${p.slice(0, 6)}`, { sud: true });
    await admin.query("UPDATE patient_privacy_flag_snapshot SET invalidated_at = now() WHERE patient_id=$1", [p]);
    await expectRefused(await signedLab({ patientId: p }), "sud_restricted");
  });

  it("an unrecorded sex (M5's UNK default) is REFUSED, not turned into HL7 'U'", async () => {
    await expectRefused(await signedLab({ patientId: P_UNK_SEX }), "patient_sex_unrecorded");
  });

  it("another tenant's patient is REFUSED as not found — the read is org-scoped", async () => {
    await expectRefused(await signedLab({ patientId: P_OF_ORG_B }), "patient_not_found");
  });

  it("a deactivated ordering physician is REFUSED", async () => {
    await expectRefused(await signedLab({ physician: PH_DEACTIVATED }), "physician_not_active");
  });

  it("a provisional ordering physician (no confirmed NPI) is REFUSED", async () => {
    await expectRefused(await signedLab({ physician: PH_PROVISIONAL }), "physician_npi_unconfirmed");
  });

  it("an unknown ordering physician id is REFUSED", async () => {
    await expectRefused(await signedLab({ physician: randomUUID() }), "physician_unresolved");
  });

  it("an order with no routingLabId is REFUSED (no destination facility to BAA-gate)", async () => {
    await expectRefused(await signedLab({ data: { testCodes: LOINC, fastingRequired: false } }), "no_routing_lab");
  });

  it("an inactive or unknown routing lab facility is REFUSED", async () => {
    const data = (routingLabId: string) => ({ testCodes: LOINC, fastingRequired: false, routingLabId });
    await expectRefused(await signedLab({ data: data(FAC_INACTIVE) }), "lab_facility_unresolved");
    await expectRefused(await signedLab({ data: data(FAC_UNKNOWN) }), "lab_facility_unresolved");
  });

  it("a multi-test order is REFUSED rather than silently dropping tests", async () => {
    const id = await signedLab({
      data: {
        testCodes: [...LOINC, { system: "http://loinc.org", code: "718-7", display: "Hemoglobin" }],
        fastingRequired: false,
        routingLabId: FAC_ACTIVE,
      },
    });
    await expectRefused(id, "multiple_test_codes_unsupported");
  });

  it("no active outbound feed is REFUSED at sign time (M29 would only alert and drop it)", async () => {
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
    await expectRefused(await signedLab(), "no_active_feed");
  });

  it("an AMBIGUOUS outbound feed (two active) is REFUSED — routing must never guess", async () => {
    await seedFeed(ORG_A, 2576);
    await expectRefused(await signedLab(), "ambiguous_feed");
  });

  it("a dependency that throws refuses (dependency_unavailable) — it does not fail the sign", async () => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
    const flaky = createDbOrderBackend(
      handle.db,
      { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m11" }) },
      buildM11OrmRequestedPorts({
        patient: hl7OrmDemographicsInTx,
        feeds: buildDrizzleOutboundFeedResolver(),
        mdm: () => {
          throw new Error("M40 unavailable");
        },
      }),
    );
    const id = await signedLab({ service: flaky });
    await expectRefused(id, "dependency_unavailable");
  });

  // ── Isolation ───────────────────────────────────────────────────────────────────────────────────────────

  it("org B cannot see org A's ORM request or refusal through its own tenant-scoped connection", async () => {
    const ok = await signedLab();
    const refused = await signedLab({ patientId: P_SUD });
    const visibleToB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, async (tx) => {
      const r = await (tx as any).execute(
        sql`SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id IN (${ok}, ${refused})`,
      );
      return (r.rows ?? r)[0].n as number;
    });
    expect(visibleToB).toBe(0);
    const visibleToA = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
      const r = await (tx as any).execute(
        sql`SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id IN (${ok}, ${refused})`,
      );
      return (r.rows ?? r)[0].n as number;
    });
    expect(visibleToA).toBeGreaterThan(0);
  });
});
