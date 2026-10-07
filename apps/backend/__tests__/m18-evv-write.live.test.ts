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
import { runWithRequestContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type EvvCoordsFault,
  EvvCoordsKeyUnboundError,
  type EvvWriteOutboxPort,
  M18_OUTBOX_EVENTS,
  buildM18VisitPublishedConsumer,
  clinicianCapture,
  createDbEvvBackend,
  createDrizzleEvvSeamStore,
  systemCapture,
} from "../src/modules/18-evv/index";

// GAP-055 — these fixtures drive M18 state through the service, not the capture guards (covered in
// evv-capture-guards.test.ts / evv-inject.test.ts); the explicit typed system marker says so.
const SYSTEM_FIXTURE = systemCapture("live-suite fixture");
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { TEST_COORDS_DEK_VERSION, createTestEvvCoordsCipher } from "./_m18-coords-test-cipher";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
/** The patient-address coordinate every in-geofence capture below is taken at (GAP-054). */
const ADDRESS_BASELINE = { lat: 45.523, lng: -122.6789 };
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type Seed = { pe: string; location: string; member: string; device: string };

describe.skipIf(!DB_URL)("M18 EVV write lifecycle — LIVE Postgres (M18L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEvvBackend>;
  const coordsFaults: EvvCoordsFault[] = [];
  // Same DB, default (OFF) device-attestation flag — the production configuration.
  let svcAttestationOff: ReturnType<typeof createDbEvvBackend>;
  let svcNoBaseline: ReturnType<typeof createDbEvvBackend>;
  // GAP-133 — no coordinate cipher bound: the production fail-closed default.
  let svcUnbound: ReturnType<typeof createDbEvvBackend>;
  // GAP-133 — the §D10 envelope (production code) over an in-memory per-tenant DEK ring.
  const coordsCipher = createTestEvvCoordsCipher();
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
    // The enforced contract (attestation + session-device binding) is what most of this suite proves.
    // GAP-054 — the geofence baseline is the patient-address coordinate (a seam in prod); pinned here.
    const addressCoordinate = async () => ADDRESS_BASELINE;
    svc = createDbEvvBackend(handle.db, outbox, {
      onCoordsFault: (f) => coordsFaults.push(f),
      deviceAttestationEnforced: true,
      addressCoordinate,
      coordsCipher,
    });
    svcAttestationOff = createDbEvvBackend(handle.db, outbox, { addressCoordinate, coordsCipher });
    svcNoBaseline = createDbEvvBackend(handle.db, outbox, {
      addressCoordinate: async () => null,
      coordsCipher,
    });
    svcUnbound = createDbEvvBackend(handle.db, outbox, { addressCoordinate });
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
    const approved = await svc.approveDevice(ORG_A, member, dev.id);
    expect(approved.status).toBe("approved");
    expect(await eventsFor(dev.id)).toContain("m18.evv.device_approved");
  });

  it("capture check-in (in-geofence) then check-out completes the bracket; emits check_*_recorded", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const ci = await svc.recordCapture(
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
    expect(ci.geofenceDecision).toBe("pass");
    expect(ci.gpsQuality).toBe("high");
    expect(ci.visitStateAfterEvent).toBe("in_visit");
    const ciEvts = await eventsFor(ci.eventId);
    expect(ciEvts).toContain("m18.evv.check_in_recorded");
    expect(ciEvts).toContain("m18.evv.at_patient_address");

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
    expect(co.visitStateAfterEvent).toBe("completed");
    expect(await eventsFor(co.eventId)).toContain("m18.evv.check_out_recorded");

    // §4.3 the event projection is coordinate-free; the bracket is present.
    const bracket = await svc.bracketForVisit(ORG_A, visit);
    expect(bracket.bracketState).toBe("present");
    expect("coordsCipher" in (bracket.checkInEvent ?? {})).toBe(false);

    // GAP-032 — the coordinate-bearing read recovers what the capture actually stored. This returned a
    // hardcoded (0, 0) for every clinician in every tenant, and `lat`/`lng` were non-nullable, so no
    // caller could tell that from a real coordinate. The last-known row is the check-OUT (newest first).
    const located = await svc.clinicianCurrentLocation(ORG_A, member);
    const mine = located.find((l) => l.membershipId === member);
    expect(mine?.lat).toBeCloseTo(45.523, 6);
    expect(mine?.lng).toBeCloseTo(-122.6789, 6);
    expect(mine?.eventId).toBe(co.eventId);

    // GAP-133 — and what it stored is CIPHERTEXT: the §D10 envelope, not `base64("lat,lng")`; the stamped
    // DEK version is the key ring's, not a constant `1`; the geofence snapshot carries the same envelope.
    const atRest = (
      await admin.query(
        `SELECT e.coords_cipher, e.coords_dek_version, g.device_coords_cipher
           FROM evv_event e JOIN evv_geofence_evaluation g ON g.evv_event_id = e.id
          WHERE e.id = $1`,
        [ci.eventId],
      )
    ).rows[0];
    expect(atRest.coords_cipher).toMatch(/^v1\./);
    expect(atRest.coords_cipher).not.toContain("45.523");
    expect(atRest.coords_cipher).not.toBe(Buffer.from("45.523,-122.6789").toString("base64"));
    expect(Buffer.from(atRest.coords_cipher, "base64").toString("utf8")).not.toContain("45.523");
    expect(atRest.coords_dek_version).toBe(TEST_COORDS_DEK_VERSION);
    expect(atRest.device_coords_cipher).toBe(atRest.coords_cipher);
    expect(await coordsCipher.open(ORG_A, atRest.coords_cipher)).toEqual({
      lat: 45.523,
      lng: -122.6789,
    });
    // AAD binds the tenant: the same blob does not open as ORG_B's.
    await expect(coordsCipher.open(ORG_B, atRest.coords_cipher)).rejects.toThrow();

    // The M20-facing `EvvLocationProvider` seam store opens the same envelope (request-scoped org).
    const store = createDrizzleEvvSeamStore(handle.db, { coordsCipher });
    const seen = await runWithRequestContext({ organizationId: ORG_A, userId: member }, () =>
      store.lastKnownLocationForClinician(member),
    );
    expect(seen?.eventId).toBe(co.eventId);
    expect(seen?.lat).toBeCloseTo(45.523, 6);
    expect(seen?.lng).toBeCloseTo(-122.6789, 6);
    // …and with no key bound it refuses rather than answering a coordinate it cannot authenticate.
    await expect(
      runWithRequestContext({ organizationId: ORG_A, userId: member }, () =>
        createDrizzleEvvSeamStore(handle.db).lastKnownLocationForClinician(member),
      ),
    ).rejects.toBeInstanceOf(EvvCoordsKeyUnboundError);
  });

  it("GAP-133 — with no coordinate key bound the capture is REFUSED and nothing is written", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    await expect(
      svcUnbound.recordCapture(
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
      ),
    ).rejects.toBeInstanceOf(EvvCoordsKeyUnboundError);
    const written = await admin.query(
      "SELECT count(*)::int AS n FROM evv_event WHERE visit_id = $1",
      [visit],
    );
    expect(written.rows[0].n).toBe(0);
  });

  it("clinician-current-location reports lat/lng NULL when the stored coordinate is unreadable", async () => {
    const s = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    // GAP-133 — a LEGACY row: not a §D10 envelope (pre-GAP-133 base64 or any other non-envelope payload),
    // stamped with the sentinel migration 0491 gives such rows. It reads as "unavailable", never decoded.
    // INSERTED raw rather than UPDATEd over a captured row: `evv_event` carries an append-only
    // immutability trigger (EVV_EVENT_APPEND_ONLY_IMMUTABLE_COLUMN) that refuses to let `coords_cipher`
    // change in place, which is a guard worth leaving intact — so the bad payload arrives at INSERT.
    const device = (
      await admin.query(
        "SELECT id, m2_device_attestation_id FROM evv_device WHERE membership_id = $1 AND status = 'approved' LIMIT 1",
        [s.member],
      )
    ).rows[0];
    const eventId = (
      await admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id,
           patient_address_id, kind, service_type_code, posting_membership_id,
           posting_discipline_at_recording, evv_device_id, captured_at, event_at, coords_cipher,
           coords_dek_version, accuracy_m, gps_quality, device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,$6,'check_in','',$7,'',$8,
                 now() + interval '1 hour', now() + interval '1 hour',
                 'not-decodable','legacy-unencrypted',5,'high',$9)
         RETURNING id`,
        [
          ORG_A,
          s.pe,
          s.location,
          visit,
          PATIENT,
          null,
          s.member,
          device.id,
          device.m2_device_attestation_id,
        ],
      )
    ).rows[0].id as string;

    // The read collapses to ONE row per clinician (their newest sighting), which is why the row above is
    // stamped an hour ahead — otherwise an earlier test's capture would still be this member's latest.
    const located = await svc.clinicianCurrentLocation(ORG_A, s.member);
    const mine = located.find((l) => l.membershipId === s.member);
    expect(mine?.eventId).toBe(eventId);
    // "Unavailable", not a substituted coordinate — the whole reason the DTO became nullable instead of
    // keeping zero as a de-facto sentinel (0,0 is a real place).
    expect(mine?.lat).toBeNull();
    expect(mine?.lng).toBeNull();
    // The rest of the row still reports — an unreadable coordinate does not erase the sighting.
    expect(mine?.accuracyM).toBe(5);
  });

  it("GAP-133 — an envelope sealed for ANOTHER tenant never opens: the list reads it as null and reports it", async () => {
    const s = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const device = (
      await admin.query(
        "SELECT id, m2_device_attestation_id FROM evv_device WHERE membership_id = $1 AND status = 'approved' LIMIT 1",
        [s.member],
      )
    ).rows[0];
    // A ciphertext lifted from ORG_B's row into ORG_A's (a restore, a privileged write): it must never
    // decrypt into ORG_A's record. Stamped two hours ahead so it is this member's newest sighting.
    const lifted = await coordsCipher.seal(ORG_B, { lat: 47.6062, lng: -122.3321 });
    await admin.query(
      `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id,
         patient_address_id, kind, service_type_code, posting_membership_id,
         posting_discipline_at_recording, evv_device_id, captured_at, event_at, coords_cipher,
         coords_dek_version, accuracy_m, gps_quality, device_attestation_id_at_record)
       VALUES ($1,$2,$3,$4,$5,NULL,'check_in','',$6,'',$7,
               now() + interval '2 hours', now() + interval '2 hours', $8, $9, 5, 'high', $10)`,
      [
        ORG_A,
        s.pe,
        s.location,
        visit,
        PATIENT,
        s.member,
        device.id,
        lifted.cipher,
        lifted.dekVersion,
        device.m2_device_attestation_id,
      ],
    );
    // One unreadable row must not fail every clinician's location (the agency map): it reads as
    // unavailable and is reported as an integrity fault — never decrypted into ORG_A's record.
    coordsFaults.length = 0;
    const rows = await svc.clinicianCurrentLocation(ORG_A, s.member);
    const row = rows.find((r) => r.membershipId === s.member);
    expect(row).toMatchObject({ lat: null, lng: null });
    expect(coordsFaults).toHaveLength(1);
    expect(coordsFaults[0]).toMatchObject({ organizationId: ORG_A });
  });

  it("capture with accuracy beyond the policy (unattested) is an outside-geofence breach", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const ci = await svc.recordCapture(
      ORG_A,
      member,
      "check_in",
      {
        visitId: visit,
        coords: ADDRESS_BASELINE,
        accuracyM: 80, // > max_accuracy_m 50
        capturedAt: new Date().toISOString(),
      },
      SYSTEM_FIXTURE,
    );
    expect(ci.geofenceDecision).toBe("fail_accuracy");
    expect(ci.gpsQuality).toBe("outside_geofence");
    expect(await eventsFor(ci.eventId)).toContain("m18.evv.geofence_breach_recorded");
  });

  async function captureAt(
    service: typeof svc,
    coords: { lat: number; lng: number },
    accuracyM: number,
    gpsQualityAttested?: "degraded_attested",
  ) {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const ci = await service.recordCapture(
      ORG_A,
      member,
      "check_in",
      {
        visitId: visit,
        coords,
        accuracyM,
        capturedAt: new Date().toISOString(),
        gpsQualityAttested,
      },
      SYSTEM_FIXTURE,
    );
    const { rows } = await admin.query(
      "SELECT computed_distance_m, decision FROM evv_geofence_evaluation WHERE evv_event_id=$1",
      [ci.eventId],
    );
    return { ci, evaluation: rows[0], events: await eventsFor(ci.eventId) };
  }

  it("GAP-054: a good-accuracy capture ~5 km from the address is a breach with the real distance and no at_patient_address", async () => {
    const { ci, evaluation, events } = await captureAt(
      svc,
      { lat: ADDRESS_BASELINE.lat + 0.045, lng: ADDRESS_BASELINE.lng },
      5,
    );
    expect(ci.geofenceDecision).toBe("fail_distance");
    expect(ci.gpsQuality).toBe("outside_geofence");
    expect(events).toContain("m18.evv.geofence_breach_recorded");
    expect(events).not.toContain("m18.evv.at_patient_address");
    expect(evaluation.decision).toBe("fail_distance");
    expect(evaluation.computed_distance_m).toBeGreaterThan(4_500);
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m18.evv.geofence_breach_recorded' AND aggregate_id=$1",
      [ci.eventId],
    );
    expect(rows[0].payload.computedDistanceM).toBeGreaterThan(4_500);
  });

  it("GAP-054: the degraded_attested flag at the address is an advisory breach, not a pass; the flag cannot rescue a far capture", async () => {
    const atAddress = await captureAt(svc, ADDRESS_BASELINE, 80, "degraded_attested");
    expect(atAddress.ci.geofenceDecision).toBe("fail_accuracy");
    expect(atAddress.ci.gpsQuality).toBe("degraded_attested");
    expect(atAddress.events).toContain("m18.evv.geofence_breach_recorded");
    expect(atAddress.events).not.toContain("m18.evv.at_patient_address");

    const far = await captureAt(
      svc,
      { lat: ADDRESS_BASELINE.lat + 0.045, lng: ADDRESS_BASELINE.lng },
      80,
      "degraded_attested",
    );
    expect(far.ci.geofenceDecision).toBe("fail_distance");
    expect(far.events).not.toContain("m18.evv.at_patient_address");
  });

  it("GAP-054: with no address coordinate the capture is no_geofence_baseline, distance NULL, nothing fabricated", async () => {
    const { ci, evaluation, events } = await captureAt(svcNoBaseline, ADDRESS_BASELINE, 5);
    expect(ci.geofenceDecision).toBe("fail_no_baseline");
    expect(ci.gpsQuality).toBe("no_geofence_baseline");
    expect(evaluation.computed_distance_m).toBeNull();
    expect(events).toContain("m18.evv.check_in_recorded");
    expect(events).not.toContain("m18.evv.at_patient_address");
    expect(events).not.toContain("m18.evv.geofence_breach_recorded");
  });

  it("GAP-054: an in-geofence capture stores and emits its real (non-zero-fabricated) distance", async () => {
    const { evaluation, events } = await captureAt(
      svc,
      { lat: ADDRESS_BASELINE.lat + 0.0005, lng: ADDRESS_BASELINE.lng },
      5,
    );
    expect(events).toContain("m18.evv.at_patient_address");
    expect(evaluation.computed_distance_m).toBeGreaterThan(40);
    expect(evaluation.computed_distance_m).toBeLessThan(70);
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
      svc.recordCapture(
        ORG_A,
        bare,
        "check_in",
        {
          visitId: visit,
          coords: { lat: 45.5, lng: -122.6 },
          accuracyM: 4.5,
          capturedAt: new Date().toISOString(),
        },
        SYSTEM_FIXTURE,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  // GAP-055 — a clinician capture is bound to the device the SESSION is attested for: the acting
  // membership's approved evv_device whose m2_device_attestation_id equals the session's attestation id.
  const SEEDED_ATTESTATION_ID = "66666666-6666-6666-6666-666666666666";
  const clinicianInput = (visitId: string) => ({
    visitId,
    coords: { lat: 45.523, lng: -122.6789 },
    accuracyM: 4.5,
    capturedAt: new Date().toISOString(),
  });

  it("clinician capture binds to the session-attested device and records it on the event", async () => {
    const { member, device } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const ci = await svc.recordCapture(
      ORG_A,
      member,
      "check_in",
      clinicianInput(visit),
      clinicianCapture({ valid: true, attestationId: SEEDED_ATTESTATION_ID }),
    );
    const row = await admin.query("SELECT evv_device_id FROM evv_event WHERE id=$1", [ci.eventId]);
    expect(row.rows[0].evv_device_id).toBe(device);
  });

  it("clinician capture from a session whose attestation matches no approved device is refused (403)", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    await expect(
      svc.recordCapture(
        ORG_A,
        member,
        "check_in",
        clinicianInput(visit),
        clinicianCapture({ valid: true, attestationId: "77777777-7777-7777-7777-777777777777" }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const rows = await admin.query("SELECT 1 FROM evv_event WHERE visit_id=$1", [visit]);
    expect(rows.rowCount).toBe(0);
  });

  it("a claimed evvDeviceId that is not the session-bound device is refused (403), even if approved", async () => {
    const { member, device } = seeded[ORG_A];
    const other = (
      await admin.query(
        `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
           m2_device_attestation_id, status, approved_at)
         VALUES ($1,$2,'android',$3,$4,'approved', now()) RETURNING id`,
        [ORG_A, member, `fp-M18W-claim-${Date.now()}`, "88888888-8888-8888-8888-888888888888"],
      )
    ).rows[0].id as string;
    expect(other).not.toBe(device);
    const visit = await seedVisit(ORG_A);
    await expect(
      svc.recordCapture(
        ORG_A,
        member,
        "check_in",
        { ...clinicianInput(visit), claimedDeviceId: other },
        clinicianCapture({ valid: true, attestationId: SEEDED_ATTESTATION_ID }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("flag OFF (default): an un-attested capture resolves the most-recently-approved device; a claim may name any approved device of the same membership", async () => {
    const { member } = seeded[ORG_A];
    // A SECOND approved device, approved later than the seeded one, with an attestation the session never carries.
    const newest = (
      await admin.query(
        `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
           m2_device_attestation_id, status, approved_at)
         VALUES ($1,$2,'android',$3,$4,'approved', now() + interval '1 hour') RETURNING id`,
        [ORG_A, member, `fp-M18W-off-${Date.now()}`, "99999999-9999-4999-8999-999999999999"],
      )
    ).rows[0].id as string;
    const visit = await seedVisit(ORG_A);
    const ci = await svcAttestationOff.recordCapture(
      ORG_A,
      member,
      "check_in",
      clinicianInput(visit),
      clinicianCapture(undefined), // no session attestation at all
    );
    const row = await admin.query("SELECT evv_device_id FROM evv_event WHERE id=$1", [ci.eventId]);
    expect(row.rows[0].evv_device_id).toBe(newest);

    // A claim naming the OLDER approved device of the SAME membership is accepted and recorded against it.
    const visit2 = await seedVisit(ORG_A);
    const older = await svcAttestationOff.recordCapture(
      ORG_A,
      member,
      "check_in",
      { ...clinicianInput(visit2), claimedDeviceId: seeded[ORG_A].device },
      clinicianCapture(undefined),
    );
    const olderRow = await admin.query("SELECT evv_device_id FROM evv_event WHERE id=$1", [
      older.eventId,
    ]);
    expect(olderRow.rows[0].evv_device_id).toBe(seeded[ORG_A].device);

    // A claim that is not an approved device of this membership (another org's device) is refused (never widens).
    const visit3 = await seedVisit(ORG_A);
    await expect(
      svcAttestationOff.recordCapture(
        ORG_A,
        member,
        "check_in",
        { ...clinicianInput(visit3), claimedDeviceId: seeded[ORG_B].device },
        clinicianCapture(undefined),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    // The enforced backend still refuses the same un-attested session.
    await expect(
      svc.recordCapture(
        ORG_A,
        member,
        "check_in",
        clinicianInput(visit3),
        clinicianCapture(undefined),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
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

    const cancelled = await svc.cancelSubmission(
      ORG_A,
      seeded[ORG_A].member,
      requeued.id,
      "the visit was voided; the state should not see this claim line",
    );
    expect(cancelled.status).toBe("cancelled");
    expect(await eventsFor(rejected)).toContain("m18.evv.aggregator_cancelled");
  });

  it("resubmit clears next_retry_at and the rejection fields so the submitter is not delayed by a stale retry time", async () => {
    const visit = await seedVisit(ORG_A);
    const timedOut = await seedSubmission(ORG_A, visit, "timeout");
    await admin.query(
      `UPDATE evv_aggregator_submission
          SET next_retry_at = now() + interval '6 hours',
              aggregator_rejection_code = 'E42', aggregator_rejection_reason = 'bad member id'
        WHERE id = $1`,
      [timedOut],
    );
    const requeued = await svc.resubmitSubmission(ORG_A, seeded[ORG_A].member, timedOut);
    expect(requeued.status).toBe("queued");
    const { rows } = await admin.query(
      `SELECT next_retry_at, aggregator_rejection_code, aggregator_rejection_reason
         FROM evv_aggregator_submission WHERE id = $1`,
      [timedOut],
    );
    expect(rows[0]).toEqual({
      next_retry_at: null,
      aggregator_rejection_code: null,
      aggregator_rejection_reason: null,
    });
  });

  it("editTenantPolicy tightens (allowed) and refuses to loosen beyond the floor; per-address override persists", async () => {
    const setter = seeded[ORG_A].member;
    const tightened = await svc.editTenantPolicy(ORG_A, setter, { radiusM: 80, maxAccuracyM: 30 });
    expect(tightened.tenant).toEqual({ radiusM: 80, maxAccuracyM: 30 });
    await expect(
      svc.editTenantPolicy(ORG_A, setter, { radiusM: 250, maxAccuracyM: 30 }),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    const withOverride = await svc.createPerAddressOverride(ORG_A, setter, {
      patientAddressId: "77777777-7777-7777-7777-777777777777",
      radiusM: 60,
      maxAccuracyM: 20,
      overrideReason: "the driveway sits 180m from the road-network centroid",
    });
    expect(
      withOverride.perAddress.some(
        (p) => p.patientAddressId === "77777777-7777-7777-7777-777777777777",
      ),
    ).toBe(true);
  });

  // ── F-068 · what the write paths actually persist ────────────────────────────────────────────────
  //
  // Every assertion here reads a COLUMN, because the defect was never visible in a return value: the
  // routes validated a justification, the service returned the same view either way, and the column the
  // schema built to hold it stayed NULL.

  it("correction-of-record: supersedes the original, links back, and records why", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const original = await svc.recordCapture(
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

    const reason =
      "the handset clock was 40 minutes fast; corrected to the visit note arrival time";
    const corrected = await svc.correctEvent(ORG_A, member, original.eventId, {
      kind: "check_in",
      visitId: visit,
      coords: { lat: 45.523, lng: -122.6789 },
      accuracyM: 4.5,
      capturedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      correctionReason: reason,
      stepUpVerified: true,
    });

    // F-088 — this whole call is what could not complete before. `correctEvent` stamps `superseded_at`
    // on the original, inserts the replacement, then links the two by `superseded_by_event_id`; it has
    // to be in that order, because the link points at a row that does not exist yet. 0047 nonetheless
    // defined the per-partition backstop `evv_event_<yyyy_mm>_active_visit_kind_uidx` — UNIQUE
    // (organization_id, visit_id, kind) — over `WHERE superseded_by_event_id IS NULL`, so at the moment
    // of the insert BOTH rows were active on the same tuple and Postgres refused it with 23505. Every
    // correction, every tenant, since the route was written. 0236 keys the predicate on `superseded_at`
    // — the marker the service can set first — which is what the write path was always written for.
    const { rows: orig } = await admin.query(
      "SELECT superseded_by_event_id, superseded_at FROM evv_event WHERE id=$1",
      [original.eventId],
    );
    expect(orig[0].superseded_by_event_id).toBe(corrected.eventId);
    expect(orig[0].superseded_at).not.toBeNull();

    const { rows: fresh } = await admin.query(
      "SELECT replaces_event_id, correction_reason FROM evv_event WHERE id=$1",
      [corrected.eventId],
    );
    expect(fresh[0].replaces_event_id).toBe(original.eventId);
    expect(fresh[0].correction_reason).toBe(reason);

    expect(await eventsFor(corrected.eventId)).toContain("m18.evv.event_corrected");

    // The corrected leg reverts to attestation-pending (the machine's `open_missing_resolution` effect).
    const { rows: open } = await admin.query(
      "SELECT kind, detected_by_source FROM evv_missing_resolution WHERE visit_id=$1 AND status='open'",
      [visit],
    );
    expect(open.map((r) => r.kind)).toContain("missing_checkin");
    expect(open[0].detected_by_source).toBe("correction_of_record");

    // The bracket follows the live head, not the row that was corrected away.
    const bracket = await svc.bracketForVisit(ORG_A, visit);
    expect(bracket.checkInEvent?.id).toBe(corrected.eventId);
  });

  // F-088 — the guard on the fix. 0236 loosened the D2 backstop's predicate, so the thing to prove is
  // that it still backstops. Driven by a RAW insert as `admin` rather than through the service, on
  // purpose: 0047's own header says "the app pairing lookup fires first", so the service refuses a
  // second check-in before the index is ever consulted and a service-level test would pass whether the
  // index existed or not. Two rows carrying no supersede marker at all is exactly the shape the index
  // is for, and it is still refused.
  it("§3.2/D2 the active-pair backstop still refuses a second ACTIVE event on the same visit+kind", async () => {
    const { member, pe, location, device } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const first = await svc.recordCapture(
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
    const { rows: seed } = await admin.query(
      `SELECT event_at, coords_cipher, coords_dek_version, device_attestation_id_at_record,
              service_type_code, posting_discipline_at_recording
         FROM evv_event WHERE id=$1`,
      [first.eventId],
    );
    await expect(
      admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id,
                                kind, service_type_code, posting_membership_id,
                                posting_discipline_at_recording, evv_device_id, captured_at, event_at,
                                coords_cipher, coords_dek_version, accuracy_m, gps_quality,
                                device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,'check_in',$6,$7,$8,$9, now(), $10, $11, $12, 4.5, 'high', $13)`,
        [
          ORG_A,
          pe,
          location,
          visit,
          PATIENT,
          seed[0].service_type_code,
          member,
          seed[0].posting_discipline_at_recording,
          device,
          seed[0].event_at,
          seed[0].coords_cipher,
          seed[0].coords_dek_version,
          seed[0].device_attestation_id_at_record,
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("correction-of-record: refuses a stale step-up, an already-corrected target, and a kind swap", async () => {
    const { member } = seeded[ORG_A];
    const visit = await seedVisit(ORG_A);
    const original = await svc.recordCapture(
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
    const base = {
      visitId: visit,
      coords: { lat: 45.523, lng: -122.6789 },
      accuracyM: 4.5,
      capturedAt: new Date().toISOString(),
      correctionReason: "x".repeat(60),
      stepUpVerified: true,
    };

    await expect(
      svc.correctEvent(ORG_A, member, original.eventId, {
        ...base,
        kind: "check_in",
        stepUpVerified: false,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      svc.correctEvent(ORG_A, member, original.eventId, { ...base, kind: "check_out" }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const first = await svc.correctEvent(ORG_A, member, original.eventId, {
      ...base,
      kind: "check_in",
    });
    expect(first.eventId).not.toBe(original.eventId);
    await expect(
      svc.correctEvent(ORG_A, member, original.eventId, { ...base, kind: "check_in" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("device reject / suspend persist their reason and name the ACTING supervisor", async () => {
    const { member } = seeded[ORG_A];
    const supervisor = seeded[ORG_A].member;
    const rejected = await svc.selfRegisterDevice(ORG_A, member, {
      platform: "ios",
      modelDescription: "iPhone 13",
    });
    await svc.rejectDevice(ORG_A, supervisor, rejected.id, "enrolled on a personal handset");
    const { rows: r } = await admin.query(
      "SELECT denial_reason, rejected_by_membership_id FROM evv_device WHERE id=$1",
      [rejected.id],
    );
    expect(r[0].denial_reason).toBe("enrolled on a personal handset");
    expect(r[0].rejected_by_membership_id).toBe(supervisor);

    const live = await svc.selfRegisterDevice(ORG_A, member, {
      platform: "ios",
      modelDescription: "iPhone 15",
    });
    await svc.approveDevice(ORG_A, supervisor, live.id);
    await svc.suspendDevice(ORG_A, supervisor, live.id, "reported lost at the Tuesday standup");
    const { rows: sus } = await admin.query(
      "SELECT suspend_reason, approved_by_membership_id FROM evv_device WHERE id=$1",
      [live.id],
    );
    expect(sus[0].suspend_reason).toBe("reported lost at the Tuesday standup");
    expect(sus[0].approved_by_membership_id).toBe(supervisor);
  });

  it("the per-address override persists its ≥30-char reason and its setter", async () => {
    const setter = seeded[ORG_A].member;
    const address = "88888888-8888-8888-8888-888888888888";
    const reason = "the driveway sits 180m from the road-network centroid";
    await svc.createPerAddressOverride(ORG_A, setter, {
      patientAddressId: address,
      radiusM: 60,
      maxAccuracyM: 20,
      overrideReason: reason,
    });
    const { rows } = await admin.query(
      "SELECT override_reason, set_by_membership_id FROM evv_geofence_policy " +
        "WHERE patient_address_id=$1 AND effective_to IS NULL",
      [address],
    );
    expect(rows[0].override_reason).toBe(reason);
    expect(rows[0].set_by_membership_id).toBe(setter);
  });

  it("an aggregator cancel persists its reason and carries it on the outbox payload", async () => {
    const visit = await seedVisit(ORG_A);
    const pending = await seedSubmission(ORG_A, visit, "pending");
    const reason = "the visit was voided; the state should not see this claim line";
    await svc.cancelSubmission(ORG_A, seeded[ORG_A].member, pending, reason);
    const { rows } = await admin.query(
      "SELECT cancellation_reason FROM evv_aggregator_submission WHERE id=$1",
      [pending],
    );
    expect(rows[0].cancellation_reason).toBe(reason);
    const { rows: ob } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m18.evv.aggregator_cancelled'",
      [pending],
    );
    expect(ob[0].payload.reason).toBe(reason);
  });

  it("RLS: org B cannot capture against org A's visit (visit invisible → 404)", async () => {
    const visit = await seedVisit(ORG_A);
    await expect(
      svc.recordCapture(
        ORG_B,
        seeded[ORG_B].member,
        "check_in",
        {
          visitId: visit,
          coords: { lat: 45.5, lng: -122.6 },
          accuracyM: 4.5,
          capturedAt: new Date().toISOString(),
        },
        SYSTEM_FIXTURE,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
