/**
 * F-172 (#248) — LIVE Postgres proof that M37's `recordDeath` transition — complete, pure, unit-tested
 * since M37-T04, called nowhere outside its own unit test until this pass — is now driven for real by
 * `buildM37DeathRecordedConsumer` (`apps/backend/src/modules/37-ipu/consumers/m6-discharge-death.ts`),
 * bound live on the WIDENED `m6.discharge.death` (`deathCertifierId` added at the source, F-172).
 *
 * Proves: an `active` GIP admission on death moves to `deceased`, stamps `death_event_id`, writes the
 * state-history row (system actor), auto-opens `ipu_body_release` with every fact sourced honestly (no
 * cross-module seam — `providerEntityId`/`locationId`/`patientId` off `ipu_admission` itself,
 * `pronouncingPhysicianId` off the widened `deathCertifierId`, `pronouncedAt` reconstructed from
 * `dischargeDate` the F-105 way), leaves the bed OCCUPIED (deferred, §2.11), and emits BOTH
 * `m37.ipu_admission.death_recorded` and `m37.body_release.pending`; a still-`pending` open admission
 * throws the machine's own `ILLEGAL_ADMISSION_TRANSITION` rather than guessing at a cascade the graph does
 * not define; no matching open `ipu_admission` is a silent no-op; a redelivery after the first commit is a
 * true no-op (no duplicate `ipu_body_release` row — the real `body_release_one_per_admission` unique index
 * enforces it); and cross-tenant isolation (org B's admission is untouched by org A's death event).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m37:death-recorded:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createDbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/events-by-m6";
import {
  M37_DEATH_RECORDED_CONSUMER,
  buildM37DeathRecordedConsumer,
} from "../src/modules/37-ipu/consumers/m6-discharge-death";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PHYSICIAN = "cccccccc-0000-4000-8000-0000000000f1"; // M40 ExternalPhysician, logical uuid

describe.skipIf(!DB_URL)(
  "F-172 — M37's m6.discharge.death → recordDeath consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let unitA: string;
    let unitB: string;
    let consumer: ReturnType<typeof buildM37DeathRecordedConsumer>;

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
      const providerEntityId = "dddddddd-0000-4000-8000-000000000001";
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
          `eeeeeeee-0000-4000-8000-${opts.id.slice(-12)}`, // a unique fake LOC-period id per admission
          opts.kind === "arranged" ? null : opts.unitId,
          opts.kind === "arranged" ? "ffffffff-0000-4000-8000-000000000001" : null,
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
    }

    async function admissionRow(id: string) {
      const { rows } = await admin.query(
        "SELECT state, version, death_event_id, provider_entity_id, patient_id FROM ipu_admission WHERE id = $1",
        [id],
      );
      return rows[0] ?? null;
    }
    async function bedRow(id: string) {
      const { rows } = await admin.query("SELECT cleaning_status FROM ipu_bed WHERE id = $1", [id]);
      return rows[0] ?? null;
    }
    async function historyRows(ipuAdmissionId: string) {
      const { rows } = await admin.query(
        "SELECT from_state, to_state, by_membership_id, reason FROM ipu_admission_state_history WHERE ipu_admission_id = $1",
        [ipuAdmissionId],
      );
      return rows;
    }
    async function bodyReleaseRows(ipuAdmissionId: string) {
      const { rows } = await admin.query(
        `SELECT id, organization_id, provider_entity_id, location_id, patient_id, death_event_id,
                state, pronouncing_physician_id, pronounced_at
         FROM ipu_body_release WHERE ipu_admission_id = $1`,
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
         VALUES ($1,'m37-death-recorded-a','M37 Death Recorded A','M37 Death Recorded A'),
                ($2,'m37-death-recorded-b','M37 Death Recorded B','M37 Death Recorded B')`,
        [ORG_A, ORG_B],
      );
      unitA = (
        await admin.query(
          `INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count)
           VALUES ($1,$2,'IPU A',4) RETURNING id`,
          [ORG_A, "dddddddd-0000-4000-8000-000000000001"],
        )
      ).rows[0].id as string;
      unitB = (
        await admin.query(
          `INSERT INTO inpatient_unit (organization_id,facility_id,display_name,bed_count)
           VALUES ($1,$2,'IPU B',4) RETURNING id`,
          [ORG_B, "dddddddd-0000-4000-8000-000000000002"],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      // The consumer only ever PUBLISHES m37.* events — this catalog-validating stub only needs the m37
      // side. `M6_OUTBOX_EVENTS` is imported separately, below, to validate the WIDENED
      // `m6.discharge.death` payload schema directly (the fact this consumer's producer side depends on).
      const catalog = new Map<string, (typeof M37_OUTBOX_EVENTS)[number]["payloadSchema"]>(
        M37_OUTBOX_EVENTS.map((e) => [e.eventName, e.payloadSchema]),
      );

      consumer = buildM37DeathRecordedConsumer({
        db: handle.db,
        outbox: {
          async publish(tx, input) {
            const eventSchema = catalog.get(input.eventName);
            if (!eventSchema)
              throw new Error(`m37 test publisher: undeclared event ${input.eventName}`);
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
      expect(M37_DEATH_RECORDED_CONSUMER).toEqual({
        eventName: "m6.discharge.death",
        consumerName: "m37.death-recorded",
      });
    });

    it("has a real payload schema for m6.discharge.death requiring deathCertifierId", () => {
      const schema = M6_OUTBOX_EVENTS.find(
        (e) => e.eventName === "m6.discharge.death",
      )?.payloadSchema;
      expect(schema).toBeDefined();
      expect(
        Value.Check(schema as never, {
          dischargeEventId: "x",
          admissionId: "y",
          dischargeDate: "2050-01-01",
        }),
      ).toBe(false); // deathCertifierId missing
      expect(
        Value.Check(schema as never, {
          dischargeEventId: "x",
          admissionId: "y",
          dischargeDate: "2050-01-01",
          deathCertifierId: PHYSICIAN,
        }),
      ).toBe(true);
    });

    it("records a death on an active GIP admission: state, death_event_id, history, body release, deferred bed, both outbox events", async () => {
      const ipuId = "aaaaaaaa-0000-4000-8000-0000000000a1";
      const m6AdmissionId = "aaaaaaaa-0000-4000-8000-0000000000a2";
      const patientId = "aaaaaaaa-0000-4000-8000-0000000000a3";
      const dischargeEventId = "aaaaaaaa-0000-4000-8000-0000000000a4";
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
        id: "bbbbbbbb-0000-4000-8000-000000000001",
        organizationId: ORG_A,
        payload: {
          dischargeEventId,
          admissionId: m6AdmissionId,
          dischargeDate: "2050-03-04",
          deathCertifierId: PHYSICIAN,
        },
      });

      const admission = await admissionRow(ipuId);
      expect(admission?.state).toBe("deceased");
      expect(admission?.death_event_id).toBe(dischargeEventId);
      expect(Number(admission?.version)).toBe(1);

      // §2.11 — the bed stays occupied; cleaning is deferred until body release completes.
      const bed = await bedRow(bedId);
      expect(bed?.cleaning_status).toBe("occupied");

      const history = await historyRows(ipuId);
      expect(history).toHaveLength(1);
      expect(history[0].from_state).toBe("active");
      expect(history[0].to_state).toBe("deceased");
      expect(history[0].by_membership_id).toBe("00000000-0000-0000-0000-000000000037");
      expect(history[0].reason).toBe("death");

      const br = await bodyReleaseRows(ipuId);
      expect(br).toHaveLength(1);
      expect(br[0].organization_id).toBe(ORG_A);
      expect(br[0].provider_entity_id).toBe(admission?.provider_entity_id);
      expect(br[0].patient_id).toBe(patientId);
      expect(br[0].death_event_id).toBe(dischargeEventId);
      expect(br[0].state).toBe("pending");
      expect(br[0].pronouncing_physician_id).toBe(PHYSICIAN);
      expect(new Date(br[0].pronounced_at).toISOString().slice(0, 10)).toBe("2050-03-04");

      const deathRecorded = await outboxRows(ORG_A, "m37.ipu_admission.death_recorded");
      expect(deathRecorded).toHaveLength(1);
      expect(deathRecorded[0].payload).toMatchObject({
        ipuAdmissionId: ipuId,
        organizationId: ORG_A,
        deathEventId: dischargeEventId,
      });

      const bodyReleasePending = await outboxRows(ORG_A, "m37.body_release.pending");
      expect(bodyReleasePending).toHaveLength(1);
      expect(bodyReleasePending[0].payload).toMatchObject({
        ipuAdmissionId: ipuId,
        organizationId: ORG_A,
        bodyReleaseId: br[0].id,
      });
    });

    it("is a silent no-op when no open ipu_admission matches the M6 admission id", async () => {
      const before = await outboxRows(ORG_A, "m37.ipu_admission.death_recorded");
      await expect(
        consumer.handle({
          id: "bbbbbbbb-0000-4000-8000-000000000002",
          organizationId: ORG_A,
          payload: {
            dischargeEventId: "aaaaaaaa-0000-4000-8000-0000000000d1",
            admissionId: "aaaaaaaa-0000-4000-8000-0000000000d9",
            dischargeDate: "2050-01-01",
            deathCertifierId: PHYSICIAN,
          },
        }),
      ).resolves.toBeUndefined();
      const after = await outboxRows(ORG_A, "m37.ipu_admission.death_recorded");
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
          id: "bbbbbbbb-0000-4000-8000-000000000003",
          organizationId: ORG_A,
          payload: {
            dischargeEventId: "aaaaaaaa-0000-4000-8000-0000000000e4",
            admissionId: m6AdmissionId,
            dischargeDate: "2050-01-01",
            deathCertifierId: PHYSICIAN,
          },
        }),
      ).rejects.toMatchObject({ code: "ILLEGAL_ADMISSION_TRANSITION" });

      expect((await admissionRow(ipuId))?.state).toBe("pending"); // untouched — refused, not half-applied
      expect(await bodyReleaseRows(ipuId)).toHaveLength(0);
    });

    it("is a true no-op on redelivery after the first delivery already committed (no duplicate body_release row)", async () => {
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
        id: "bbbbbbbb-0000-4000-8000-000000000004",
        organizationId: ORG_A,
        payload: {
          dischargeEventId: "aaaaaaaa-0000-4000-8000-0000000000f4",
          admissionId: m6AdmissionId,
          dischargeDate: "2050-01-01",
          deathCertifierId: PHYSICIAN,
        },
      };
      await consumer.handle(event);
      const afterFirst = await outboxRows(ORG_A, "m37.ipu_admission.death_recorded");
      const brAfterFirst = await bodyReleaseRows(ipuId);

      await consumer.handle(event); // redelivery — the admission is already `deceased`, no longer open
      const afterSecond = await outboxRows(ORG_A, "m37.ipu_admission.death_recorded");
      const brAfterSecond = await bodyReleaseRows(ipuId);

      expect(afterSecond).toHaveLength(afterFirst.length); // no duplicate emission
      expect(brAfterSecond).toHaveLength(brAfterFirst.length); // no duplicate body_release row
      expect((await admissionRow(ipuId))?.state).toBe("deceased");
      expect(Number((await admissionRow(ipuId))?.version)).toBe(1); // not double-bumped
    });

    it("does not touch org B's admission when org A records a death (cross-tenant isolation)", async () => {
      const ipuIdB = "cccccccc-0000-4000-8000-000000000001";
      const sharedAdmissionId = "cccccccc-0000-4000-8000-000000000002";
      const patientB = "cccccccc-0000-4000-8000-000000000003";
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
        id: "bbbbbbbb-0000-4000-8000-000000000005",
        organizationId: ORG_A,
        payload: {
          dischargeEventId: "aaaaaaaa-0000-4000-8000-0000000000f9",
          admissionId: sharedAdmissionId,
          dischargeDate: "2050-01-01",
          deathCertifierId: PHYSICIAN,
        },
      });

      expect((await admissionRow(ipuIdB))?.state).toBe("active");
      expect(await bodyReleaseRows(ipuIdB)).toHaveLength(0);
    });
  },
);
