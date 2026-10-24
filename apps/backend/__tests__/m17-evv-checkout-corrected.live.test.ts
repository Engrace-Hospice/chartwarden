/**
 * F-133 follow-up (#248) — LIVE Postgres proof that M17's two remaining `m18.evv.*` provenance-pointer
 * consumers actually write real `visit` rows under RLS:
 *   - `buildM17EvvCheckOutConsumer` (`m18.evv.check_out_recorded` → stamps `evv_check_out_event_id` only,
 *     deliberately NO lifecycle transition — see the consumer file's header for why)
 *   - `buildM17EvvEventCorrectedConsumer` (`m18.evv.event_corrected` → repoints whichever of
 *     `evv_check_in_event_id`/`evv_check_out_event_id` names the superseded event)
 *
 * Both sat in `scripts/outbox-deferred-consumers.ts`'s m17 `handlers-unbound` group with no handler ever
 * built. Mirrors the seeding/role-switch shape of `m17-evv-sos-consumers.live.test.ts`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m17:evv-checkout-corrected:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM17EvvCheckOutConsumer } from "../src/modules/17-scheduling/outbox-consumers/m18-evv-check-out";
import { buildM17EvvEventCorrectedConsumer } from "../src/modules/17-scheduling/outbox-consumers/m18-evv-event-corrected";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-133 follow-up — M17's EVV checkout/correction pointer consumers — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let peA: string;
    let locA: string;
    let memA: string;
    let peB: string;
    let locB: string;
    let memB: string;
    let visitSeedCounter = 0;
    let checkOutConsumer: ReturnType<typeof buildM17EvvCheckOutConsumer>;
    let correctedConsumer: ReturnType<typeof buildM17EvvEventCorrectedConsumer>;

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

    async function seedOrgFixture(orgId: string, slug: string) {
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)`,
        [orgId, `org-${slug}`, slug],
      );
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [orgId, `M17X-${slug}`, `Provider ${slug}`, slug === "a" ? "1300000001" : "1300000002"],
        )
      ).rows[0].id as string;
      const loc = (
        await admin.query(
          `INSERT INTO location
             (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Main','1 Main St','Portland','OR','97201','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m17-evv-checkout-corrected-${slug}@x.test`,
        ])
      ).rows[0].id as string;
      const mem = (
        await admin.query(
          `INSERT INTO membership
             (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [user, orgId, pe, JSON.stringify([loc])],
        )
      ).rows[0].id as string;
      return { pe, loc, mem };
    }

    async function seedVisit(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      assignedMembershipId: string;
      status: "published" | "en_route" | "in_visit";
      evvCheckInEventId?: string | null;
      evvCheckOutEventId?: string | null;
    }): Promise<string> {
      const patientId = crypto.randomUUID();
      const admissionId = crypto.randomUUID();
      const offsetHours = visitSeedCounter++;
      const row = await admin.query(
        `INSERT INTO visit
           (organization_id, provider_entity_id, location_id, patient_id, admission_id,
            assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
            scheduled_started_at, scheduled_ended_at, service_date, status,
            evv_check_in_event_id, evv_check_out_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
                 now() + ($9 || ' hours')::interval, now() + ($9 || ' hours')::interval + interval '1 hour',
                 CURRENT_DATE, $7, $8, $10)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          patientId,
          admissionId,
          opts.assignedMembershipId,
          opts.status,
          opts.evvCheckInEventId ?? null,
          String(offsetHours * 2),
          opts.evvCheckOutEventId ?? null,
        ],
      );
      return row.rows[0].id as string;
    }

    async function visitRow(visitId: string) {
      const { rows } = await admin.query(
        `SELECT status, version, evv_check_in_event_id, evv_check_out_event_id
         FROM visit WHERE id = $1`,
        [visitId],
      );
      return rows[0];
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      const a = await seedOrgFixture(ORG_A, "a");
      peA = a.pe;
      locA = a.loc;
      memA = a.mem;
      const b = await seedOrgFixture(ORG_B, "b");
      peB = b.pe;
      locB = b.loc;
      memB = b.mem;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      checkOutConsumer = buildM17EvvCheckOutConsumer({ db: handle.db });
      correctedConsumer = buildM17EvvEventCorrectedConsumer({ db: handle.db });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("check-out stamps the pointer without changing status/version/history", async () => {
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "in_visit",
      });
      const eventId = crypto.randomUUID();

      await checkOutConsumer.handle({
        organizationId: ORG_A,
        payload: {
          eventId,
          visitId,
          patientId: "irrelevant",
          postingMembershipId: "irrelevant",
          capturedAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          gpsQuality: "good",
          geofenceDecision: "inside_geofence",
          pairedCheckInEventId: null,
          serviceDurationMinutes: 45,
        },
      });

      const row = await visitRow(visitId);
      expect(row.status).toBe("in_visit"); // deliberately unchanged — no lifecycle transition
      expect(row.version).toBe(0);
      expect(row.evv_check_out_event_id).toBe(eventId);

      // Redelivery must not overwrite an already-set pointer.
      const secondEventId = crypto.randomUUID();
      await checkOutConsumer.handle({
        organizationId: ORG_A,
        payload: {
          eventId: secondEventId,
          visitId,
          patientId: "irrelevant",
          postingMembershipId: "irrelevant",
          capturedAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          gpsQuality: "good",
          geofenceDecision: "inside_geofence",
          pairedCheckInEventId: null,
          serviceDurationMinutes: 45,
        },
      });
      expect((await visitRow(visitId)).evv_check_out_event_id).toBe(eventId);
    });

    it("check-out is a no-op across tenants", async () => {
      const orgBVisit = await seedVisit({
        organizationId: ORG_B,
        providerEntityId: peB,
        locationId: locB,
        assignedMembershipId: memB,
        status: "in_visit",
      });
      await checkOutConsumer.handle({
        organizationId: ORG_A,
        payload: {
          eventId: crypto.randomUUID(),
          visitId: orgBVisit,
          patientId: "irrelevant",
          postingMembershipId: "irrelevant",
          capturedAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          gpsQuality: "good",
          geofenceDecision: "inside_geofence",
          pairedCheckInEventId: null,
          serviceDurationMinutes: 45,
        },
      });
      expect((await visitRow(orgBVisit)).evv_check_out_event_id).toBeNull();
    });

    it("event-corrected repoints a superseded check-in pointer", async () => {
      const supersededEventId = crypto.randomUUID();
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "en_route",
        evvCheckInEventId: supersededEventId,
      });
      const newEventId = crypto.randomUUID();

      await correctedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          supersededEventId,
          newEventId,
          visitId,
          correctedByMembershipId: memA,
          correctionReason: "GPS accuracy was manually re-verified against the geocoded address.",
        },
      });

      const row = await visitRow(visitId);
      expect(row.evv_check_in_event_id).toBe(newEventId);
      expect(row.status).toBe("en_route"); // deliberately unchanged

      // Redelivery is a no-op — the superseded id no longer matches either column.
      await correctedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          supersededEventId,
          newEventId: crypto.randomUUID(),
          visitId,
          correctedByMembershipId: memA,
          correctionReason: "A second, later correction attempt against the same superseded id.",
        },
      });
      expect((await visitRow(visitId)).evv_check_in_event_id).toBe(newEventId);
    });

    it("event-corrected repoints a superseded check-out pointer, never touching check-in", async () => {
      const supersededEventId = crypto.randomUUID();
      const checkInEventId = crypto.randomUUID();
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "in_visit",
        evvCheckInEventId: checkInEventId,
        evvCheckOutEventId: supersededEventId,
      });
      const newEventId = crypto.randomUUID();

      await correctedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          supersededEventId,
          newEventId,
          visitId,
          correctedByMembershipId: memA,
          correctionReason:
            "Checkout GPS point was corrected after supervisor review of the raw fix.",
        },
      });

      const row = await visitRow(visitId);
      expect(row.evv_check_out_event_id).toBe(newEventId);
      expect(row.evv_check_in_event_id).toBe(checkInEventId); // untouched
    });

    it("event-corrected is a no-op when the superseded id names neither pointer or another org", async () => {
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "en_route",
        evvCheckInEventId: crypto.randomUUID(),
      });
      await correctedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          supersededEventId: crypto.randomUUID(), // matches nothing on this visit
          newEventId: crypto.randomUUID(),
          visitId,
          correctedByMembershipId: memA,
          correctionReason: "This correction should match nothing on the seeded visit.",
        },
      });
      const before = await visitRow(visitId);

      const orgBVisit = await seedVisit({
        organizationId: ORG_B,
        providerEntityId: peB,
        locationId: locB,
        assignedMembershipId: memB,
        status: "en_route",
        evvCheckInEventId: "33333333-3333-3333-3333-333333333333",
      });
      await correctedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          supersededEventId: "33333333-3333-3333-3333-333333333333",
          newEventId: crypto.randomUUID(),
          visitId: orgBVisit,
          correctedByMembershipId: memA,
          correctionReason: "Org A must not be able to correct org B's visit pointer.",
        },
      });

      expect(await visitRow(visitId)).toMatchObject(before);
      expect((await visitRow(orgBVisit)).evv_check_in_event_id).toBe(
        "33333333-3333-3333-3333-333333333333",
      );
    });
  },
);
