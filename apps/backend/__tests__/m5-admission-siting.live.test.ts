/**
 * F-152 (#248) — LIVE Postgres proof that M5's `m6.admission.activated` binding
 * (`buildM5AdmissionSitingConsumer`) denormalizes the activating admission's provider entity/location
 * onto the real `patient` row, through the REAL `AdmissionStatusReader` seam (registered over a real
 * Drizzle-backed store, `createDrizzleAdmissionReaderStore`), not a stub.
 *
 * `patient.provider_entity_id` / `patient.location_id` have carried the "nullable — until admission"
 * comment since the schema landed (ARCH-011 / M05-F04) and nothing in this repository has ever written
 * either column. This proves the real binding end to end: an admission's siting resolves through the
 * cross-module seam (M5 has no `dependsOn` edge to M6 — this is the `getSeam(...)` boundary, not an
 * import), the patient row is updated, a redelivery is a no-op re-apply, and a second admission
 * activating for the same patient at a DIFFERENT provider entity correctly overwrites the earlier value.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m5:admission-siting:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
// Imported by exact file path, not the module barrel: the coordinator wires the barrel export
// (`apps/backend/src/modules/05-patient/index.ts`) centrally after independently verifying this file.
import { buildM5AdmissionSitingConsumer } from "../src/modules/05-patient/outbox-consumers/m6-admission-activated";
import {
  type AdmissionDischargedDeps,
  applyAdmissionDischarged,
} from "../src/modules/05-patient/outbox-consumers/m6-admission-discharged";
import { registerAdmissionSeams } from "../src/modules/06-admission/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-152 — M5's m6.admission.activated siting denormalization — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA1: string;
    let providerA2: string;
    let providerB: string;
    let locationA: string;
    let consumer: ReturnType<typeof buildM5AdmissionSitingConsumer>;
    let dischargedDeps: AdmissionDischargedDeps;

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

    async function seedPatient(
      organizationId: string,
      status:
        | "prospective"
        | "active"
        | "on_hold"
        | "discharged"
        | "deceased"
        | "merged" = "prospective",
    ): Promise<string> {
      const row = await admin.query(
        `INSERT INTO patient
           (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status, deceased_date)
         VALUES ($1, $2, 'Test', 'Patient', '1950-01-01', 'female', $3,
                 CASE WHEN $3 = 'deceased' THEN '2026-01-01'::date END)
         RETURNING id`,
        [
          organizationId,
          `MRN-${Math.random().toString(36).slice(2, 10)}`,
          status === "merged" ? "prospective" : status,
        ],
      );
      const patientId = row.rows[0].id as string;
      if (status === "merged") {
        const target = await seedPatient(organizationId);
        await admin.query(
          `UPDATE patient SET status = 'merged', merged_into_id = $2 WHERE id = $1`,
          [patientId, target],
        );
      }
      return patientId;
    }

    async function seedAdmission(opts: {
      organizationId: string;
      patientId: string;
      providerEntityId: string;
      locationId: string | null;
    }): Promise<string> {
      const row = await admin.query(
        `INSERT INTO admission
           (organization_id, patient_id, provider_entity_id, location_id, status, activated_at)
         VALUES ($1, $2, $3, $4, 'active', now())
         RETURNING id`,
        [opts.organizationId, opts.patientId, opts.providerEntityId, opts.locationId],
      );
      return row.rows[0].id as string;
    }

    async function patientSiting(patientId: string) {
      const { rows } = await admin.query(
        `SELECT provider_entity_id, location_id, status FROM patient WHERE id = $1`,
        [patientId],
      );
      return rows[0];
    }

    async function statusEvents(patientId: string) {
      return (
        await admin.query(
          `SELECT event_type, payload
             FROM outbox_event
            WHERE event_type = 'm5.patient.status_changed'
              AND payload->>'patientId' = $1`,
          [patientId],
        )
      ).rows;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m5-admission-siting-a','M5 Siting A','M5 Siting A'),
                ($2,'m5-admission-siting-b','M5 Siting B','M5 Siting B')`,
        [ORG_A, ORG_B],
      );
      providerA1 = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M5SIT-A1','Siting Provider A1','1200000001','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerA2 = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M5SIT-A2','Siting Provider A2','1200000002','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M5SIT-B','Siting Provider B','1200000003','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      locationA = (
        await admin.query(
          `INSERT INTO location
             (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1, 'Siting Location A', '1 Test St', 'Testville', 'OR', '97201', 'America/Los_Angeles')
           RETURNING id`,
          [providerA1],
        )
      ).rows[0].id as string;

      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({
        connectionString: appRoleUrl(DB_URL as string),
      });

      registerAdmissionSeams({
        store: (
          await import("../src/modules/06-admission/index")
        ).createDrizzleAdmissionReaderStore(handle.db),
      });

      // The REAL catalog-validating publisher — a payload drift on `m5.patient.status_changed` throws.
      const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS]));
      consumer = buildM5AdmissionSitingConsumer({
        db: handle.db,
        outbox: {
          publish: (tx, input) => txPublisher.publish(tx, { ...input, callerModule: "m5" }),
        },
      });
      dischargedDeps = {
        db: handle.db,
        outbox: {
          publish: (tx, input) => txPublisher.publish(tx, { ...input, callerModule: "m5" }),
        },
      };
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("denormalizes the activating admission's provider entity + location onto the patient row", async () => {
      const patientId = await seedPatient(ORG_A);
      const admissionId = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA1,
        locationId: locationA,
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { admissionId, patientId },
      });

      const siting = await patientSiting(patientId);
      expect(siting.provider_entity_id).toBe(providerA1);
      expect(siting.location_id).toBe(locationA);
      expect(siting.status).toBe("active");
      expect(await statusEvents(patientId)).toMatchObject([
        {
          event_type: "m5.patient.status_changed",
          payload: {
            patientId,
            organizationId: ORG_A,
            fromStatus: "prospective",
            toStatus: "active",
          },
        },
      ]);
    });

    it("is idempotent on redelivery", async () => {
      const patientId = await seedPatient(ORG_A, "active");
      const admissionId = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA1,
        locationId: null,
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { admissionId, patientId },
      });
      await consumer.handle({
        organizationId: ORG_A,
        payload: { admissionId, patientId },
      });

      const siting = await patientSiting(patientId);
      expect(siting.provider_entity_id).toBe(providerA1);
      expect(siting.location_id).toBeNull();
      expect(siting.status).toBe("active");
      expect(await statusEvents(patientId)).toEqual([]);
    });

    it("a later admission at a different provider entity overwrites the earlier siting", async () => {
      const patientId = await seedPatient(ORG_A);
      const firstAdmission = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA1,
        locationId: locationA,
      });
      await consumer.handle({
        organizationId: ORG_A,
        payload: { admissionId: firstAdmission, patientId },
      });
      expect((await patientSiting(patientId)).provider_entity_id).toBe(providerA1);

      // A real re-admission: the first admission must discharge before a second can open
      // (`admission_patient_open_idx` — at most one OPEN (status NOT IN discharged/bereavement/closed)
      // admission per patient).
      await admin.query(
        `UPDATE admission SET status = 'discharged', discharged_at = now() WHERE id = $1`,
        [firstAdmission],
      );

      const secondAdmission = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA2,
        locationId: null,
      });
      await consumer.handle({
        organizationId: ORG_A,
        payload: { admissionId: secondAdmission, patientId },
      });

      const siting = await patientSiting(patientId);
      expect(siting.provider_entity_id).toBe(providerA2);
      expect(siting.location_id).toBeNull();
    });

    it("reactivates a discharged patient for a re-admission and emits the status transition", async () => {
      const patientId = await seedPatient(ORG_A, "discharged");
      const admissionId = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA1,
        locationId: locationA,
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { admissionId, patientId },
      });

      expect((await patientSiting(patientId)).status).toBe("active");
      expect(await statusEvents(patientId)).toMatchObject([
        {
          payload: {
            patientId,
            organizationId: ORG_A,
            fromStatus: "discharged",
            toStatus: "active",
          },
        },
      ]);
    });

    it.each(["deceased", "merged"] as const)(
      "refuses to reactivate a %s patient",
      async (status) => {
        const patientId = await seedPatient(ORG_A, status);
        const admissionId = await seedAdmission({
          organizationId: ORG_A,
          patientId,
          providerEntityId: providerA1,
          locationId: null,
        });

        await expect(
          consumer.handle({
            organizationId: ORG_A,
            payload: { admissionId, patientId },
          }),
        ).rejects.toThrow(`cannot activate from status '${status}'`);
        expect((await patientSiting(patientId)).status).toBe(status);
        expect(await statusEvents(patientId)).toEqual([]);
      },
    );

    it("rolls back status and siting when the transactional outbox publish fails", async () => {
      const patientId = await seedPatient(ORG_A);
      const admissionId = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA1,
        locationId: locationA,
      });
      const failingConsumer = buildM5AdmissionSitingConsumer({
        db: handle.db,
        outbox: {
          async publish() {
            throw new Error("synthetic outbox failure");
          },
        },
      });

      await expect(
        failingConsumer.handle({
          organizationId: ORG_A,
          payload: { admissionId, patientId },
        }),
      ).rejects.toThrow("synthetic outbox failure");

      expect(await patientSiting(patientId)).toMatchObject({
        status: "prospective",
        provider_entity_id: null,
        location_id: null,
      });
      expect(await statusEvents(patientId)).toEqual([]);
    });

    it("is a no-op for an admission id invisible under this org's cross-tenant read", async () => {
      const patientBId = await seedPatient(ORG_B);
      const admissionB = await seedAdmission({
        organizationId: ORG_B,
        patientId: patientBId,
        providerEntityId: providerB,
        locationId: null,
      });

      // Deliver ORG A's context for an admission id that only exists under ORG B.
      await expect(
        consumer.handle({
          organizationId: ORG_A,
          payload: { admissionId: admissionB, patientId: patientBId },
        }),
      ).resolves.toBeUndefined();

      // Org B's own patient row is untouched by the org-A-scoped delivery above.
      const siting = await patientSiting(patientBId);
      expect(siting.provider_entity_id).toBeNull();
    });

    async function patientStatus(patientId: string): Promise<string> {
      const { rows } = await admin.query(`SELECT status FROM patient WHERE id = $1`, [patientId]);
      return rows[0].status as string;
    }

    async function statusChangedPayloads(patientId: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event
          WHERE event_type = 'm5.patient.status_changed' AND aggregate_id = $1`,
        [patientId],
      );
      return rows.map((r) => r.payload);
    }

    it("promotes a prospective patient to active (§2.4.1 'admission approved') and emits status_changed once", async () => {
      const patientId = await seedPatient(ORG_A, "prospective");
      const admissionId = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA1,
        locationId: null,
      });

      await consumer.handle({ organizationId: ORG_A, payload: { admissionId, patientId } });
      await consumer.handle({ organizationId: ORG_A, payload: { admissionId, patientId } });

      expect(await patientStatus(patientId)).toBe("active");
      expect(await statusChangedPayloads(patientId)).toEqual([
        { patientId, organizationId: ORG_A, fromStatus: "prospective", toStatus: "active" },
      ]);
    });

    it("promotes a discharged patient on re-admission", async () => {
      const patientId = await seedPatient(ORG_A, "discharged");
      const admissionId = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA1,
        locationId: null,
      });

      await consumer.handle({ organizationId: ORG_A, payload: { admissionId, patientId } });

      expect(await patientStatus(patientId)).toBe("active");
      expect(await statusChangedPayloads(patientId)).toEqual([
        { patientId, organizationId: ORG_A, fromStatus: "discharged", toStatus: "active" },
      ]);
    });

    it("leaves an on_hold or deceased patient's status alone", async () => {
      for (const status of ["on_hold", "deceased"] as const) {
        const patientId =
          status === "deceased"
            ? (
                await admin.query(
                  `INSERT INTO patient
                     (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth,
                      status, deceased_date)
                   VALUES ($1, $2, 'Test', 'Patient', '1950-01-01', 'female', 'deceased', '2026-01-01')
                   RETURNING id`,
                  [ORG_A, `MRN-${Math.random().toString(36).slice(2, 10)}`],
                )
              ).rows[0].id
            : await seedPatient(ORG_A, status);
        const admissionId = await seedAdmission({
          organizationId: ORG_A,
          patientId,
          providerEntityId: providerA1,
          locationId: null,
        });

        await consumer.handle({ organizationId: ORG_A, payload: { admissionId, patientId } });

        expect(await patientStatus(patientId)).toBe(status);
        expect(await statusChangedPayloads(patientId)).toEqual([]);
      }
    });

    // ── §2.4.1 `active/on_hold → discharged` — the live-discharge consumer (m6.admission.discharged) ──
    /** Marks the admission discharged the way M6's `dischargeAdmissionTx` leaves it. */
    async function endAdmission(admissionId: string) {
      await admin.query(
        `UPDATE admission SET status = 'discharged', discharged_at = now() WHERE id = $1`,
        [admissionId],
      );
    }
    async function dischargedAdmissionFor(organizationId: string, patientId: string) {
      const providerEntityId = organizationId === ORG_A ? providerA1 : providerB;
      const admissionId = await seedAdmission({
        organizationId,
        patientId,
        providerEntityId,
        locationId: null,
      });
      await endAdmission(admissionId);
      return admissionId;
    }
    const deliver = (organizationId: string, admissionId: string, reason: string) =>
      applyAdmissionDischarged(dischargedDeps, {
        organizationId,
        payload: { admissionId, reason, dischargeDate: "2026-06-01" },
      });

    it("a live discharge moves an active patient to discharged and emits status_changed (NULL audit actor)", async () => {
      const patientId = await seedPatient(ORG_A, "active");
      const admissionId = await dischargedAdmissionFor(ORG_A, patientId);

      expect(await deliver(ORG_A, admissionId, "moved_out_of_service_area")).toBe("discharged");

      expect(await patientStatus(patientId)).toBe("discharged");
      expect(await statusChangedPayloads(patientId)).toEqual([
        { patientId, organizationId: ORG_A, fromStatus: "active", toStatus: "discharged" },
      ]);
      const audit = await admin.query(
        "SELECT actor_user_id FROM audit_event WHERE resource_id = $1 AND event_type = 'patient.update'",
        [patientId],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows.every((r) => r.actor_user_id === null)).toBe(true);
    });

    it("revocation, transfer out, no longer terminal, for cause and other all discharge; on_hold too", async () => {
      const cases: [string, "active" | "on_hold"][] = [
        ["revocation", "active"],
        ["transfer", "active"],
        ["no_longer_terminal", "on_hold"],
        ["for_cause", "active"],
        ["other", "on_hold"],
      ];
      for (const [reason, from] of cases) {
        const patientId = await seedPatient(ORG_A, from);
        const admissionId = await dischargedAdmissionFor(ORG_A, patientId);
        expect(await deliver(ORG_A, admissionId, reason)).toBe("discharged");
        expect(await patientStatus(patientId)).toBe("discharged");
        expect(await statusChangedPayloads(patientId)).toEqual([
          { patientId, organizationId: ORG_A, fromStatus: from, toStatus: "discharged" },
        ]);
      }
    });

    it("a death discharge is NOT handled here — the death cascade owns `deceased`", async () => {
      const patientId = await seedPatient(ORG_A, "active");
      const admissionId = await dischargedAdmissionFor(ORG_A, patientId);

      expect(await deliver(ORG_A, admissionId, "death")).toBe("skipped_death");

      expect(await patientStatus(patientId)).toBe("active");
      expect(await statusChangedPayloads(patientId)).toEqual([]);
    });

    it("is idempotent on redelivery — one status change, one event", async () => {
      const patientId = await seedPatient(ORG_A, "active");
      const admissionId = await dischargedAdmissionFor(ORG_A, patientId);

      expect(await deliver(ORG_A, admissionId, "revocation")).toBe("discharged");
      expect(await deliver(ORG_A, admissionId, "revocation")).toBe("already_discharged");

      expect(await patientStatus(patientId)).toBe("discharged");
      expect(await statusChangedPayloads(patientId)).toHaveLength(1);
    });

    it("leaves deceased and merged charts alone without an error", async () => {
      const deceasedId = (
        await admin.query(
          `INSERT INTO patient
             (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth,
              status, deceased_date)
           VALUES ($1, $2, 'Test', 'Patient', '1950-01-01', 'female', 'deceased', '2026-01-01')
           RETURNING id`,
          [ORG_A, `MRN-${Math.random().toString(36).slice(2, 10)}`],
        )
      ).rows[0].id as string;
      const deceasedAdmission = await dischargedAdmissionFor(ORG_A, deceasedId);
      expect(await deliver(ORG_A, deceasedAdmission, "other")).toBe("skipped_status");
      expect(await patientStatus(deceasedId)).toBe("deceased");

      const survivorId = await seedPatient(ORG_A, "active");
      const mergedId = await seedPatient(ORG_A, "active");
      await admin.query("UPDATE patient SET status = 'merged', merged_into_id = $2 WHERE id = $1", [
        mergedId,
        survivorId,
      ]);
      const mergedAdmission = await dischargedAdmissionFor(ORG_A, mergedId);
      expect(await deliver(ORG_A, mergedAdmission, "other")).toBe("skipped_status");
      expect(await patientStatus(mergedId)).toBe("merged");
      expect(await statusChangedPayloads(deceasedId)).toEqual([]);
      expect(await statusChangedPayloads(mergedId)).toEqual([]);
    });

    it("a late discharge never discharges a patient a re-admission already took back under care", async () => {
      const patientId = await seedPatient(ORG_A, "active");
      const oldAdmission = await dischargedAdmissionFor(ORG_A, patientId);
      // The re-admission is already active (and its activation already applied) when the OLD admission's
      // discharge is finally delivered — a retry or a redelivery.
      await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA2,
        locationId: null,
      });

      expect(await deliver(ORG_A, oldAdmission, "transfer")).toBe(
        "skipped_other_admission_under_care",
      );
      expect(await patientStatus(patientId)).toBe("active");
      expect(await statusChangedPayloads(patientId)).toEqual([]);
    });

    it("discharged then re-admitted: the activation consumer brings the patient back to active", async () => {
      const patientId = await seedPatient(ORG_A, "active");
      const firstAdmission = await dischargedAdmissionFor(ORG_A, patientId);
      expect(await deliver(ORG_A, firstAdmission, "revocation")).toBe("discharged");
      expect(await patientStatus(patientId)).toBe("discharged");

      const readmission = await seedAdmission({
        organizationId: ORG_A,
        patientId,
        providerEntityId: providerA2,
        locationId: null,
      });
      await consumer.handle({
        organizationId: ORG_A,
        payload: { admissionId: readmission, patientId },
      });

      expect(await patientStatus(patientId)).toBe("active");
      expect(await statusChangedPayloads(patientId)).toEqual([
        { patientId, organizationId: ORG_A, fromStatus: "active", toStatus: "discharged" },
        { patientId, organizationId: ORG_A, fromStatus: "discharged", toStatus: "active" },
      ]);
    });

    it("RLS — an org-A delivery for an org-B admission touches nothing in either tenant", async () => {
      const patientBId = await seedPatient(ORG_B, "active");
      const admissionB = await dischargedAdmissionFor(ORG_B, patientBId);

      expect(await deliver(ORG_A, admissionB, "revocation")).toBe("skipped_unknown_admission");
      expect(await patientStatus(patientBId)).toBe("active");

      // The owning tenant's own delivery still applies.
      expect(await deliver(ORG_B, admissionB, "revocation")).toBe("discharged");
      expect(await patientStatus(patientBId)).toBe("discharged");
    });
  },
);
