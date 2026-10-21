/**
 * GAP-004 — the M5 §7.8 record-death cascade against REAL Postgres. `recordDeathFromDischarge`
 * (deceased-db.ts) and `buildM5DeathCascadeConsumer` (outbox-consumers/m6-discharge-death.ts) talk
 * to Drizzle + `withOrgContext` + M6's live `DeathDischargeReader` seam directly — provable only
 * against a live cluster (the gap-003-compliance-routes.live.test.ts precedent).
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/gap-004-death-cascade.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { wireModuleSeams } from "../src/index";
import {
  type M5OutboxPort,
  M5_OUTBOX_EVENTS,
  buildM5DeathCascadeConsumer,
} from "../src/modules/05-patient/index";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "wardenx_report_writer",
];
const ORG = "11111111-1111-1111-1111-111111111111";

describe.skipIf(!DB_URL)("GAP-004 death cascade — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let outbox: M5OutboxPort;
  let consumer: ReturnType<typeof buildM5DeathCascadeConsumer>;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations(): Promise<void> {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap004','GAP-004 Org','GAP-004 Org')",
      [ORG],
    );
    await admin.query("ALTER ROLE chartwarden_app LOGIN PASSWORD 'wardenx-gap004-test'");
    const appUrl = new URL(DB_URL as string);
    appUrl.username = "chartwarden_app";
    appUrl.password = "wardenx-gap004-test";
    handle = createDbClient({ connectionString: appUrl.toString() });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(() => {
    // Registers M6's REAL Drizzle-backed DeathDischargeReader seam (registerAdmissionSeams, inside
    // wireModuleSeams) — the exact seam the consumer resolves the decedent's patientId through.
    wireModuleSeams({ db: handle.db });

    const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS]);
    const txPublisher = buildTxOutboxPublisher(catalog);
    outbox = { publish: (tx, input) => txPublisher.publish(tx, { ...input, callerModule: "m5" }) };
    consumer = buildM5DeathCascadeConsumer({ db: handle.db, outbox });
  });

  afterEach(async () => {
    await admin.query("TRUNCATE discharge_event, admission, patient RESTART IDENTITY CASCADE");
    await admin.query("DELETE FROM outbox_event");
  });

  async function seedPatient(status = "active"): Promise<string> {
    const result = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1, $2, 'Jane', 'Doe', '1950-01-01', 'female', $3) RETURNING id`,
      [ORG, `mrn-${Math.random().toString(36).slice(2)}`, status],
    );
    return result.rows[0].id;
  }

  async function seedDeathDischarge(
    patientId: string,
    dischargeDate: string,
  ): Promise<{ admissionId: string; dischargeEventId: string }> {
    const adm = await admin.query(
      `INSERT INTO admission (organization_id, patient_id) VALUES ($1, $2) RETURNING id`,
      [ORG, patientId],
    );
    const admissionId = adm.rows[0].id;
    const de = await admin.query(
      `INSERT INTO discharge_event (organization_id, admission_id, discharge_type, effective_at, death_at)
       VALUES ($1, $2, 'death', $3, $3::date) RETURNING id`,
      [ORG, admissionId, dischargeDate],
    );
    return { admissionId, dischargeEventId: de.rows[0].id };
  }

  it("flips patient.status='deceased', sets deceased_date, and emits m5.patient.deceased", async () => {
    const patientId = await seedPatient();
    const { admissionId, dischargeEventId } = await seedDeathDischarge(patientId, "2026-08-01");

    await consumer.handle({
      organizationId: ORG,
      payload: { dischargeEventId, admissionId, dischargeDate: "2026-08-01" },
    });

    const patientRow = await admin.query("SELECT status, deceased_date FROM patient WHERE id=$1", [
      patientId,
    ]);
    expect(patientRow.rows[0].status).toBe("deceased");
    expect(new Date(patientRow.rows[0].deceased_date).toISOString().slice(0, 10)).toBe(
      "2026-08-01",
    );

    const outboxRows = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m5.patient.deceased' AND aggregate_id=$1",
      [patientId],
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0].payload).toEqual({
      patientId,
      organizationId: ORG,
      deceasedDate: "2026-08-01",
    });
  });

  it("is idempotent on redelivery: a second handle() no-ops rather than erroring or double-emitting", async () => {
    const patientId = await seedPatient();
    const { admissionId, dischargeEventId } = await seedDeathDischarge(patientId, "2026-08-01");
    const event = {
      organizationId: ORG,
      payload: { dischargeEventId, admissionId, dischargeDate: "2026-08-01" },
    };

    await consumer.handle(event);
    await expect(consumer.handle(event)).resolves.toBeUndefined();

    const outboxRows = await admin.query(
      "SELECT id FROM outbox_event WHERE event_type='m5.patient.deceased' AND aggregate_id=$1",
      [patientId],
    );
    expect(outboxRows.rows).toHaveLength(1);
  });

  it.each(["prospective", "discharged"])(
    "records the death when the patient row lagged M6's activation (status '%s') and emits status_changed",
    async (lagged) => {
      const patientId = await seedPatient(lagged);
      const { admissionId, dischargeEventId } = await seedDeathDischarge(patientId, "2026-08-01");

      await consumer.handle({
        organizationId: ORG,
        payload: { dischargeEventId, admissionId, dischargeDate: "2026-08-01" },
      });

      const patientRow = await admin.query("SELECT status FROM patient WHERE id=$1", [patientId]);
      expect(patientRow.rows[0].status).toBe("deceased");
      const changed = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m5.patient.status_changed' AND aggregate_id=$1",
        [patientId],
      );
      expect(changed.rows.map((r) => r.payload)).toEqual([
        { patientId, organizationId: ORG, fromStatus: lagged, toStatus: "deceased" },
      ]);
      const deceased = await admin.query(
        "SELECT id FROM outbox_event WHERE event_type='m5.patient.deceased' AND aggregate_id=$1",
        [patientId],
      );
      expect(deceased.rows).toHaveLength(1);
    },
  );

  it("dead-letters (throws) when M6's DeathDischargeReader has no matching row for the admission", async () => {
    await expect(
      consumer.handle({
        organizationId: ORG,
        payload: {
          dischargeEventId: "99999999-9999-9999-9999-999999999999",
          admissionId: "88888888-8888-8888-8888-888888888888",
          dischargeDate: "2026-08-01",
        },
      }),
    ).rejects.toThrow(/cannot resolve the decedent/);
  });
});
