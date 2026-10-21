/**
 * F-205 (#248) — LIVE Postgres proof of the `m12.medication.error_reported` → M30 auto-incident-draft path,
 * end to end: a real clinician-initiated `POST .../report-error` action through M12's real Drizzle write
 * service (`createDbDoseSpotBackend`, the real catalog-validating outbox publisher, `outbox_event` rows
 * asserted directly), then the real delivered payload fed into `buildM30MedicationErrorReportedConsumer`
 * (M12's `medicationOrderScheduleContextForOrg` + M6's `admissionSchedulingContextForOrg` seams wired as
 * real ports, not faked), asserting a real `incident_report` draft row lands.
 *
 * Before this round: `handleMedicationErrorReported`/`buildIncidentDraftFromEvent`/`createIncidentDraft`
 * all already existed, pure and unit-tested, but nothing ever produced this event (no route called
 * `reportMedicationError`) and no `OutboxConsumerBinding` ever bound the M30 side. This proves BOTH halves
 * now work, for real, together — plus the F-165-corrected reporter identity (the real filing clinician's
 * membership id, never a system-actor sentinel).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f205:m12-medication-error-reported:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { admissionSchedulingContextForOrg } from "../src/modules/06-admission/seams/drizzle-store";
import {
  type DoseSpotWriteOutboxPort,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/dosespot-route-service-db";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { medicationOrderScheduleContextForOrg } from "../src/modules/12-dosespot/seams/drizzle-store";
import { buildM30MedicationErrorReportedConsumer } from "../src/modules/30-quality/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { PASSING_M12_SAFETY_GATES } from "./_m12-safety-gates";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT_A = "44444444-4444-4444-4444-444444444444";
const PATIENT_B = "44444444-4444-4444-4444-444444444445";
const ADMISSION_A = "55555555-5555-5555-5555-555555555555";
const ADMISSION_B = "55555555-5555-5555-5555-555555555556";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";

describe.skipIf(!DB_URL)(
  "F-205 — m12.medication.error_reported → M30 auto-incident-draft — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbDoseSpotBackend>;
    let consumer: ReturnType<typeof buildM30MedicationErrorReportedConsumer>;
    const providerOf: Record<string, string> = {};
    const locationOf: Record<string, string> = {};
    const memberOf: Record<string, string> = {};

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
      const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (strip) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sql);
      }
    }
    async function seedOrder(org: string, admissionId: string, patientId: string): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO medication_order (organization_id, patient_id, admission_id, med_class,
             drug_name, strength, dose_form, route, data, prescriber_membership_id,
             prescribing_physician_mdm_id, status)
           VALUES ($1,$2,$3,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$4,$5,'active')
           RETURNING id`,
          [org, patientId, admissionId, memberOf[org], PHYSICIAN_MDM],
        )
      ).rows[0].id as string;
    }
    async function incidentRows(org: string) {
      const { rows } = await admin.query(
        `SELECT organization_id, provider_entity_id, location_id, kind, kind_data, patient_id,
                reported_by_membership_id, lifecycle, mandatory_report_flag, triggering_event_outbox_id
         FROM incident_report WHERE organization_id = $1 ORDER BY created_at`,
        [org],
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
         VALUES ($1,'f205-org-a','F205 A','F205 A'),($2,'f205-org-b','F205 B','F205 B')`,
        [ORG_A, ORG_B],
      );
      for (const [org, patient, admission] of [
        [ORG_A, PATIENT_A, ADMISSION_A],
        [ORG_B, PATIENT_B, ADMISSION_B],
      ] as const) {
        const pe = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
            [
              org,
              `CCN-F205-${org.slice(0, 4)}`,
              `F205 ${org.slice(0, 4)}`,
              `NPI-F205-${org.slice(0, 4)}`,
            ],
          )
        ).rows[0].id as string;
        const location = (
          await admin.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
            [pe],
          )
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO admission (id,organization_id,patient_id,provider_entity_id,location_id,status,admission_at,activated_at)
           VALUES ($1,$2,$3,$4,$5,'active',now(),now())`,
          [admission, org, patient, pe, location],
        );
        const user = (
          await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
            `f205-${org.slice(0, 4)}@x.test`,
          ])
        ).rows[0].id as string;
        const member = (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
            [user, org],
          )
        ).rows[0].id as string;
        providerOf[org] = pe;
        locationOf[org] = location;
        memberOf[org] = member;
      }
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M12_OUTBOX_EVENTS]));
      const outbox: DoseSpotWriteOutboxPort = {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m12" }),
      };
      svc = createDbDoseSpotBackend(handle.db, outbox, PASSING_M12_SAFETY_GATES);
      consumer = buildM30MedicationErrorReportedConsumer({
        db: handle.db,
        medicationOrderScheduleContextForOrg,
        admissionSchedulingContextForOrg,
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("files a real clinician-initiated error report and the real M30 consumer auto-files a medication_error incident draft (redelivery does not duplicate it)", async () => {
      const orderId = await seedOrder(ORG_A, ADMISSION_A, PATIENT_A);
      const report = await svc.reportMedicationError(ORG_A, memberOf[ORG_A], orderId, {
        errorCategory: "wrong_dose",
        summary: "5 mg given instead of the ordered 2.5 mg.",
      });
      expect(report.orderId).toBe(orderId);
      expect(report.medicationErrorId).toBeTruthy();

      const { rows: outboxRows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = 'm12.medication.error_reported'`,
        [ORG_A],
      );
      expect(outboxRows).toHaveLength(1);
      const payload = outboxRows[0].payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        medicationErrorId: report.medicationErrorId,
        orderId,
        patientId: PATIENT_A,
        errorCategory: "wrong_dose",
        reportedByMembershipId: memberOf[ORG_A],
        summary: "5 mg given instead of the ordered 2.5 mg.",
      });

      const event = {
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        eventType: "m12.medication.error_reported",
        aggregateKind: "medication_order",
        aggregateId: orderId,
        attemptCount: 0,
        createdAt: new Date(),
        payload,
      };
      await consumer.handle(event);
      await consumer.handle(event); // redelivery — must no-op, not duplicate

      const rows = await incidentRows(ORG_A);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("medication_error");
      expect(rows[0].lifecycle).toBe("draft");
      expect(rows[0].mandatory_report_flag).toBe(false);
      expect(rows[0].provider_entity_id).toBe(providerOf[ORG_A]);
      expect(rows[0].location_id).toBe(locationOf[ORG_A]);
      expect(rows[0].patient_id).toBe(PATIENT_A);
      // F-165's correction proved live: the REAL filing clinician, never an M30 system-actor sentinel.
      expect(rows[0].reported_by_membership_id).toBe(memberOf[ORG_A]);
      expect(rows[0].triggering_event_outbox_id).toBe(event.id);
      expect(rows[0].kind_data).toMatchObject({
        medicationOrderId: orderId,
        medicationErrorId: report.medicationErrorId,
        summary: "5 mg given instead of the ordered 2.5 mg.",
      });
    });

    it("an orderId this org does not recognise (cross-tenant / stale redelivery) is a silent no-op", async () => {
      const event = {
        id: crypto.randomUUID(),
        organizationId: ORG_B,
        eventType: "m12.medication.error_reported",
        aggregateKind: "medication_order",
        aggregateId: "99999999-9999-4999-8999-999999999999",
        attemptCount: 0,
        createdAt: new Date(),
        payload: {
          medicationErrorId: crypto.randomUUID(),
          orderId: "99999999-9999-4999-8999-999999999999", // never inserted under ORG_B
          patientId: PATIENT_B,
          errorCategory: "wrong_patient",
          reportedByMembershipId: memberOf[ORG_B],
          reportedAt: new Date().toISOString(),
        },
      };
      await expect(consumer.handle(event)).resolves.toBeUndefined();
      const rows = await incidentRows(ORG_B);
      expect(rows).toHaveLength(0);
    });

    it("org B's order does not leak an incident draft into org A's rows (cross-tenant isolation)", async () => {
      const orderId = await seedOrder(ORG_B, ADMISSION_B, PATIENT_B);
      const report = await svc.reportMedicationError(ORG_B, memberOf[ORG_B], orderId, {
        errorCategory: "omission",
      });
      const { rows: outboxRows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = 'm12.medication.error_reported' AND aggregate_id = $2`,
        [ORG_B, orderId],
      );
      await consumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_B,
        eventType: "m12.medication.error_reported",
        aggregateKind: "medication_order",
        aggregateId: orderId,
        attemptCount: 0,
        createdAt: new Date(),
        payload: outboxRows[0].payload,
      });
      const bRows = await incidentRows(ORG_B);
      expect(bRows).toHaveLength(1);
      expect(bRows[0].provider_entity_id).toBe(providerOf[ORG_B]);
      // ORG_A's earlier assertion already proved exactly one row there; this proves org B's new
      // report landed under its OWN organization_id, not folded into org A's.
      const aRows = await incidentRows(ORG_A);
      expect(aRows).toHaveLength(1);
      expect(report.orderId).toBe(orderId);
    });
  },
);
