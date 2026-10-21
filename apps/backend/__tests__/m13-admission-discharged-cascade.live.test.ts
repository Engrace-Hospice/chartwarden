/**
 * F-155 (#248) — LIVE Postgres proof that M13's §2.5/§2.7 D14 admission-discharge cascade
 * (`buildM13AdmissionDischargedCascadeConsumer`) actually cancels future scheduled doses and flags
 * active comfort-kit deployments for return, for real, under RLS.
 *
 * `planDischargeCascade` (`@chartwarden/emar`) has been complete, pure, unit-tested since M13-T05, and
 * `M13_OUTBOX_SUBSCRIPTIONS` has named `m6.admission.discharged` with a real consumer
 * (`m13.admission-discharged-cascade`) since the list was written — nothing has ever bound it, and no
 * discharge has ever cancelled a future dose or flagged a comfort kit for return in any deployment.
 *
 * Proves: a future pending dose is cancelled with the right reason + source event id and emits
 * `m13.scheduled_dose.cancelled`; a past-due pending dose is left untouched (the missed-dose sweep owns
 * it, never retro-marked); an already-cancelled dose is left alone; a deployed comfort kit is flagged
 * `return_required` and emits `m13.comfort_kit.return_required`; a kit already `return_required` is a
 * no-op (idempotent redelivery); no reason filter — a non-death discharge reason still cascades; and
 * cross-tenant isolation (org B's rows are untouched by org A's discharge).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m13:admission-discharged-cascade:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import {
  type DischargeCascadeAdmissionAnchor,
  buildM13AdmissionDischargedCascadeConsumer,
} from "../src/modules/13-emar/outbox-consumers/m6-admission-discharged-cascade";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ADMISSION_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ADMISSION_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const PATIENT_A = "aaaaaaaa-1111-4111-8111-0000000000a1";
const PATIENT_B = "bbbbbbbb-1111-4111-8111-0000000000b1";

describe.skipIf(!DB_URL)(
  "F-155 — M13's admission-discharged cascade consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let locationA: string;
    let locationB: string;
    let consumer: ReturnType<typeof buildM13AdmissionDischargedCascadeConsumer>;

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

    async function insertDose(opts: {
      id: string;
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      patientId: string;
      admissionId: string;
      dueAt: string;
      status: string;
    }) {
      await admin.query(
        `INSERT INTO scheduled_dose
           (id, organization_id, provider_entity_id, location_id, patient_id, admission_id,
            medication_order_id, due_at, grace_window_minutes, expected_dose_amount, expected_dose_unit,
            expected_route, status, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,30,10,'mg','oral',$9,1)`,
        [
          opts.id,
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          opts.patientId,
          opts.admissionId,
          "cccccccc-0000-4000-8000-000000000099",
          opts.dueAt,
          opts.status,
        ],
      );
    }

    async function insertDeployment(opts: {
      id: string;
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      patientId: string;
      admissionId: string;
      disposalStatus: string;
      returnRequiredAt: string | null;
    }) {
      await admin.query(
        `INSERT INTO comfort_kit_deployment
           (id, organization_id, provider_entity_id, location_id, patient_id, admission_id, deployed_at,
            disposal_status, return_required_at)
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)`,
        [
          opts.id,
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          opts.patientId,
          opts.admissionId,
          opts.disposalStatus,
          opts.returnRequiredAt,
        ],
      );
    }

    async function doseRow(id: string) {
      const { rows } = await admin.query(
        `SELECT status, cancellation_reason, cancellation_source_event_id FROM scheduled_dose WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    }
    async function deploymentRow(id: string) {
      const { rows } = await admin.query(
        `SELECT disposal_status, return_required_at FROM comfort_kit_deployment WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    }
    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2`,
        [organizationId, eventType],
      );
      return rows;
    }

    const resolveAdmission = async (
      organizationId: string,
      admissionId: string,
    ): Promise<DischargeCascadeAdmissionAnchor | null> => {
      if (organizationId === ORG_A && admissionId === ADMISSION_A) {
        return { patientId: PATIENT_A as never };
      }
      if (organizationId === ORG_B && admissionId === ADMISSION_B) {
        return { patientId: PATIENT_B as never };
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
         VALUES ($1,'m13-discharge-cascade-a','M13 Discharge Cascade A','M13 Discharge Cascade A'),
                ($2,'m13-discharge-cascade-b','M13 Discharge Cascade B','M13 Discharge Cascade B')`,
        [ORG_A, ORG_B],
      );
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13DC-A','Discharge Cascade Provider A','1300000001','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13DC-B','Discharge Cascade Provider B','1300000002','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      locationA = (
        await admin.query(
          `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'Discharge Cascade Location A','1 Test St','Testville','OR','97201','America/Los_Angeles')
           RETURNING id`,
          [providerA],
        )
      ).rows[0].id as string;
      locationB = (
        await admin.query(
          `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'Discharge Cascade Location B','1 Test St','Testville','OR','97201','America/Los_Angeles')
           RETURNING id`,
          [providerB],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M13_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      consumer = buildM13AdmissionDischargedCascadeConsumer({
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

    it("cancels a future pending dose, leaves a past-due one untouched, and publishes the cancelled signal", async () => {
      const futureDoseId = "dddddddd-0000-4000-8000-000000000001";
      const pastDoseId = "dddddddd-0000-4000-8000-000000000002";
      await insertDose({
        id: futureDoseId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        dueAt: "2099-01-01T08:00:00Z",
        status: "pending",
      });
      await insertDose({
        id: pastDoseId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        dueAt: "2000-01-01T08:00:00Z",
        status: "pending",
      });
      const eventId = "eeeeeeee-0000-4000-8000-000000000001";

      await consumer.handle({
        id: eventId,
        organizationId: ORG_A,
        payload: {
          admissionId: ADMISSION_A,
          reason: "revocation",
          dischargeDate: "2050-01-01T00:00:00Z",
        },
      });

      const future = await doseRow(futureDoseId);
      expect(future?.status).toBe("cancelled");
      expect(future?.cancellation_reason).toBe("admission_discharged");
      expect(future?.cancellation_source_event_id).toBe(eventId);

      const past = await doseRow(pastDoseId);
      expect(past?.status).toBe("pending"); // never retro-marked

      const emissions = await outboxRows(ORG_A, "m13.scheduled_dose.cancelled");
      expect(emissions).toHaveLength(1);
      expect(emissions[0].payload.scheduledDoseId).toBe(futureDoseId);
    });

    it("is a true no-op on redelivery (the dose is already cancelled)", async () => {
      const doseId = "dddddddd-0000-4000-8000-000000000003";
      await insertDose({
        id: doseId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        dueAt: "2099-02-01T08:00:00Z",
        status: "cancelled",
      });
      const before = await outboxRows(ORG_A, "m13.scheduled_dose.cancelled");

      await consumer.handle({
        id: "eeeeeeee-0000-4000-8000-000000000002",
        organizationId: ORG_A,
        payload: {
          admissionId: ADMISSION_A,
          reason: "death",
          dischargeDate: "2050-01-01T00:00:00Z",
        },
      });

      const after = await outboxRows(ORG_A, "m13.scheduled_dose.cancelled");
      expect(after).toHaveLength(before.length); // no new emission for the already-cancelled dose
    });

    it("flags a deployed comfort kit for return and publishes the signal; an already-flagged kit is a no-op", async () => {
      const deployedId = "ffffffff-0000-4000-8000-000000000001";
      const alreadyFlaggedId = "ffffffff-0000-4000-8000-000000000002";
      await insertDeployment({
        id: deployedId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        disposalStatus: "deployed",
        returnRequiredAt: null,
      });
      await insertDeployment({
        id: alreadyFlaggedId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        disposalStatus: "return_required",
        returnRequiredAt: "2020-01-01T00:00:00Z",
      });

      await consumer.handle({
        id: "eeeeeeee-0000-4000-8000-000000000003",
        organizationId: ORG_A,
        payload: {
          admissionId: ADMISSION_A,
          reason: "transfer",
          dischargeDate: "2051-06-15T00:00:00Z",
        },
      });

      const deployed = await deploymentRow(deployedId);
      expect(deployed?.disposal_status).toBe("return_required");
      expect(deployed?.return_required_at).not.toBeNull();

      const stillFlagged = await deploymentRow(alreadyFlaggedId);
      expect(stillFlagged?.disposal_status).toBe("return_required");
      // Untouched by this delivery — return_required_at stays at its original stamp, not overwritten.
      expect(new Date(stillFlagged?.return_required_at).getUTCFullYear()).toBe(2020);

      const emissions = await outboxRows(ORG_A, "m13.comfort_kit.return_required");
      expect(emissions).toHaveLength(1);
      expect(emissions[0].payload.deploymentId).toBe(deployedId);
      expect(emissions[0].payload.patientId).toBe(PATIENT_A);
    });

    it("does not touch org B's rows when org A discharges (cross-tenant isolation)", async () => {
      const doseId = "dddddddd-0000-4000-8000-0000000000b1";
      await insertDose({
        id: doseId,
        organizationId: ORG_B,
        providerEntityId: providerB,
        locationId: locationB,
        patientId: PATIENT_B,
        admissionId: ADMISSION_B,
        dueAt: "2099-01-01T08:00:00Z",
        status: "pending",
      });

      await consumer.handle({
        id: "eeeeeeee-0000-4000-8000-000000000004",
        organizationId: ORG_A,
        payload: {
          admissionId: ADMISSION_A,
          reason: "revocation",
          dischargeDate: "2052-01-01T00:00:00Z",
        },
      });

      const row = await doseRow(doseId);
      expect(row?.status).toBe("pending"); // org B's dose is untouched by org A's discharge
    });

    it("throws when M6 has no admission context (dead-letters rather than silently no-op)", async () => {
      await expect(
        consumer.handle({
          id: "eeeeeeee-0000-4000-8000-000000000005",
          organizationId: ORG_A,
          payload: {
            admissionId: "aaaaaaaa-0000-4000-8000-0000000000a9",
            reason: "revocation",
            dischargeDate: "2050-01-01T00:00:00Z",
          },
        }),
      ).rejects.toThrow(/no M6 admission context/);
    });
  },
);
