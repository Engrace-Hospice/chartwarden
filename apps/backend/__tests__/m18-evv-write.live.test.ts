/**
 * M18L — the Drizzle EVV write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role. M18 has NO state-transition triggers (only the M4
 * audit + the `evv_event` append-only trigger), so the service performs every capture/device/policy/resolution/
 * submission transition itself, composing the pure `domain/*` machines: capture (INSERT `evv_event` +
 * `evv_geofence_evaluation`), device self-register + approve/suspend, geofence tenant-tighten + per-address
 * override, the §2.2.4 D6 missing-resolution machine (clinician-attest / supervisor-override), and the §2.2.5 D7
 * aggregator-submission machine (resubmit / cancel). Like the M7–M17 write suites it binds the REAL catalog-
 * validating transactional publisher (buildBootOutboxCatalog([M18_OUTBOX_EVENTS]) → the caller's tx) and asserts
 * the `m18.evv.*` rows land in `outbox_event`. RLS is exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m18:write:live
 * `evv_event` is RANGE-partitioned → the throwaway superuser DB needs `max_locks_per_transaction` raised. For a
 * local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type EvvWriteOutboxPort,
  M18_OUTBOX_EVENTS,
  buildM18VisitPublishedConsumer,
  createDbEvvBackend,
} from "../src/modules/18-evv/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type Seed = { pe: string; location: string; member: string; device: string };

describe.skipIf(!DB_URL)("M18 EVV write lifecycle — LIVE Postgres (M18L)", () => {
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
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  /** Seed a real M17 visit (capture siting resolves from it). `member` is its assigned clinician. Status is
   * 'proposed' (outside the D6 per-clinician overlap EXCLUDE set) so many visits can share the `now()` window. */
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
    // GAP-086 — an M17 `visit` row alone is NOT enough any more, and this suite predates that: the capture
    // path resolves siting from M18's OWN `evv_visit_registration` snapshot, which the M17 publication
    // consumer populates. Without it every capture 404s on "visit not found". Drive the REAL consumer
    // rather than hand-inserting the snapshot, so the seam itself is under test too.
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
  async function seedOpenResolution(org: string, visitId: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO evv_missing_resolution (organization_id, visit_id, kind, detected_by_source)
         VALUES ($1,$2,'missing_checkout','cron_late_check_sweep') RETURNING id`,
        [org, visitId],
      )
    ).rows[0].id as string;
  }
  async function seedSubmission(org: string, visitId: string, status: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO evv_aggregator_submission (organization_id, visit_id, state_code, aggregator_vendor, status, attempt_count)
         VALUES ($1,$2,'WI','sandata',$3,1) RETURNING id`,
        [org, visitId, status],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m18w-${n++}@x.test`,
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
            `CCN-M18W-${org.slice(0, 4)}`,
            `M18W ${org.slice(0, 4)}`,
            `NPI-M18W-${org.slice(0, 4)}`,
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
      // An APPROVED device for `member` (capture resolves the posting membership's approved device).
      const device = (
        await admin.query(
          `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
             m2_device_attestation_id, status, approved_at)
           VALUES ($1,$2,'ios',$3,$4,'approved', now()) RETURNING id`,
          [org, member, `fp-M18W-${n}`, "66666666-6666-6666-6666-666666666666"],
        )
      ).rows[0].id as string;
      // The active tenant geofence policy (radius 150 / max-accuracy 50).
      await admin.query(
        `INSERT INTO evv_geofence_policy (organization_id, scope, radius_m, max_accuracy_m, effective_from, set_by_membership_id)
         VALUES ($1,'tenant',150,50, now()::date, $2)`,
        [org, member],
      );
      seeded[org] = { pe, location, member, device };
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M18_OUTBOX_EVENTS]));
    const outbox: EvvWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m18" }),
    };
    svc = createDbEvvBackend(handle.db, outbox);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("device self-register → approve; emits device_pending_approval + device_approved", async () => {
    const { member } = seeded[ORG_A];
    const dev = await svc.selfRegisterDevice(ORG_A, member, {
      platform: "android",
      modelDescription: "Pixel 8",
    });
    expect(dev.status).toBe("pending_approval");
    expect(await eventsFor(dev.id)).toContain("m18.evv.device_pending_approval");
    const approved = await svc.approveDevice(ORG_A, dev.id);
    expect(approved.status).toBe("approved");
    expect(await eventsFor(dev.id)).toContain("m18.evv.device_approved");
  });

  it("capture check-in (in-geofence) then check-out completes the bracket; emits check_*_recorded", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const ci = await svc.recordCapture(ORG_A, member, "check_in", {
      visitId: visit,
      coords: { lat: 45.523, lng: -122.6789 },
      accuracyM: 4.5,
      capturedAt: new Date().toISOString(),
    });
    expect(ci.geofenceDecision).toBe("pass");
    expect(ci.gpsQuality).toBe("high");
    expect(ci.visitStateAfterEvent).toBe("in_visit");
    const ciEvts = await eventsFor(ci.eventId);
    expect(ciEvts).toContain("m18.evv.check_in_recorded");
    expect(ciEvts).toContain("m18.evv.at_patient_address");

    const co = await svc.recordCapture(ORG_A, member, "check_out", {
      visitId: visit,
      coords: { lat: 45.523, lng: -122.6789 },
      accuracyM: 6,
      capturedAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    expect(co.visitStateAfterEvent).toBe("completed");
    expect(await eventsFor(co.eventId)).toContain("m18.evv.check_out_recorded");

    // §4.3 the event projection is coordinate-free; the bracket is present.
    const bracket = await svc.bracketForVisit(ORG_A, visit);
    expect(bracket.bracketState).toBe("present");
    expect("coordsCipher" in (bracket.checkInEvent ?? {})).toBe(false);
  });

  it("capture with accuracy beyond the policy (unattested) is an outside-geofence breach", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const ci = await svc.recordCapture(ORG_A, member, "check_in", {
      visitId: visit,
      coords: { lat: 45.5, lng: -122.6 },
      accuracyM: 80, // > max_accuracy_m 50
      capturedAt: new Date().toISOString(),
    });
    expect(ci.geofenceDecision).toBe("fail_accuracy");
    expect(ci.gpsQuality).toBe("outside_geofence");
    expect(await eventsFor(ci.eventId)).toContain("m18.evv.geofence_breach_recorded");
  });

  it("capture without an approved device is refused (422)", async () => {
    // A membership with no approved device (org B's member has one; use a bare literal membership via org A's
    // visit but a device-less posting membership).
    const visit = await seedVisit(ORG_A);
    const bareUser = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('m18w-bare@x.test') RETURNING id`)
    ).rows[0].id as string;
    const bare = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [bareUser, ORG_A],
      )
    ).rows[0].id as string;
    await expect(
      svc.recordCapture(ORG_A, bare, "check_in", {
        visitId: visit,
        coords: { lat: 45.5, lng: -122.6 },
        accuracyM: 4.5,
        capturedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("missing-resolution clinician-attest closes the open row; emits late_check_resolved", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const mr = await seedOpenResolution(ORG_A, visit);
    const closed = await svc.clinicianAttestResolution(
      ORG_A,
      member,
      mr,
      "clinician self-attests the visit occurred; checkout device battery died mid-visit",
    );
    expect(closed.status).toBe("closed_clinician_attested");
    expect(closed.resolvedByMembershipId).toBe(member);
    expect(await eventsFor(mr)).toContain("m18.evv.late_check_resolved");
  });

  it("missing-resolution supervisor-override (step-up) closes the open row", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const mr = await seedOpenResolution(ORG_A, visit);
    const closed = await svc.supervisorOverrideResolution(
      ORG_A,
      member,
      mr,
      "supervisor override after reviewing the encounter note and confirming the visit with the patient family",
      true,
    );
    expect(closed.status).toBe("closed_supervisor_override");
    // Without a fresh step-up the machine refuses.
    const mr2 = await seedOpenResolution(ORG_A, await seedVisit(ORG_A));
    await expect(
      svc.supervisorOverrideResolution(ORG_A, member, mr2, "x".repeat(60), false),
    ).rejects.toMatchObject({ code: "EVV_SUPERVISOR_OVERRIDE_STEP_UP_REQUIRED" });
  });

  it("aggregator resubmit (rejected→queued, attempt++) then cancel (→cancelled); emits aggregator_cancelled", async () => {
    const { member: _m } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const rejected = await seedSubmission(ORG_A, visit, "rejected");
    const requeued = await svc.resubmitSubmission(ORG_A, seeded[ORG_A].member, rejected);
    expect(requeued.status).toBe("queued");
    expect(requeued.attemptCount).toBe(2);

    const cancelled = await svc.cancelSubmission(ORG_A, seeded[ORG_A].member, requeued.id);
    expect(cancelled.status).toBe("cancelled");
    expect(await eventsFor(rejected)).toContain("m18.evv.aggregator_cancelled");
  });

  it("editTenantPolicy tightens (allowed) and refuses to loosen beyond the floor; per-address override persists", async () => {
    const tightened = await svc.editTenantPolicy(ORG_A, { radiusM: 80, maxAccuracyM: 30 });
    expect(tightened.tenant).toEqual({ radiusM: 80, maxAccuracyM: 30 });
    await expect(
      svc.editTenantPolicy(ORG_A, { radiusM: 250, maxAccuracyM: 30 }),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    const withOverride = await svc.createPerAddressOverride(ORG_A, {
      patientAddressId: "77777777-7777-7777-7777-777777777777",
      radiusM: 60,
      maxAccuracyM: 20,
    });
    expect(
      withOverride.perAddress.some(
        (p) => p.patientAddressId === "77777777-7777-7777-7777-777777777777",
      ),
    ).toBe(true);
  });

  it("RLS: org B cannot capture against org A's visit (visit invisible → 404)", async () => {
    const visit = await seedVisit(ORG_A);
    await expect(
      svc.recordCapture(ORG_B, seeded[ORG_B].member, "check_in", {
        visitId: visit,
        coords: { lat: 45.5, lng: -122.6 },
        accuracyM: 4.5,
        capturedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
