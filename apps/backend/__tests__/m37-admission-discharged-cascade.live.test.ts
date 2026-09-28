/**
 * F-156-followup (#248) — LIVE Postgres proof that M37's §4.5 "If patient has open `ipu_admission` →
 * cascade-discharge" subscription (`buildM37AdmissionDischargedConsumer`,
 * `apps/backend/src/modules/37-ipu/consumers/m6-admission-discharged.ts`) actually discharges an open IPU
 * stay when the underlying M6 admission discharges — the FIRST outbox consumer this module has ever had,
 * for real, under RLS.
 *
 * `transitionAdmission`'s `discharge` case (`@wardenx/inpatient`) has been the SAME pure machine the
 * route-driven `discharge()` op already calls since M37-T04; nothing had ever bound it to
 * `m6.admission.discharged`, so an M6 discharge never closed the corresponding IPU stay.
 *
 * Proves: an `active` GIP admission with an occupied bed discharges — state_history row, bed goes
 * `discharged_dirty`, `m37.ipu_admission.discharged` emitted with the right payload, version bumped; an
 * `active` IRC admission additionally closes its `irc_episode`; a `death`-reason discharge is a deliberate
 * no-op (that path belongs to the separate, still catalog-unbindable `m6-discharge-death.ts` consumer); no
 * matching open `ipu_admission` is a silent no-op; a `pending` (not yet `active`) open admission throws the
 * machine's own `ILLEGAL_ADMISSION_TRANSITION` rather than guessing at a cascade the graph does not define;
 * a redelivery after the first commit is a true no-op; and cross-tenant isolation (org B's admission is
 * untouched by org A's discharge event).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m37:admission-discharged-cascade:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createDbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildM37AdmissionDischargedConsumer,
  M37_ADMISSION_DISCHARGED_CONSUMER,
} from "../src/modules/37-ipu/consumers/m6-admission-discharged";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-156-followup — M37's m6.admission.discharged cascade consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let unitA: string;
    let unitB: string;
    let consumer: ReturnType<typeof buildM37AdmissionDischargedConsumer>;

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

    /** Seeds a bed (ready → occupied) under `unitId` and returns its id. */
    async function seedOccupiedBed(organizationId: string, unitId: string, label: string) {
      const roomId = (
        await admin.query(
          "INSERT INTO ipu_room (organization_id,unit_id,room_number,kind,bed_count) VALUES ($1,$2,$3,'private',1) RETURNING id",
          [organizationId, unitId, label],
        )
      ).rows[0].id as string;
      const bedId = (
        await admin.query(
          "INSERT INTO ipu_bed (organization_id,room_id,unit_id,bed_label,cleaning_status) VALUES ($1,$2,$3,'A','occupied') RETURNING id",
          [organizationId, roomId, unitId],
        )
      ).rows[0].id as string;
      return bedId;
    }

    /** Seeds an `ipu_admission` row directly (bypassing the full write-service state walk) at the given
     *  state, plus (for gip/irc) an active bed assignment on an occupied bed. */
    async function seedAdmission(opts: {
      id: string;
      organizationId: string;
      unitId: string | null;
      patientId: string;
      admissionId: string;
      kind: "gip" | "irc" | "arranged";
      state: string;
      bedId?: string;
    }) {
      const providerEntityId = "cccccccc-0000-4000-8000-000000000001";
      await admin.query(
        `INSERT INTO ipu_admission
           (id,organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,
            unit_id,remote_facility_id,kind,state,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$3)`,
        [
          opts.id,
          opts.organizationId,
          providerEntityId,
          opts.patientId,
          opts.admissionId,
          `dddddddd-0000-4000-8000-${opts.id.slice(-12)}`, // a unique fake LOC-period id per admission
          opts.kind === "arranged" ? null : opts.unitId,
          opts.kind === "arranged" ? "eeeeeeee-0000-4000-8000-000000000001" : null,
          opts.kind,
          opts.state,
        ],
      );
      if (opts.bedId) {
        await admin.query(
          `INSERT INTO ipu_bed_assignment (organization_id,ipu_admission_id,bed_id,assigned_by)
           VALUES ($1,$2,$3,$3)`,
          [opts.organizationId, opts.id, opts.bedId],
        );
      }
      if (opts.kind === "irc") {
        await admin.query(
          `INSERT INTO irc_episode (organization_id,ipu_admission_id,provider_entity_id,patient_id,expected_end_at)
           VALUES ($1,$2,$3,$4,now() + interval '5 days')`,
          [opts.organizationId, opts.id, providerEntityId, opts.patientId],
        );
      }
    }

    async function admissionRow(id: string) {
      const { rows } = await admin.query(
        "SELECT state, version FROM ipu_admission WHERE id = $1",
        [id],
      );
      return rows[0] ?? null;
    }
    async function bedRow(id: string) {
      const { rows } = await admin.query(
        "SELECT cleaning_status FROM ipu_bed WHERE id = $1",
        [id],
      );
      return rows[0] ?? null;
    }
    async function ircRow(ipuAdmissionId: string) {
      const { rows } = await admin.query(
        "SELECT state, closed_at FROM irc_episode WHERE ipu_admission_id = $1",
        [ipuAdmissionId],
      );
      return rows[0] ?? null;
    }
    async function historyRows(ipuAdmissionId: string) {
      const { rows } = await admin.query(
        "SELECT from_state, to_state, by_membership_id FROM ipu_admission_state_history WHERE ipu_admission_id = $1",
        [ipuAdmissionId],
      );
      return rows;
    }
    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2",
        [organizationId, eventType],
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
         VALUES ($1,'m37-discharge-cascade-a','M37 Discharge Cascade A','M37 Discharge Cascade A'),
                ($2,'m37-discharge-cascade-b','M37 Discharge Cascade B','M37 Discharge Cascade B')`,
        [ORG_A, ORG_B],
      );
      unitA = (
        await admin.query(
          `INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count)
           VALUES ($1,$2,'IPU A',4) RETURNING id`,
          [ORG_A, "cccccccc-0000-4000-8000-000000000001"],
        )
      ).rows[0].id as string;
      unitB = (
        await admin.query(
          `INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count)
           VALUES ($1,$2,'IPU B',4) RETURNING id`,
          [ORG_B, "cccccccc-0000-4000-8000-000000000002"],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, (typeof M37_OUTBOX_EVENTS)[number]["payloadSchema"]>(
        M37_OUTBOX_EVENTS.map((e) => [e.eventName, e.payloadSchema]),
      );
      consumer = buildM37AdmissionDischargedConsumer({
        db: handle.db,
        outbox: {
          async publish(tx, input) {
            const eventSchema = catalog.get(input.eventName);
            if (!eventSchema) throw new Error(`m37 test publisher: undeclared event ${input.eventName}`);
            if (!Value.Check(eventSchema, input.payload)) {
              const details = [...Value.Errors(eventSchema, input.payload)]
                .map((e) => `${e.path || "/"}: ${e.message}`)
                .join("; ");
              throw new Error(`payload_schema_violation ${input.eventName} — ${details}`);
            }
            await (tx as typeof handle.db).execute(sql`
              INSERT INTO outbox_event
                (organization_id, event_type, aggregate_kind, aggregate_id, payload)
              VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                      ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
            `);
          },
        },
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("has the expected event/consumer name pair", () => {
      expect(M37_ADMISSION_DISCHARGED_CONSUMER).toEqual({
        eventName: "m6.admission.discharged",
        consumerName: "m37.admission-discharged-cascade",
      });
    });

    it("cascade-discharges an active GIP admission: state, bed cleaning, and outbox all move together", async () => {
      const ipuId = "aaaaaaaa-0000-4000-8000-0000000000a1";
      const m6AdmissionId = "aaaaaaaa-0000-4000-8000-0000000000a2";
      const patientId = "aaaaaaaa-0000-4000-8000-0000000000a3";
      const bedId = await seedOccupiedBed(ORG_A, unitA, "101");
      await seedAdmission({
        id: ipuId,
        organizationId: ORG_A,
        unitId: unitA,
        patientId,
        admissionId: m6AdmissionId,
        kind: "gip",
        state: "active",
        bedId,
      });

      await consumer.handle({
        id: "eeeeeeee-0000-4000-8000-000000000001",
        organizationId: ORG_A,
        payload: { admissionId: m6AdmissionId, reason: "revocation", dischargeDate: "2050-01-01T00:00:00Z" },
      });

      const admission = await admissionRow(ipuId);
      expect(admission?.state).toBe("discharged");
      expect(Number(admission?.version)).toBe(1);

      const bed = await bedRow(bedId);
      expect(bed?.cleaning_status).toBe("discharged_dirty");

      const history = await historyRows(ipuId);
      expect(history).toHaveLength(1);
      expect(history[0].from_state).toBe("active");
      expect(history[0].to_state).toBe("discharged");
      expect(history[0].by_membership_id).toBe("00000000-0000-0000-0000-000000000037");

      const emissions = await outboxRows(ORG_A, "m37.ipu_admission.discharged");
      expect(emissions).toHaveLength(1);
      expect(emissions[0].payload).toMatchObject({ ipuAdmissionId: ipuId, reason: "revocation" });
    });

    it("closes the irc_episode for an active IRC admission", async () => {
      const ipuId = "aaaaaaaa-0000-4000-8000-0000000000b1";
      const m6AdmissionId = "aaaaaaaa-0000-4000-8000-0000000000b2";
      const patientId = "aaaaaaaa-0000-4000-8000-0000000000b3";
      const bedId = await seedOccupiedBed(ORG_A, unitA, "102");
      await seedAdmission({
        id: ipuId,
        organizationId: ORG_A,
        unitId: unitA,
        patientId,
        admissionId: m6AdmissionId,
        kind: "irc",
        state: "active",
        bedId,
      });

      await consumer.handle({
        id: "eeeeeeee-0000-4000-8000-000000000002",
        organizationId: ORG_A,
        payload: { admissionId: m6AdmissionId, reason: "transfer", dischargeDate: "2050-01-01T00:00:00Z" },
      });

      expect((await admissionRow(ipuId))?.state).toBe("discharged");
      const irc = await ircRow(ipuId);
      expect(irc?.state).toBe("closed");
      expect(irc?.closed_at).not.toBeNull();
    });

    it("is a deliberate no-op for a death-reason discharge (owned by the separate death consumer)", async () => {
      const ipuId = "aaaaaaaa-0000-4000-8000-0000000000c1";
      const m6AdmissionId = "aaaaaaaa-0000-4000-8000-0000000000c2";
      const patientId = "aaaaaaaa-0000-4000-8000-0000000000c3";
      const bedId = await seedOccupiedBed(ORG_A, unitA, "103");
      await seedAdmission({
        id: ipuId,
        organizationId: ORG_A,
        unitId: unitA,
        patientId,
        admissionId: m6AdmissionId,
        kind: "gip",
        state: "active",
        bedId,
      });

      await consumer.handle({
        id: "eeeeeeee-0000-4000-8000-000000000003",
        organizationId: ORG_A,
        payload: { admissionId: m6AdmissionId, reason: "death", dischargeDate: "2050-01-01T00:00:00Z" },
      });

      expect((await admissionRow(ipuId))?.state).toBe("active"); // untouched
      const bed = await bedRow(bedId);
      expect(bed?.cleaning_status).toBe("occupied"); // untouched
      expect(await historyRows(ipuId)).toHaveLength(0);
    });

    it("is a silent no-op when no open ipu_admission matches the M6 admission id", async () => {
      const before = await outboxRows(ORG_A, "m37.ipu_admission.discharged");
      await expect(
        consumer.handle({
          id: "eeeeeeee-0000-4000-8000-000000000004",
          organizationId: ORG_A,
          payload: {
            admissionId: "aaaaaaaa-0000-4000-8000-0000000000d9",
            reason: "revocation",
            dischargeDate: "2050-01-01T00:00:00Z",
          },
        }),
      ).resolves.toBeUndefined();
      const after = await outboxRows(ORG_A, "m37.ipu_admission.discharged");
      expect(after).toHaveLength(before.length);
    });

    it("throws the machine's own ILLEGAL_ADMISSION_TRANSITION for a still-pending open admission (dead-letters rather than guessing)", async () => {
      const ipuId = "aaaaaaaa-0000-4000-8000-0000000000e1";
      const m6AdmissionId = "aaaaaaaa-0000-4000-8000-0000000000e2";
      const patientId = "aaaaaaaa-0000-4000-8000-0000000000e3";
      await seedAdmission({
        id: ipuId,
        organizationId: ORG_A,
        unitId: unitA,
        patientId,
        admissionId: m6AdmissionId,
        kind: "gip",
        state: "pending",
      });

      await expect(
        consumer.handle({
          id: "eeeeeeee-0000-4000-8000-000000000005",
          organizationId: ORG_A,
          payload: { admissionId: m6AdmissionId, reason: "revocation", dischargeDate: "2050-01-01T00:00:00Z" },
        }),
      ).rejects.toMatchObject({ code: "ILLEGAL_ADMISSION_TRANSITION" });

      expect((await admissionRow(ipuId))?.state).toBe("pending"); // untouched — refused, not half-applied
    });

    it("is a true no-op on redelivery after the first delivery already committed", async () => {
      const ipuId = "aaaaaaaa-0000-4000-8000-0000000000f1";
      const m6AdmissionId = "aaaaaaaa-0000-4000-8000-0000000000f2";
      const patientId = "aaaaaaaa-0000-4000-8000-0000000000f3";
      const bedId = await seedOccupiedBed(ORG_A, unitA, "104");
      await seedAdmission({
        id: ipuId,
        organizationId: ORG_A,
        unitId: unitA,
        patientId,
        admissionId: m6AdmissionId,
        kind: "gip",
        state: "active",
        bedId,
      });

      const event = {
        id: "eeeeeeee-0000-4000-8000-000000000006",
        organizationId: ORG_A,
        payload: { admissionId: m6AdmissionId, reason: "revocation", dischargeDate: "2050-01-01T00:00:00Z" },
      };
      await consumer.handle(event);
      const afterFirst = await outboxRows(ORG_A, "m37.ipu_admission.discharged");

      await consumer.handle(event); // redelivery
      const afterSecond = await outboxRows(ORG_A, "m37.ipu_admission.discharged");

      expect(afterSecond).toHaveLength(afterFirst.length); // no duplicate emission
      expect((await admissionRow(ipuId))?.state).toBe("discharged");
      expect(Number((await admissionRow(ipuId))?.version)).toBe(1); // not double-bumped
    });

    it("does not touch org B's admission when org A discharges (cross-tenant isolation)", async () => {
      const ipuIdB = "bbbbbbbb-0000-4000-8000-000000000001";
      const sharedAdmissionId = "bbbbbbbb-0000-4000-8000-000000000002";
      const patientB = "bbbbbbbb-0000-4000-8000-000000000003";
      const bedIdB = await seedOccupiedBed(ORG_B, unitB, "201");
      await seedAdmission({
        id: ipuIdB,
        organizationId: ORG_B,
        unitId: unitB,
        patientId: patientB,
        admissionId: sharedAdmissionId,
        kind: "gip",
        state: "active",
        bedId: bedIdB,
      });

      // org A delivers an event naming the SAME admission id value — org B's row must not be reachable
      // through org A's tenant-scoped consumer invocation.
      await consumer.handle({
        id: "eeeeeeee-0000-4000-8000-000000000007",
        organizationId: ORG_A,
        payload: { admissionId: sharedAdmissionId, reason: "revocation", dischargeDate: "2050-01-01T00:00:00Z" },
      });

      expect((await admissionRow(ipuIdB))?.state).toBe("active");
    });
  },
);
