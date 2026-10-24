/**
 * F-155/F-159 (#248) — LIVE Postgres proof that M6's §2.3.5 LCP transition binding
 * (`buildM6LevelOfCareChangeSignedConsumer`) for `m11.order.level_of_care_change_signed` actually writes
 * real `level_of_care_period` rows under RLS.
 *
 * `transitionLevelOfCare` (`state-machines/level-of-care.ts`) and `changeLoc`
 * (`admission-route-service-db.ts`) have existed since M6-T04 with no outbox binding at all — M11's D9
 * ("M11 emits `m11.order.level_of_care_change_signed`; M6 subscribes and runs its LCP transition") sat in
 * `scripts/outbox-deferred-consumers.ts`'s m6 `handlers-unbound` group across F-143 and F-155.
 *
 * This proves the real binding: migration 0250's `level_of_care_period.source_order_id` +
 * `UNIQUE(organization_id, source_order_id)` idempotency guard, the close-prior-open-period +
 * insert-new-period sequence mirroring `changeLoc`, the real catalog-validated `m6.loc.changed` publish
 * (rhc/chc only — see below), idempotent redelivery (no second row, no second event), a second real
 * order-driven change closing the first period and opening a second, cross-tenant isolation, and the
 * documented honest refusal for irc/gip (M11's catalogued payload carries no `facilityId`, and
 * `transitionLevelOfCare`'s own §2.3.5 guard requires one for `inpatient_respite_care`/
 * `general_inpatient_care` — this consumer passes `facilityId: null` rather than fabricate one, so both
 * levels deterministically throw `IPU_FACILITY_REQUIRED`).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:loc-change-signed:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { buildM6LevelOfCareChangeSignedConsumer } from "../src/modules/06-admission/outbox-consumers/m11-level-of-care-change-signed";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-155/F-159 — M6's m11.order.level_of_care_change_signed LCP binding — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM6LevelOfCareChangeSignedConsumer>;

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

    /** Seed a minimal `admission` row directly — this consumer reads only `status`, so the full
     *  referral/CTI/election ceremony (`_m6-admit.ts`) would prove nothing extra here. */
    async function seedAdmission(
      organizationId: string,
      status: "active" | "on_hold",
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO admission (organization_id, patient_id, status)
         VALUES ($1, gen_random_uuid(), $2) RETURNING id`,
        [organizationId, status],
      );
      return rows[0].id as string;
    }

    async function openLocRows(admissionId: string) {
      const { rows } = await admin.query(
        `SELECT id, level_of_care, status, source_order_id, ended_at
           FROM level_of_care_period WHERE admission_id = $1 ORDER BY created_at`,
        [admissionId],
      );
      return rows;
    }

    async function locChangedEvents(organizationId: string, admissionId: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event
           WHERE organization_id = $1 AND event_type = 'm6.loc.changed'
             AND payload->>'admissionId' = $2`,
        [organizationId, admissionId],
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
         VALUES ($1,'m6-loc-change-signed-a','M6 LOC Change Signed A','M6 LOC Change Signed A'),
                ($2,'m6-loc-change-signed-b','M6 LOC Change Signed B','M6 LOC Change Signed B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M6_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      consumer = buildM6LevelOfCareChangeSignedConsumer({
        db: handle.db,
        outbox: {
          async publish(tx, input) {
            const entry = catalog.get(input.eventName);
            if (!entry) throw new Error(`m6 test publisher: undeclared event ${input.eventName}`);
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

    it("opens a new active LOC period for rhc, stamps source_order_id, and publishes m6.loc.changed", async () => {
      const admissionId = await seedAdmission(ORG_A, "active");
      const orderId = "aaaaaaaa-1111-4000-8000-000000000001";

      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          orderId,
          fromLevel: "chc",
          toLevel: "rhc",
          effectiveAt: "2026-02-01T00:00:00.000Z",
          admissionId,
        },
      });

      const rows = await openLocRows(admissionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].level_of_care).toBe("routine_home_care");
      expect(rows[0].status).toBe("active");
      expect(rows[0].source_order_id).toBe(orderId);
      expect(rows[0].ended_at).toBeNull();

      const events = await locChangedEvents(ORG_A, admissionId);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        newLevel: "routine_home_care",
        admissionId,
        levelOfCarePeriodId: rows[0].id,
      });
    });

    it("is idempotent on redelivery — no second period, no second event", async () => {
      const admissionId = await seedAdmission(ORG_A, "active");
      const orderId = "aaaaaaaa-1111-4000-8000-000000000002";
      const deliver = () =>
        consumer.handle({
          organizationId: ORG_A,
          payload: {
            orderId,
            fromLevel: "rhc",
            toLevel: "chc",
            effectiveAt: "2026-02-01T00:00:00.000Z",
            admissionId,
          },
        });

      await deliver();
      await deliver();
      await deliver();

      const rows = await openLocRows(admissionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].level_of_care).toBe("continuous_home_care");

      const events = await locChangedEvents(ORG_A, admissionId);
      expect(events).toHaveLength(1);
    });

    it("a second order-driven change closes the first period and opens a second", async () => {
      const admissionId = await seedAdmission(ORG_A, "active");
      const orderIdRhc = "aaaaaaaa-1111-4000-8000-000000000003";
      const orderIdChc = "aaaaaaaa-1111-4000-8000-000000000004";

      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          orderId: orderIdRhc,
          fromLevel: "chc",
          toLevel: "rhc",
          effectiveAt: "2026-02-01T00:00:00.000Z",
          admissionId,
        },
      });
      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          orderId: orderIdChc,
          fromLevel: "rhc",
          toLevel: "chc",
          effectiveAt: "2026-02-05T00:00:00.000Z",
          admissionId,
        },
      });

      const rows = await openLocRows(admissionId);
      expect(rows).toHaveLength(2);
      expect(rows[0].level_of_care).toBe("routine_home_care");
      expect(rows[0].ended_at).not.toBeNull(); // closed by the second change
      expect(rows[1].level_of_care).toBe("continuous_home_care");
      expect(rows[1].ended_at).toBeNull(); // the currently-open period

      const events = await locChangedEvents(ORG_A, admissionId);
      expect(events).toHaveLength(2);
    });

    it("throws IPU_FACILITY_REQUIRED for irc — the documented honest refusal (no facilityId on the wire)", async () => {
      const admissionId = await seedAdmission(ORG_A, "active");
      // AdmissionStateError's `code` ("IPU_FACILITY_REQUIRED") is a distinct property from `.message`
      // ("IRC/GIP requires a facility_id") — assert on the code, not a message-text regex.
      await expect(
        consumer.handle({
          organizationId: ORG_A,
          payload: {
            orderId: "aaaaaaaa-1111-4000-8000-000000000005",
            fromLevel: "rhc",
            toLevel: "irc",
            effectiveAt: "2026-02-01T00:00:00.000Z",
            admissionId,
          },
        }),
      ).rejects.toMatchObject({ code: "IPU_FACILITY_REQUIRED" });
      expect(await openLocRows(admissionId)).toHaveLength(0);
    });

    it("throws IPU_FACILITY_REQUIRED for gip — the same guard fires before the documentation-length check", async () => {
      const admissionId = await seedAdmission(ORG_A, "active");
      await expect(
        consumer.handle({
          organizationId: ORG_A,
          payload: {
            orderId: "aaaaaaaa-1111-4000-8000-000000000006",
            fromLevel: "rhc",
            toLevel: "gip",
            effectiveAt: "2026-02-01T00:00:00.000Z",
            admissionId,
          },
        }),
      ).rejects.toMatchObject({ code: "IPU_FACILITY_REQUIRED" });
      expect(await openLocRows(admissionId)).toHaveLength(0);
    });

    it("refuses an admission it cannot resolve rather than guess", async () => {
      await expect(
        consumer.handle({
          organizationId: ORG_A,
          payload: {
            orderId: "aaaaaaaa-1111-4000-8000-000000000007",
            fromLevel: "rhc",
            toLevel: "chc",
            effectiveAt: "2026-02-01T00:00:00.000Z",
            admissionId: "aaaaaaaa-0000-4000-8000-0000000000ff",
          },
        }),
      ).rejects.toThrow(/no admission/);
    });

    it("does not cross tenants — org B's admission is untouched by org A's delivery", async () => {
      const admissionA = await seedAdmission(ORG_A, "active");
      const admissionB = await seedAdmission(ORG_B, "active");

      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          orderId: "aaaaaaaa-1111-4000-8000-000000000008",
          fromLevel: "chc",
          toLevel: "rhc",
          effectiveAt: "2026-02-01T00:00:00.000Z",
          admissionId: admissionA,
        },
      });

      expect(await openLocRows(admissionA)).toHaveLength(1);
      expect(await openLocRows(admissionB)).toHaveLength(0);
    });
  },
);
