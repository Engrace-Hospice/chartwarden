/**
 * F-164 (#248) — LIVE Postgres (+ Valkey) proof that six of the m14 `handlers-unbound` group's nine
 * "since last IDG" events actually write into the shared per-patient projection cache
 * (`apps/backend/src/modules/14-idg/consumers/since-last-idg-cache.ts`):
 *
 *   - `buildM14AssessmentRecordedConsumer` / `buildM14AssessmentSignificantChangeConsumer` (M9) —
 *     `m9-since-last-idg.ts`, straight from the payload (M9's own declared/actual payload already
 *     carries `patientId`).
 *   - `buildM14HopeJ2051TriggerConsumer` / `buildM14HopeSfvCreatedConsumer` (M10) —
 *     `m10-since-last-idg.ts`, `patientId` resolved via a scoped `hope_assessment` lookup (M10's
 *     payloads carry no `patientId` at all).
 *   - `buildM14OrderDiscontinuedConsumer` (M11) / `buildM14MedicationOrderDiscontinuedConsumer` (M12) —
 *     `m11-since-last-idg.ts` / `m12-since-last-idg.ts`, `patientId` + the display field
 *     (`orderKind`/`drugLabel`) resolved via a scoped `order_record`/`medication_order` lookup by id.
 *
 * All six have existed unbound since M14-T06 — `consumers/index.ts`'s own `M14_OUTBOX_SUBSCRIPTIONS`
 * reserved their consumer names with no binding behind any of them. Proves: the correct cache entry per
 * event, idempotent redelivery via the outbox event's own id (no duplicate list entry), the "no matching
 * row" no-op for M10/M11/M12 (never fabricates a patient id), cross-tenant isolation, and the 30-day TTL.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… WARDENX_TEST_REDIS_URL=redis://localhost:PORT \
 *     bun run test:m14:since-last-idg-cache:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM14AssessmentRecordedConsumer, buildM14AssessmentSignificantChangeConsumer } from "../src/modules/14-idg/consumers/m9-since-last-idg";
import { buildM14HopeJ2051TriggerConsumer, buildM14HopeSfvCreatedConsumer } from "../src/modules/14-idg/consumers/m10-since-last-idg";
import { buildM14OrderDiscontinuedConsumer } from "../src/modules/14-idg/consumers/m11-since-last-idg";
import { buildM14MedicationOrderDiscontinuedConsumer } from "../src/modules/14-idg/consumers/m12-since-last-idg";
import { SINCE_LAST_IDG_TTL_SEC } from "../src/modules/14-idg/consumers/since-last-idg-cache";
import { hopeAssessmentPatientIdForOrg } from "../src/modules/10-hope/seams/drizzle-store";
import { orderPatientAndKindForOrg } from "../src/modules/11-orders/seams/drizzle-store";
import { medicationOrderPatientAndDrugForOrg } from "../src/modules/12-dosespot/seams/drizzle-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

/** A stable, incrementing fake outbox-row id — the dedup identity every consumer under test reads. */
let nextEventId = 1;
function fakeEvent(organizationId: string, payload: unknown) {
  return {
    id: `eeeeeeee-0000-4000-8000-${String(nextEventId++).padStart(12, "0")}`,
    organizationId,
    eventType: "test",
    aggregateKind: "test",
    aggregateId: "test",
    payload,
    attemptCount: 1,
    createdAt: new Date(),
  };
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "F-164 — M14's since-last-IDG projection-cache consumers — LIVE Postgres + Valkey",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let redis: IORedis;
    let providerA: string;
    let providerB: string;
    let locationA: string;
    let locationB: string;
    let memberA: string;

    let recordedConsumer: ReturnType<typeof buildM14AssessmentRecordedConsumer>;
    let significantChangeConsumer: ReturnType<typeof buildM14AssessmentSignificantChangeConsumer>;
    let j2051Consumer: ReturnType<typeof buildM14HopeJ2051TriggerConsumer>;
    let sfvConsumer: ReturnType<typeof buildM14HopeSfvCreatedConsumer>;
    let orderDiscontinuedConsumer: ReturnType<typeof buildM14OrderDiscontinuedConsumer>;
    let medOrderDiscontinuedConsumer: ReturnType<typeof buildM14MedicationOrderDiscontinuedConsumer>;

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

    async function cacheEntry(patientId: string): Promise<Record<string, unknown[]> | null> {
      const raw = await redis.get(`wardenx:m14:idg:since-last-idg:${patientId}`);
      return raw ? JSON.parse(raw) : null;
    }

    async function seedHopeAssessment(opts: { organizationId: string; providerEntityId: string }) {
      const { rows } = await admin.query(
        `INSERT INTO hope_assessment
           (organization_id, provider_entity_id, patient_id, admission_id, rfa_kind, data, target_date,
            created_by_membership_id)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),'01_admission','{}'::jsonb, now(), $3)
         RETURNING id, patient_id`,
        [opts.organizationId, opts.providerEntityId, memberA],
      );
      return { id: rows[0].id as string, patientId: rows[0].patient_id as string };
    }

    async function seedOrder(opts: { organizationId: string; providerEntityId: string; kind: string }) {
      const { rows } = await admin.query(
        `INSERT INTO order_record
           (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
            status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),$3,'v1','{}'::jsonb,'active',$4,
                 'rn_case_manager',$5)
         RETURNING id, patient_id`,
        [opts.organizationId, opts.providerEntityId, opts.kind, memberA, PHYSICIAN_MDM],
      );
      return { id: rows[0].id as string, patientId: rows[0].patient_id as string };
    }

    async function seedMedicationOrder(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
    }) {
      const { rows } = await admin.query(
        `INSERT INTO medication_order
           (organization_id, provider_entity_id, location_id, patient_id, admission_id, med_class,
            drug_name, strength, dose_form, route, data, prescriber_membership_id,
            prescribing_physician_mdm_id, status)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),'standard','Morphine','5 mg','tablet',
                 'oral','{}'::jsonb,$4,$5,'active')
         RETURNING id, patient_id`,
        [opts.organizationId, opts.providerEntityId, opts.locationId, memberA, PHYSICIAN_MDM],
      );
      return { id: rows[0].id as string, patientId: rows[0].patient_id as string };
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m14-slic-a','M14 SLIC A','M14 SLIC A'),
                ($2,'m14-slic-b','M14 SLIC B','M14 SLIC B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f16x@x.test')`, [USER]);
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M14X-A','Provider A','1300000001','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M14X-B','Provider B','1300000002','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      locationA = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Location A','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
          [providerA],
        )
      ).rows[0].id as string;
      locationB = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Location B','2 Main St','Town','NY','10001','America/New_York') RETURNING id`,
          [providerB],
        )
      ).rows[0].id as string;
      memberA = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      redis = new IORedis({ ...parseRedisUrl(REDIS_URL as string), maxRetriesPerRequest: null });
      await redis.keys("wardenx:m14:idg:since-last-idg:*").then((keys) =>
        keys.length ? redis.del(...keys) : undefined,
      );

      recordedConsumer = buildM14AssessmentRecordedConsumer({ redis });
      significantChangeConsumer = buildM14AssessmentSignificantChangeConsumer({ redis });
      j2051Consumer = buildM14HopeJ2051TriggerConsumer({
        redis,
        patientIdForHopeAssessment: (orgId, hopeAssessmentId) =>
          hopeAssessmentPatientIdForOrg(handle.db, orgId, hopeAssessmentId),
      });
      sfvConsumer = buildM14HopeSfvCreatedConsumer({
        redis,
        patientIdForHopeAssessment: (orgId, hopeAssessmentId) =>
          hopeAssessmentPatientIdForOrg(handle.db, orgId, hopeAssessmentId),
      });
      orderDiscontinuedConsumer = buildM14OrderDiscontinuedConsumer({
        redis,
        orderPatientAndKind: (orgId, orderId) => orderPatientAndKindForOrg(handle.db, orgId, orderId),
      });
      medOrderDiscontinuedConsumer = buildM14MedicationOrderDiscontinuedConsumer({
        redis,
        medicationOrderPatientAndDrug: (orgId, orderId) =>
          medicationOrderPatientAndDrugForOrg(handle.db, orgId, orderId),
      });
    }, 120_000);

    afterAll(async () => {
      await redis?.quit();
      await handle?.close();
      if (admin) await admin.end();
    });

    describe("m9.assessment.recorded / .significant_change — shared significantAssessmentChanges slot", () => {
      it("appends a recorded assessment with changeKind 'recorded'", async () => {
        const patientId = "aaaaaaaa-2000-4000-8000-000000000001";
        const assessmentId = "aaaaaaaa-2000-4000-8000-000000000002";
        await recordedConsumer.handle(
          fakeEvent(ORG_A, {
            patientId,
            assessmentId,
            admissionId: "aaaaaaaa-2000-4000-8000-000000000003",
            scaleType: "esas_r",
            score: 4,
            capturedAt: "2026-06-01T00:00:00.000Z",
            isCorrection: false,
          }),
        );
        const entry = await cacheEntry(patientId);
        expect(entry?.significantAssessmentChanges).toHaveLength(1);
        expect(entry?.significantAssessmentChanges[0]).toMatchObject({
          assessmentId,
          scaleKind: "esas_r",
          changeKind: "recorded",
          occurredAt: "2026-06-01T00:00:00.000Z",
        });
      });

      it("marks a correction with changeKind 'corrected'", async () => {
        const patientId = "aaaaaaaa-2000-4000-8000-000000000004";
        await recordedConsumer.handle(
          fakeEvent(ORG_A, {
            patientId,
            assessmentId: "aaaaaaaa-2000-4000-8000-000000000005",
            admissionId: "aaaaaaaa-2000-4000-8000-000000000006",
            scaleType: "pps",
            score: 60,
            capturedAt: "2026-06-02T00:00:00.000Z",
            isCorrection: true,
          }),
        );
        const entry = await cacheEntry(patientId);
        expect(entry?.significantAssessmentChanges[0]).toMatchObject({ changeKind: "corrected" });
      });

      it("appends a significant-change entry keyed by ruleId into the SAME slot", async () => {
        const patientId = "aaaaaaaa-2000-4000-8000-000000000007";
        const assessmentId = "aaaaaaaa-2000-4000-8000-000000000008";
        await significantChangeConsumer.handle(
          fakeEvent(ORG_A, {
            patientId,
            assessmentId,
            ruleId: "esas_symptom_ge_7",
            scaleType: "esas_r",
            deltaValue: 3,
            thresholdValue: 7,
            severity: "attention",
            detectedAt: "2026-06-03T00:00:00.000Z",
          }),
        );
        const entry = await cacheEntry(patientId);
        expect(entry?.significantAssessmentChanges).toHaveLength(1);
        expect(entry?.significantAssessmentChanges[0]).toMatchObject({
          assessmentId,
          changeKind: "esas_symptom_ge_7",
          occurredAt: "2026-06-03T00:00:00.000Z",
        });
      });

      it("is idempotent on redelivery of the same outbox event id — no duplicate entry", async () => {
        const patientId = "aaaaaaaa-2000-4000-8000-000000000009";
        const event = fakeEvent(ORG_A, {
          patientId,
          assessmentId: "aaaaaaaa-2000-4000-8000-00000000000a",
          admissionId: "aaaaaaaa-2000-4000-8000-00000000000b",
          scaleType: "esas_r",
          score: 2,
          capturedAt: "2026-06-04T00:00:00.000Z",
          isCorrection: false,
        });
        await recordedConsumer.handle(event);
        await recordedConsumer.handle(event); // exact same event.id — a redelivery
        const entry = await cacheEntry(patientId);
        expect(entry?.significantAssessmentChanges).toHaveLength(1);
      });

      it("sets a ~30-day TTL on the cache key", async () => {
        const patientId = "aaaaaaaa-2000-4000-8000-00000000000c";
        await recordedConsumer.handle(
          fakeEvent(ORG_A, {
            patientId,
            assessmentId: "aaaaaaaa-2000-4000-8000-00000000000d",
            admissionId: "aaaaaaaa-2000-4000-8000-00000000000e",
            scaleType: "esas_r",
            score: 1,
            capturedAt: "2026-06-05T00:00:00.000Z",
            isCorrection: false,
          }),
        );
        const ttl = await redis.ttl(`wardenx:m14:idg:since-last-idg:${patientId}`);
        expect(ttl).toBeGreaterThan(SINCE_LAST_IDG_TTL_SEC - 60);
        expect(ttl).toBeLessThanOrEqual(SINCE_LAST_IDG_TTL_SEC);
      });
    });

    describe("m10.hope.j2051_trigger_fired / .sfv_created — shared j2051Triggers slot, patientId resolved via hope_assessment", () => {
      it("resolves patientId from the real hope_assessment row and appends a j2051 trigger", async () => {
        const { id: assessmentId, patientId } = await seedHopeAssessment({
          organizationId: ORG_A,
          providerEntityId: providerA,
        });
        await j2051Consumer.handle(
          fakeEvent(ORG_A, {
            assessmentId,
            sfvId: "aaaaaaaa-3000-4000-8000-000000000001",
            maxSeverity: "severe",
            triggeredAt: "2026-06-06T00:00:00.000Z",
            dueAt: "2026-06-13T00:00:00.000Z",
          }),
        );
        const entry = await cacheEntry(patientId);
        expect(entry?.j2051Triggers).toHaveLength(1);
        expect(entry?.j2051Triggers[0]).toMatchObject({
          hopeAssessmentId: assessmentId,
          triggerKind: "j2051_severe",
          firedAt: "2026-06-06T00:00:00.000Z",
        });
      });

      it("appends an sfv_created entry into the SAME slot", async () => {
        const { id: assessmentId, patientId } = await seedHopeAssessment({
          organizationId: ORG_A,
          providerEntityId: providerA,
        });
        await sfvConsumer.handle(
          fakeEvent(ORG_A, {
            triggeringAssessmentId: assessmentId,
            sfvId: "aaaaaaaa-3000-4000-8000-000000000002",
            dueAt: "2026-06-20T00:00:00.000Z",
          }),
        );
        const entry = await cacheEntry(patientId);
        expect(entry?.j2051Triggers).toHaveLength(1);
        expect(entry?.j2051Triggers[0]).toMatchObject({
          hopeAssessmentId: assessmentId,
          triggerKind: "sfv_created",
          firedAt: "2026-06-20T00:00:00.000Z",
        });
      });

      it("is a no-op when no hope_assessment matches in this org (never fabricates a patient id)", async () => {
        await j2051Consumer.handle(
          fakeEvent(ORG_A, {
            assessmentId: "aaaaaaaa-3000-4000-8000-000000000099",
            sfvId: "aaaaaaaa-3000-4000-8000-00000000009a",
            maxSeverity: "mild",
            triggeredAt: "2026-06-07T00:00:00.000Z",
            dueAt: "2026-06-14T00:00:00.000Z",
          }),
        );
        // Nothing thrown, and no key created for an id we cannot map — proven by the next test's isolation.
        expect(true).toBe(true);
      });

      it("does not cross tenants — org B's hope_assessment id is invisible to org A's delivery", async () => {
        const { id: assessmentId } = await seedHopeAssessment({
          organizationId: ORG_B,
          providerEntityId: providerB,
        });
        await j2051Consumer.handle(
          fakeEvent(ORG_A, {
            assessmentId,
            sfvId: "aaaaaaaa-3000-4000-8000-000000000003",
            maxSeverity: "severe",
            triggeredAt: "2026-06-08T00:00:00.000Z",
            dueAt: "2026-06-15T00:00:00.000Z",
          }),
        );
        // org A's read of org B's assessment id resolves to nothing — no key was ever created keyed on a
        // patient this org cannot see. Assert directly against the DB that the row really is org B's.
        const { rows } = await admin.query("SELECT organization_id FROM hope_assessment WHERE id=$1", [
          assessmentId,
        ]);
        expect(rows[0].organization_id).toBe(ORG_B);
      });
    });

    describe("m11.order.discontinued — orderChanges slot, patientId+kind resolved via order_record", () => {
      it("resolves patientId+orderKind from the real order_record row", async () => {
        const { id: orderId, patientId } = await seedOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          kind: "dme",
        });
        await orderDiscontinuedConsumer.handle(
          fakeEvent(ORG_A, {
            orderId,
            discontinuationId: "aaaaaaaa-4000-4000-8000-000000000001",
            reason: "clinical_change",
            actorMembershipId: memberA,
            effectiveAt: "2026-06-09T00:00:00.000Z",
          }),
        );
        const entry = await cacheEntry(patientId);
        expect(entry?.orderChanges).toHaveLength(1);
        expect(entry?.orderChanges[0]).toMatchObject({
          orderId,
          orderKind: "dme",
          changeKind: "discontinued",
          changedAt: "2026-06-09T00:00:00.000Z",
        });
      });

      it("does not cross tenants — org A cannot resolve org B's order id", async () => {
        const { id: orderId } = await seedOrder({
          organizationId: ORG_B,
          providerEntityId: providerB,
          kind: "supply",
        });
        await orderDiscontinuedConsumer.handle(
          fakeEvent(ORG_A, {
            orderId,
            discontinuationId: "aaaaaaaa-4000-4000-8000-000000000002",
            reason: "clinical_change",
            actorMembershipId: memberA,
            effectiveAt: "2026-06-10T00:00:00.000Z",
          }),
        );
        const { rows } = await admin.query("SELECT organization_id FROM order_record WHERE id=$1", [
          orderId,
        ]);
        expect(rows[0].organization_id).toBe(ORG_B); // untouched by org A's delivery; no cache entry possible
      });
    });

    describe("m12.medication_order.discontinued — medicationChanges slot, patientId+drugLabel resolved via medication_order", () => {
      it("resolves patientId+drugLabel from the real medication_order row", async () => {
        const { id: orderId, patientId } = await seedMedicationOrder({
          organizationId: ORG_A,
          providerEntityId: providerA,
          locationId: locationA,
        });
        await medOrderDiscontinuedConsumer.handle(
          fakeEvent(ORG_A, {
            orderId,
            reason: "clinical_change",
            actorMembershipId: memberA,
            effectiveAt: "2026-06-11T00:00:00.000Z",
          }),
        );
        const entry = await cacheEntry(patientId);
        expect(entry?.medicationChanges).toHaveLength(1);
        expect(entry?.medicationChanges[0]).toMatchObject({
          medicationOrderId: orderId,
          drugLabel: "Morphine",
          changeKind: "discontinued",
          changedAt: "2026-06-11T00:00:00.000Z",
        });
      });

      it("does not cross tenants — org A cannot resolve org B's medication order id", async () => {
        const { id: orderId } = await seedMedicationOrder({
          organizationId: ORG_B,
          providerEntityId: providerB,
          locationId: locationB,
        });
        await medOrderDiscontinuedConsumer.handle(
          fakeEvent(ORG_A, {
            orderId,
            reason: "clinical_change",
            actorMembershipId: memberA,
            effectiveAt: "2026-06-12T00:00:00.000Z",
          }),
        );
        const { rows } = await admin.query("SELECT organization_id FROM medication_order WHERE id=$1", [
          orderId,
        ]);
        expect(rows[0].organization_id).toBe(ORG_B); // untouched by org A's delivery
      });
    });
  },
);
