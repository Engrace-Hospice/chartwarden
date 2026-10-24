/**
 * F-166 (#248) — LIVE Postgres proof that M13's §2.3 D2 scheduled-dose materializer
 * (`buildM13MaterializeScheduleConsumer`) and the order-discontinue cascade
 * (`buildM13CancelFutureScheduleConsumer`) actually write `scheduled_dose` rows, for real, under RLS.
 *
 * `materializeForOrder` (`@chartwarden/emar`) has been complete, pure, IO-free since M13-T03 with NO caller
 * anywhere in this repository; `M13_OUTBOX_SUBSCRIPTIONS` has named `m12.medication_order.active` with a
 * real consumer (`m13.materialize-schedule`) since the list was written — nothing has ever bound it, and
 * no INSERT into `scheduled_dose` has ever existed in this codebase before this change.
 *
 * Proves: a signed, activated BID order materializes the correct number of DST-exact rows within the
 * org's real `administration_policy.materialization_window_days`; a redelivery of the same event inserts
 * nothing new (the `sched_dose_order_due_uk` unique index); a PRN order materializes zero rows; a
 * discontinued order's future doses are cancelled with the real `order_discontinued` reason and a past
 * dose is left untouched; a redelivery of the discontinue event is a no-op; and cross-tenant isolation
 * (org B's rows are untouched by org A's materialize/discontinue).
 *
 * Exercises the REAL M12 (`medicationOrderScheduleContextForOrg`), M6 (`admissionSchedulingContextForOrg`)
 * and M1 (`FoundationSiteReader.locationTimezone`) seam functions end to end — not faked closures — since
 * all three are new code this change adds.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m13:scheduled-dose-materialization:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { admissionSchedulingContextForOrg } from "../src/modules/06-admission/seams/drizzle-store";
import { medicationOrderScheduleContextForOrg } from "../src/modules/12-dosespot/seams/drizzle-store";
import {
  M13_OUTBOX_EVENTS,
  buildM13CancelFutureScheduleConsumer,
  buildM13MaterializeScheduleConsumer,
} from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ADMISSION_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ADMISSION_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const PATIENT_A = "aaaaaaaa-1111-4111-8111-0000000000a1";
const PATIENT_B = "bbbbbbbb-1111-4111-8111-0000000000b1";
const PHYSICIAN_MDM_ID = "99999999-0000-4000-8000-000000000001";

describe.skipIf(!DB_URL)(
  "F-166 — M13's scheduled-dose materialize + order-discontinue-cascade consumers — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let locationA: string;
    let locationB: string;
    let membershipA: string;
    let membershipB: string;
    let materialize: ReturnType<typeof buildM13MaterializeScheduleConsumer>;
    let cancelFuture: ReturnType<typeof buildM13CancelFutureScheduleConsumer>;

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

    async function insertOrder(opts: {
      id: string;
      organizationId: string;
      patientId: string;
      admissionId: string;
      prescriberMembershipId: string;
      status: string;
      activatedAt: string | null;
      frequencyCode: string;
      asNeeded: boolean;
      isControlledSubstance?: boolean;
      medClass?: string;
    }) {
      await admin.query(
        `INSERT INTO medication_order
           (id, organization_id, patient_id, admission_id, med_class, is_controlled_substance,
            drug_name, strength, dose_form, route, data, prescriber_membership_id,
            prescribing_physician_mdm_id, status, activated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'Test Drug','5 mg','tablet','oral',$7,$8,$9,$10,$11)`,
        [
          opts.id,
          opts.organizationId,
          opts.patientId,
          opts.admissionId,
          opts.medClass ?? "standard",
          opts.isControlledSubstance ?? false,
          JSON.stringify({
            sigStructured: {
              doseQuantity: 1,
              doseUnit: "tab",
              route: "oral",
              frequencyCode: opts.frequencyCode,
              asNeeded: opts.asNeeded,
            },
          }),
          opts.prescriberMembershipId,
          PHYSICIAN_MDM_ID,
          opts.status,
          opts.activatedAt,
        ],
      );
    }

    async function insertDose(opts: {
      id: string;
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      patientId: string;
      admissionId: string;
      medicationOrderId: string;
      dueAt: string;
      status: string;
    }) {
      await admin.query(
        `INSERT INTO scheduled_dose
           (id, organization_id, provider_entity_id, location_id, patient_id, admission_id,
            medication_order_id, due_at, grace_window_minutes, expected_dose_amount, expected_dose_unit,
            expected_route, status, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,30,1,'tab','oral',$9,1)`,
        [
          opts.id,
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          opts.patientId,
          opts.admissionId,
          opts.medicationOrderId,
          opts.dueAt,
          opts.status,
        ],
      );
    }

    async function doseRows(organizationId: string, medicationOrderId: string) {
      const { rows } = await admin.query(
        `SELECT id, status, cancellation_reason, cancellation_source_event_id, due_at
         FROM scheduled_dose WHERE organization_id = $1 AND medication_order_id = $2 ORDER BY due_at`,
        [organizationId, medicationOrderId],
      );
      return rows;
    }
    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2`,
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
         VALUES ($1,'m13-f166-a','M13 F166 A','M13 F166 A'),
                ($2,'m13-f166-b','M13 F166 B','M13 F166 B')`,
        [ORG_A, ORG_B],
      );
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13F166A','F166 Provider A','1300000011','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M13F166B','F166 Provider B','1300000012','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      locationA = (
        await admin.query(
          `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'F166 Location A','1 Test St','Testville','OR','97201','America/Los_Angeles')
           RETURNING id`,
          [providerA],
        )
      ).rows[0].id as string;
      locationB = (
        await admin.query(
          `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'F166 Location B','1 Test St','Testville','OR','97201','America/New_York')
           RETURNING id`,
          [providerB],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO admission (id,organization_id,patient_id,provider_entity_id,location_id,status,admission_at,activated_at)
         VALUES ($1,$2,$3,$4,$5,'active',now(),now())`,
        [ADMISSION_A, ORG_A, PATIENT_A, providerA, locationA],
      );
      await admin.query(
        `INSERT INTO admission (id,organization_id,patient_id,provider_entity_id,location_id,status,admission_at,activated_at)
         VALUES ($1,$2,$3,$4,$5,'active',now(),now())`,
        [ADMISSION_B, ORG_B, PATIENT_B, providerB, locationB],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES
        ('99999999-1111-4111-8111-0000000000a1','f166a@x.test'),
        ('99999999-1111-4111-8111-0000000000b1','f166b@x.test')`);
      membershipA = (
        await admin.query(
          `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`,
          ["99999999-1111-4111-8111-0000000000a1", ORG_A],
        )
      ).rows[0].id as string;
      membershipB = (
        await admin.query(
          `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$2,'active') RETURNING id`,
          ["99999999-1111-4111-8111-0000000000b1", ORG_B],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M13_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      const outbox = {
        async publish(
          tx: unknown,
          input: {
            readonly eventName: string;
            readonly payload: Record<string, unknown>;
            readonly organizationId: string;
            readonly aggregateKind: string;
            readonly aggregateId: string;
          },
        ) {
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
      };

      materialize = buildM13MaterializeScheduleConsumer({
        db: handle.db,
        outbox,
        orderContext: (organizationId, orderId) =>
          medicationOrderScheduleContextForOrg(handle.db, organizationId, orderId),
        resolveAdmission: async (organizationId, admissionId) => {
          const ctx = await admissionSchedulingContextForOrg(
            handle.db,
            organizationId,
            admissionId,
          );
          return ctx
            ? { providerEntityId: ctx.providerEntityId, locationId: ctx.locationId }
            : null;
        },
        locationTimezone: (organizationId, locationId) =>
          withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
            buildFoundationSiteReader().locationTimezone(tx as unknown as DbClient, locationId),
          ),
      });
      cancelFuture = buildM13CancelFutureScheduleConsumer({ db: handle.db, outbox });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("materializes a BID order's DST-exact schedule for the org's real materialization window", async () => {
      const orderId = "dddddddd-0000-4000-8000-000000000001";
      await insertOrder({
        id: orderId,
        organizationId: ORG_A,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        prescriberMembershipId: membershipA,
        status: "active",
        activatedAt: "2024-01-01T12:00:00Z",
        frequencyCode: "bid",
        asNeeded: false,
      });

      await materialize.handle({
        id: "eeeeeeee-0000-4000-8000-000000000001",
        organizationId: ORG_A,
        payload: { orderId, fullDto: null },
      });

      // Default policy window is 7 days, BID = 2 doses/day = 14 rows (the activation instant, 2024-01-01
      // 12:00Z = 04:00 America/Los_Angeles, is before both order-local BID slots — nothing is dropped).
      const rows = await doseRows(ORG_A, orderId);
      expect(rows).toHaveLength(14);
      expect(rows.every((r: { status: string }) => r.status === "pending")).toBe(true);

      const emissions = await outboxRows(ORG_A, "m13.scheduled_dose.materialized");
      expect(emissions).toHaveLength(1);
      expect(emissions[0].payload.medicationOrderId).toBe(orderId);
      expect(emissions[0].payload.scheduledDoseIds).toHaveLength(14);
    });

    it("is a true no-op on redelivery (the unique index absorbs the duplicate window)", async () => {
      const orderId = "dddddddd-0000-4000-8000-000000000001"; // same order as above
      const before = await doseRows(ORG_A, orderId);

      await materialize.handle({
        id: "eeeeeeee-0000-4000-8000-000000000002", // a different event id — still a redelivery in effect
        organizationId: ORG_A,
        payload: { orderId, fullDto: null },
      });

      const after = await doseRows(ORG_A, orderId);
      expect(after).toHaveLength(before.length); // no new rows
      const emissions = await outboxRows(ORG_A, "m13.scheduled_dose.materialized");
      expect(emissions).toHaveLength(1); // still just the one from the first delivery
    });

    it("materializes zero rows for a PRN order", async () => {
      const orderId = "dddddddd-0000-4000-8000-000000000002";
      await insertOrder({
        id: orderId,
        organizationId: ORG_A,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        prescriberMembershipId: membershipA,
        status: "active",
        activatedAt: "2024-01-01T12:00:00Z",
        frequencyCode: "q4h",
        asNeeded: true, // asNeeded short-circuits to PRN regardless of the code
      });

      await materialize.handle({
        id: "eeeeeeee-0000-4000-8000-000000000003",
        organizationId: ORG_A,
        payload: { orderId, fullDto: null },
      });

      expect(await doseRows(ORG_A, orderId)).toHaveLength(0);
    });

    it("cancels a discontinued order's future doses with the real order_discontinued reason, leaves a past-due dose alone, and publishes the cancelled signal", async () => {
      const orderId = "dddddddd-0000-4000-8000-000000000003";
      await insertOrder({
        id: orderId,
        organizationId: ORG_A,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        prescriberMembershipId: membershipA,
        status: "discontinued",
        activatedAt: "2020-01-01T12:00:00Z",
        frequencyCode: "bid",
        asNeeded: false,
      });
      const futureDoseId = "ffffffff-0000-4000-8000-000000000001";
      const pastDoseId = "ffffffff-0000-4000-8000-000000000002";
      await insertDose({
        id: futureDoseId,
        organizationId: ORG_A,
        providerEntityId: providerA,
        locationId: locationA,
        patientId: PATIENT_A,
        admissionId: ADMISSION_A,
        medicationOrderId: orderId,
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
        medicationOrderId: orderId,
        dueAt: "2000-01-01T08:00:00Z",
        status: "pending",
      });
      const eventId = "eeeeeeee-0000-4000-8000-000000000004";

      await cancelFuture.handle({
        id: eventId,
        organizationId: ORG_A,
        payload: {
          orderId,
          reason: "clinical_decision",
          actorMembershipId: membershipA,
          effectiveAt: "2050-01-01T00:00:00Z",
        },
      });

      const rows = await doseRows(ORG_A, orderId);
      const future = rows.find((r: { id: string }) => r.id === futureDoseId);
      expect(future?.status).toBe("cancelled");
      expect(future?.cancellation_reason).toBe("order_discontinued");
      expect(future?.cancellation_source_event_id).toBe(eventId);
      const past = rows.find((r: { id: string }) => r.id === pastDoseId);
      expect(past?.status).toBe("pending"); // never retro-marked

      const emissions = await outboxRows(ORG_A, "m13.scheduled_dose.cancelled");
      const forThisOrder = emissions.filter(
        (e: { payload: { medicationOrderId: string } }) => e.payload.medicationOrderId === orderId,
      );
      expect(forThisOrder).toHaveLength(1);
      expect(forThisOrder[0].payload.scheduledDoseId).toBe(futureDoseId);
      expect(forThisOrder[0].payload.cancellationReason).toBe("order_discontinued");
    });

    it("is a true no-op on redelivery of the discontinue event", async () => {
      const orderId = "dddddddd-0000-4000-8000-000000000003"; // same order as above
      const before = await doseRows(ORG_A, orderId);

      await cancelFuture.handle({
        id: "eeeeeeee-0000-4000-8000-000000000005",
        organizationId: ORG_A,
        payload: {
          orderId,
          reason: "clinical_decision",
          actorMembershipId: membershipA,
          effectiveAt: "2050-01-01T00:00:00Z",
        },
      });

      const after = await doseRows(ORG_A, orderId);
      expect(after.map((r: { status: string }) => r.status)).toEqual(
        before.map((r: { status: string }) => r.status),
      ); // no state change on redelivery
    });

    it("throws when the M12 order does not resolve in this org (dead-letters rather than silently no-op)", async () => {
      await expect(
        materialize.handle({
          id: "eeeeeeee-0000-4000-8000-000000000006",
          organizationId: ORG_A,
          payload: { orderId: "dddddddd-0000-4000-8000-0000000000ff", fullDto: null },
        }),
      ).rejects.toThrow(/no M12 order/);
    });

    it("does not touch org B's rows when org A materializes or discontinues (cross-tenant isolation)", async () => {
      const orderIdB = "dddddddd-0000-4000-8000-0000000000b1";
      await insertOrder({
        id: orderIdB,
        organizationId: ORG_B,
        patientId: PATIENT_B,
        admissionId: ADMISSION_B,
        prescriberMembershipId: membershipB,
        status: "active",
        activatedAt: "2024-01-01T12:00:00Z",
        frequencyCode: "bid",
        asNeeded: false,
      });
      const doseIdB = "ffffffff-0000-4000-8000-0000000000b1";
      await insertDose({
        id: doseIdB,
        organizationId: ORG_B,
        providerEntityId: providerB,
        locationId: locationB,
        patientId: PATIENT_B,
        admissionId: ADMISSION_B,
        medicationOrderId: orderIdB,
        dueAt: "2099-01-01T08:00:00Z",
        status: "pending",
      });

      // Org A cannot even resolve org B's order — the seam scopes by organizationId.
      await expect(
        materialize.handle({
          id: "eeeeeeee-0000-4000-8000-000000000007",
          organizationId: ORG_A,
          payload: { orderId: orderIdB, fullDto: null },
        }),
      ).rejects.toThrow(/no M12 order/);

      expect(await doseRows(ORG_B, orderIdB)).toHaveLength(1); // org B's dose is untouched
      const rows = await doseRows(ORG_B, orderIdB);
      expect(rows[0].status).toBe("pending");
    });
  },
);
