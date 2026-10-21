/**
 * F-152 (#248) — LIVE Postgres proof that M13's §2.8 D17 medication-reconciliation worksheet
 * (`buildM13ReconciliationTriggerConsumer`) actually opens real `medication_reconciliation_worksheet`
 * rows under RLS, for all four M6 trigger events.
 *
 * `decideReconciliationTrigger` + `buildReconciliationWorksheet` have been complete, pure, unit-tested
 * cores since M13-T06/T08, and `M13_OUTBOX_SUBSCRIPTIONS` has named all four M6 events with a real
 * consumer since the list was written — nothing ever bound them, and no worksheet has ever existed in
 * any deployment. This proves the real binding: two of the four trigger shapes (`m6.cti.signed`, whose
 * payload carries `patientId` directly, and `m6.transfer.created`, whose payload carries no
 * `providerEntityId`/`locationId`/due-date field named the same as the others — F-192 (#248) widened it
 * with a `patientId` for M22's own render handshake, but this consumer still needs the injected
 * `resolveAdmission` seam for the siting facts, proving the seam is actually load-bearing), idempotency
 * on redelivery (the `recon_ws_admission_trigger_uk` unique), the documented throw when an admission has
 * no location assigned, and cross-tenant isolation.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m13:reconciliation-triggers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import {
  type AdmissionAnchor,
  buildM13ReconciliationTriggerConsumer,
} from "../src/modules/13-emar/outbox-consumers/m6-reconciliation-triggers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ADMISSION_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ADMISSION_NO_LOCATION = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ADMISSION_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const PATIENT_A = "aaaaaaaa-1111-4111-8111-0000000000a1";

describe.skipIf(!DB_URL)("F-152 — M13's M6 reconciliation-trigger consumer — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerA: string;
  let providerB: string;
  let locationA: string;
  let locationB: string;
  let consumer: ReturnType<typeof buildM13ReconciliationTriggerConsumer>;

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

  async function worksheetRows(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, provider_entity_id, location_id, patient_id, admission_id,
                trigger_kind, trigger_outbox_event_id, due_at, status
         FROM medication_reconciliation_worksheet WHERE admission_id = $1`,
      [admissionId],
    );
    return rows;
  }
  async function outboxRows(organizationId: string) {
    const { rows } = await admin.query(
      `SELECT payload FROM outbox_event
         WHERE organization_id = $1 AND event_type = 'm13.reconciliation.opened'`,
      [organizationId],
    );
    return rows;
  }

  /** Fixed admission anchors — the M6 seam read itself is proven elsewhere; this test proves M13's own
   *  write, and that the injected resolver is actually consulted (not bypassed). */
  const resolveAdmission = async (
    organizationId: string,
    admissionId: string,
  ): Promise<AdmissionAnchor | null> => {
    if (organizationId === ORG_A && admissionId === ADMISSION_A) {
      return { patientId: PATIENT_A as never, providerEntityId: providerA, locationId: locationA };
    }
    if (organizationId === ORG_A && admissionId === ADMISSION_NO_LOCATION) {
      return { patientId: PATIENT_A as never, providerEntityId: providerA, locationId: null };
    }
    if (organizationId === ORG_B && admissionId === ADMISSION_B) {
      return { patientId: PATIENT_A as never, providerEntityId: providerB, locationId: locationB };
    }
    return null;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m13-recon-trigger-a','M13 Recon Trigger A','M13 Recon Trigger A'),
                ($2,'m13-recon-trigger-b','M13 Recon Trigger B','M13 Recon Trigger B')`,
      [ORG_A, ORG_B],
    );
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13RT-A','Recon Trigger Provider A','1200000001','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    providerB = (
      await admin.query(
        `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13RT-B','Recon Trigger Provider B','1200000002','enc','12-31') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;
    locationA = (
      await admin.query(
        `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'Recon Trigger Location A','1 Test St','Testville','OR','97201','America/Los_Angeles')
           RETURNING id`,
        [providerA],
      )
    ).rows[0].id as string;
    locationB = (
      await admin.query(
        `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'Recon Trigger Location B','1 Test St','Testville','OR','97201','America/Los_Angeles')
           RETURNING id`,
        [providerB],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = new Map<string, unknown>(M13_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
    consumer = buildM13ReconciliationTriggerConsumer({
      db: handle.db,
      outbox: {
        async publish(tx, input) {
          if (!catalog.has(input.eventName)) {
            throw new Error(`m13 test publisher: undeclared event ${input.eventName}`);
          }
          const { sql } = await import("drizzle-orm");
          await (tx as typeof handle.db).execute(sql`
              INSERT INTO outbox_event
                (organization_id, event_type, aggregate_kind, aggregate_id, payload)
              VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                      ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
            `);
        },
      },
      resolveAdmission,
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("opens a recertification worksheet from m6.cti.signed and publishes the opened signal", async () => {
    const eventId = "cccccccc-0000-4000-8000-000000000001";
    await consumer.handle({
      eventType: "m6.cti.signed",
      id: eventId,
      organizationId: ORG_A,
      payload: {
        ctiId: "dddddddd-0000-4000-8000-000000000001",
        electionPeriodId: "eeeeeeee-0000-4000-8000-000000000001",
        signedAt: "2026-06-01T12:00:00.000Z",
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
      },
    });

    const rows = await worksheetRows(ADMISSION_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger_kind).toBe("recertification");
    expect(rows[0].trigger_outbox_event_id).toBe(eventId);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].location_id).toBe(locationA);
    expect(new Date(rows[0].due_at).getTime()).toBe(
      new Date("2026-06-01T12:00:00.000Z").getTime() + 120 * 3_600_000,
    );

    const events = await outboxRows(ORG_A);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      admissionId: ADMISSION_A,
      patientId: PATIENT_A,
      triggerKind: "recertification",
    });
  });

  it("resolves patientId via the injected seam for m6.transfer.created, not the payload's own patientId", async () => {
    const eventId = "cccccccc-0000-4000-8000-000000000002";
    await consumer.handle({
      eventType: "m6.transfer.created",
      id: eventId,
      organizationId: ORG_A,
      payload: {
        transferEventId: "ffffffff-0000-4000-8000-000000000001",
        admissionId: ADMISSION_A,
        direction: "in",
        effectiveAt: "2026-06-05T00:00:00.000Z",
        // F-192 (#248) widened this payload with `patientId` for M22's OWN render handshake, but this
        // M13 consumer still needs `providerEntityId`/`locationId` the payload never carries — deliberately
        // a DIFFERENT patient here than `resolveAdmission`'s fixture returns, proving this consumer still
        // resolves the seam fact rather than trusting the payload's own (M22-scoped) field.
        patientId: "00000000-0000-4000-8000-0000000000ff",
      },
    });

    const rows = await worksheetRows(ADMISSION_A);
    expect(rows).toHaveLength(2); // the cti.signed row from the prior test + this one
    const transferRow = rows.find((r) => r.trigger_kind === "transfer_in");
    expect(transferRow).toBeDefined();
    expect(transferRow.patient_id).toBe(PATIENT_A); // resolved via resolveAdmission, not the payload
  });

  it("is idempotent — a redelivery of the same trigger event does not open a second worksheet", async () => {
    const eventId = "cccccccc-0000-4000-8000-000000000001"; // same event id as the first test
    await consumer.handle({
      eventType: "m6.cti.signed",
      id: eventId,
      organizationId: ORG_A,
      payload: {
        ctiId: "dddddddd-0000-4000-8000-000000000001",
        electionPeriodId: "eeeeeeee-0000-4000-8000-000000000001",
        signedAt: "2026-06-01T12:00:00.000Z",
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
      },
    });

    const rows = await worksheetRows(ADMISSION_A);
    const recertRows = rows.filter((r) => r.trigger_kind === "recertification");
    expect(recertRows).toHaveLength(1); // still just one — no duplicate
  });

  it("throws rather than guess a location when the admission has none assigned", async () => {
    await expect(
      consumer.handle({
        eventType: "m6.admission.activated",
        id: "cccccccc-0000-4000-8000-000000000003",
        organizationId: ORG_A,
        payload: {
          admissionId: ADMISSION_NO_LOCATION,
          patientId: PATIENT_A,
          activatedAt: "2026-06-10T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow(/no location assigned/);

    expect(await worksheetRows(ADMISSION_NO_LOCATION)).toHaveLength(0);
  });

  it("scopes org B's write to org B alone under RLS", async () => {
    await consumer.handle({
      eventType: "m6.cti.signed",
      id: "cccccccc-0000-4000-8000-000000000004",
      organizationId: ORG_B,
      payload: {
        ctiId: "dddddddd-0000-4000-8000-000000000004",
        electionPeriodId: "eeeeeeee-0000-4000-8000-000000000004",
        signedAt: "2026-06-15T00:00:00.000Z",
        patientId: PATIENT_A,
        admissionId: ADMISSION_B,
      },
    });

    const bRows = await worksheetRows(ADMISSION_B);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].organization_id).toBe(ORG_B);
    expect(bRows[0].provider_entity_id).toBe(providerB);

    // org A's admission id space never picked up org B's row (distinct admission ids, but the
    // organization_id column on the row itself is the load-bearing isolation check above).
    expect(await worksheetRows(ADMISSION_A)).toHaveLength(2); // unchanged from the earlier org-A tests
  });
});
