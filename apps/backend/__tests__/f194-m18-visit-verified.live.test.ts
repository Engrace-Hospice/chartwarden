/**
 * F-194 (#248) — LIVE Postgres proof of the `m18.evv.visit_verified` → M30 `hvldl` recompute path, end to
 * end: a real check-in then check-out through M18's real Drizzle write service (the real catalog-validating
 * outbox publisher, `outbox_event` rows asserted directly), then the real `m18.evv.visit_verified` payload
 * fed into `buildM30VisitVerifiedConsumer` (M18's `evvVisitProviderEntityForOrg` seam wired as a real port),
 * asserting a real `measure_recompute_queue` row lands.
 *
 * Before this round: `recordEvent` (the pure decider) declared the `visit_verified` outbox effect, but the
 * real write path never called it — check-out only ever emitted `check_out_recorded`/`geofence_breach_recorded`.
 * M30's own `hvldl_near_death_recompute` effect and pure handler (`handleEvvVisitVerified`) existed too, also
 * unwired (no `OutboxConsumerBinding` bound it at boot). This proves BOTH halves now work, for real, together.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f194:m18-visit-verified:live
 * `evv_event` is RANGE-partitioned → the throwaway superuser DB needs `max_locks_per_transaction` raised. For
 * a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type EvvWriteOutboxPort,
  M18_OUTBOX_EVENTS,
  buildM18VisitPublishedConsumer,
  createDbEvvBackend,
  systemCapture,
} from "../src/modules/18-evv/index";

// GAP-055 — these fixtures drive M18 state through the service, not the capture guards (covered in
// evv-capture-guards.test.ts / evv-inject.test.ts); the explicit typed system marker says so.
const SYSTEM_FIXTURE = systemCapture("live-suite fixture");
import { evvVisitProviderEntityForOrg } from "../src/modules/18-evv/seams/evv-visit-provider-entity-for-org";
import { buildM30VisitVerifiedConsumer } from "../src/modules/30-quality/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { createTestEvvCoordsCipher } from "./_m18-coords-test-cipher";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type Seed = { pe: string; location: string; member: string };

describe.skipIf(!DB_URL)(
  "F-194 — m18.evv.visit_verified → M30 hvldl recompute — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbEvvBackend>;
    const seeded: Record<string, Seed> = {};

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
    async function eventsFor(aggregateId: string): Promise<{ type: string; payload: unknown }[]> {
      const { rows } = await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
        [aggregateId],
      );
      return rows.map((r) => ({ type: r.event_type as string, payload: r.payload }));
    }

    async function seedVisit(org: string): Promise<string> {
      const s = seeded[org];
      const started = new Date();
      const ended = new Date(started.getTime() + 60 * 60_000);
      const visitId = (
        await admin.query(
          `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
           scheduled_started_at, scheduled_ended_at, service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
           $7, $8, now()::date, 'proposed') RETURNING id`,
          [org, s.pe, s.location, PATIENT, ADMISSION, s.member, started, ended],
        )
      ).rows[0].id as string;
      // The capture path resolves siting from M18's OWN `evv_visit_registration` snapshot, which the M17
      // publication consumer populates (GAP-086, the `m18-evv-write.live.test.ts` precedent) — this ALSO
      // seeds the exact row `evvVisitProviderEntityForOrg` reads.
      await buildM18VisitPublishedConsumer({ db: handle.db }).handle({
        id: crypto.randomUUID(),
        organizationId: org,
        payload: {
          organizationId: org,
          visitId,
          providerEntityId: s.pe,
          locationId: s.location,
          patientId: PATIENT,
          admissionId: ADMISSION,
          assignedMembershipId: s.member,
          assignedDiscipline: "rn",
          visitPurpose: "routine_visit",
          patientAddressId: null,
          externalFacilityId: null,
          scheduledStartedAt: started.toISOString(),
          scheduledEndedAt: ended.toISOString(),
        },
      });
      return visitId;
    }

    async function seedOpenResolution(org: string, visitId: string): Promise<void> {
      await admin.query(
        `INSERT INTO evv_missing_resolution (organization_id, visit_id, kind, detected_by_source)
       VALUES ($1,$2,'missing_checkout','cron_late_check_sweep')`,
        [org, visitId],
      );
    }

    async function recomputeRows(org: string) {
      const { rows } = await admin.query(
        `SELECT measure_code, provider_entity_id, organization_id, requires_recompute, triggering_event_outbox_id
       FROM measure_recompute_queue WHERE organization_id = $1 AND measure_code = 'hvldl'`,
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
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'f194-org-a','A','A'),($2,'f194-org-b','B','B')",
        [ORG_A, ORG_B],
      );
      let n = 0;
      for (const org of [ORG_A, ORG_B]) {
        const user = (
          await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
            `f194-${n++}@x.test`,
          ])
        ).rows[0].id as string;
        const member = (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
            [user, org],
          )
        ).rows[0].id as string;
        const pe = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
            [
              org,
              `CCN-F194-${org.slice(0, 4)}`,
              `F194 ${org.slice(0, 4)}`,
              `NPI-F194-${org.slice(0, 4)}`,
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
          `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
           m2_device_attestation_id, status, approved_at)
         VALUES ($1,$2,'ios',$3,$4,'approved', now())`,
          [org, member, `fp-F194-${n}`, "66666666-6666-6666-6666-666666666666"],
        );
        await admin.query(
          `INSERT INTO evv_geofence_policy (organization_id, scope, radius_m, max_accuracy_m, effective_from, set_by_membership_id)
         VALUES ($1,'tenant',150,50, now()::date, $2)`,
          [org, member],
        );
        seeded[org] = { pe, location, member };
      }
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M18_OUTBOX_EVENTS]));
      const outbox: EvvWriteOutboxPort = {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m18" }),
      };
      // GAP-054 — the geofence baseline is the address coordinate; pin it to the capture coordinate used below.
      svc = createDbEvvBackend(handle.db, outbox, {
        coordsCipher: createTestEvvCoordsCipher(), // GAP-133 — the §D10 envelope
        addressCoordinate: async () => ({ lat: 45.523, lng: -122.6789 }),
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("in-geofence check-in then check-out emits visit_verified, and the real M30 consumer enqueues one hvldl recompute (redelivery does not duplicate it)", async () => {
      const { member, pe } = seeded[ORG_A];
      const visit = await seedVisit(ORG_A);
      await svc.recordCapture(
        ORG_A,
        member,
        "check_in",
        {
          visitId: visit,
          coords: { lat: 45.523, lng: -122.6789 },
          accuracyM: 4.5,
          capturedAt: new Date().toISOString(),
        },
        SYSTEM_FIXTURE,
      );
      const co = await svc.recordCapture(
        ORG_A,
        member,
        "check_out",
        {
          visitId: visit,
          coords: { lat: 45.523, lng: -122.6789 },
          accuracyM: 6,
          capturedAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        SYSTEM_FIXTURE,
      );

      const evts = await eventsFor(co.eventId);
      const verified = evts.find((e) => e.type === "m18.evv.visit_verified");
      expect(verified).toBeDefined();
      expect(verified?.payload).toMatchObject({
        visitId: visit,
        patientId: PATIENT,
        organizationId: ORG_A,
      });

      const consumer = buildM30VisitVerifiedConsumer({
        db: handle.db,
        evvVisitProviderEntityForOrg,
      });
      const event = {
        id: co.eventId,
        organizationId: ORG_A,
        eventType: "m18.evv.visit_verified",
        aggregateKind: "evv_event",
        aggregateId: co.eventId,
        attemptCount: 0,
        createdAt: new Date(),
        payload: verified?.payload,
      };
      await consumer.handle(event);
      await consumer.handle(event); // redelivery — must debounce onto the same pending row, not duplicate

      const rows = await recomputeRows(ORG_A);
      expect(rows).toHaveLength(1);
      expect(rows[0].provider_entity_id).toBe(pe);
      expect(rows[0].requires_recompute).toBe(true);
      expect(rows[0].triggering_event_outbox_id).toBe(co.eventId);
    });

    it("a geofence-breach (fail-accuracy) check-out does NOT emit visit_verified", async () => {
      const { member } = seeded[ORG_A];
      const visit = await seedVisit(ORG_A);
      await svc.recordCapture(
        ORG_A,
        member,
        "check_in",
        {
          visitId: visit,
          coords: { lat: 45.523, lng: -122.6789 },
          accuracyM: 4.5,
          capturedAt: new Date().toISOString(),
        },
        SYSTEM_FIXTURE,
      );
      // Within the radius, so the breach here comes from accuracy worse than the policy's ceiling, un-attested.
      const co = await svc.recordCapture(
        ORG_A,
        member,
        "check_out",
        {
          visitId: visit,
          coords: { lat: 45.523, lng: -122.6789 },
          accuracyM: 999,
          capturedAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        SYSTEM_FIXTURE,
      );
      expect(co.geofenceDecision).not.toBe("pass");
      const evts = await eventsFor(co.eventId);
      expect(evts.some((e) => e.type === "m18.evv.visit_verified")).toBe(false);
      expect(evts.some((e) => e.type === "m18.evv.geofence_breach_recorded")).toBe(true);
    });

    it("an in-geofence check-out with a still-OPEN evv_missing_resolution on the visit does NOT emit visit_verified", async () => {
      const { member } = seeded[ORG_A];
      const visit = await seedVisit(ORG_A);
      await svc.recordCapture(
        ORG_A,
        member,
        "check_in",
        {
          visitId: visit,
          coords: { lat: 45.523, lng: -122.6789 },
          accuracyM: 4.5,
          capturedAt: new Date().toISOString(),
        },
        SYSTEM_FIXTURE,
      );
      await seedOpenResolution(ORG_A, visit);
      const co = await svc.recordCapture(
        ORG_A,
        member,
        "check_out",
        {
          visitId: visit,
          coords: { lat: 45.523, lng: -122.6789 },
          accuracyM: 6,
          capturedAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        SYSTEM_FIXTURE,
      );
      expect(co.geofenceDecision).toBe("pass");
      const evts = await eventsFor(co.eventId);
      expect(evts.some((e) => e.type === "m18.evv.visit_verified")).toBe(false);
    });

    it("a visitId this org does not recognise (cross-tenant / stale redelivery) is a silent no-op for the M30 consumer", async () => {
      const consumer = buildM30VisitVerifiedConsumer({
        db: handle.db,
        evvVisitProviderEntityForOrg,
      });
      const event = {
        id: "99999999-9999-4999-8999-999999999999",
        organizationId: ORG_B,
        eventType: "m18.evv.visit_verified",
        aggregateKind: "evv_event",
        aggregateId: "88888888-8888-4888-8888-888888888888",
        attemptCount: 0,
        createdAt: new Date(),
        payload: {
          visitId: "77777777-7777-4777-8777-777777777777", // never registered under ORG_B
          patientId: PATIENT,
          organizationId: ORG_B,
          verifiedAt: new Date().toISOString(),
        },
      };
      await expect(consumer.handle(event)).resolves.toBeUndefined();
      const rows = await recomputeRows(ORG_B);
      expect(rows).toHaveLength(0);
    });
  },
);
