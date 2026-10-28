/**
 * M18 EVV (Electronic Visit Verification) — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M18's pure suites exercise the check-in/check-out pairing, geofence evaluation and aggregator-submission
 * machinery but never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a
 * base-table grant that leaks across tenants. This applies the real migrations to a real Postgres and drives the
 * policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), covering all SIX org-scoped M18 tables.
 *
 * Two of the six carry the risk that makes this worth more than a checkbox:
 *   • `evv_event` is the only PHI-bearing table (it carries patient_id + encrypted GPS coordinates); it is the
 *     Medicaid EVV / HQRP visit-verification record CMS pays claims against. It is also PARTITIONED BY RANGE
 *     (event_at) — a partition leaf is protected by GRANTS not inherited RLS, so the RLS policy lives on the
 *     partitioned PARENT and propagates to every leaf (PG11+ row-security on partitioned tables). A cross-tenant
 *     write would let one tenant manufacture another's visit-verification events.
 *   • `evv_geofence_policy` sets the radius/accuracy thresholds a tenant's whole EVV compliance turns on; a
 *     cross-tenant write is a silent weakening of another org's geofence enforcement.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m18` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "../../../../apps/backend/__tests__/_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `evv_device.membership_id`, `evv_event.posting_membership_id` and `evv_geofence_policy.set_by_membership_id`
 * carry real FKs to `membership`, so each org needs one; `membership.user_id` FKs `user`, seeded once. */
const USER = "33333333-3333-3333-3333-333333333333";
/** visit_id / patient_id / device_attestation_id_at_record / applied_policy_id are NOT NULL but carry NO SQL FK
 * (the satellite→partitioned-parent references are app-validated) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const VISIT = "55555555-5555-5555-5555-555555555555";
const DEVICE_ATTEST = "66666666-6666-6666-6666-666666666666";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  evvDevice: string;
  evvGeofencePolicy: string;
  evvEvent: string;
  evvGeofenceEvaluation: string;
  evvMissingResolution: string;
  evvAggregatorSubmission: string;
  evvVisitRegistration: string;
};

// All SIX M18-owned tables are org-scoped (organization_id NOT NULL) and get an app.org_id RLS policy. There are
// no catalog / non-org-scoped tables in this module, so nothing is EXCLUDED. `evv_event` is PARTITIONED but its
// policy lives on the partitioned parent (propagates to leaves), so it stays in both the sweep AND the count.
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "evv_event", key: "evvEvent" },
  { table: "evv_geofence_evaluation", key: "evvGeofenceEvaluation" },
  { table: "evv_geofence_policy", key: "evvGeofencePolicy" },
  { table: "evv_device", key: "evvDevice" },
  { table: "evv_missing_resolution", key: "evvMissingResolution" },
  { table: "evv_aggregator_submission", key: "evvAggregatorSubmission" },
  { table: "evv_visit_registration", key: "evvVisitRegistration" },
];

describe.skipIf(!DB_URL)("M18 EVV — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE chartwarden_app");
    await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
    try {
      return await fn();
    } finally {
      await db.query("RESET ROLE");
    }
  }

  async function resetSchema() {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    await dropLiveRoles(db);
  }

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M18 EVV chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;

    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M18${n}`, `M18 Provider ${n}`, `NPI-M18${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M18${n}`],
      )
    ).rows[0].id as string;

    const evvDevice = (
      await db.query(
        `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
           m2_device_attestation_id)
         VALUES ($1,$2,'ios',$3,$4) RETURNING id`,
        [org, membership, `fp-M18${n}`, DEVICE_ATTEST],
      )
    ).rows[0].id as string;

    const evvGeofencePolicy = (
      await db.query(
        `INSERT INTO evv_geofence_policy (organization_id, scope, radius_m, max_accuracy_m, effective_from,
           set_by_membership_id)
         VALUES ($1,'tenant',150,50, now()::date, $2) RETURNING id`,
        [org, membership],
      )
    ).rows[0].id as string;

    // event_at = now() routes into the current-month partition (0047 pre-creates current + 12 forward months).
    const evvEvent = (
      await db.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
           service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
           captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
           device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,'check_in','T1021',$6,'rn',$7, now(), now(),'enc',1,4.5,'high',$8)
         RETURNING id`,
        [org, providerEntity, location, VISIT, PATIENT, membership, evvDevice, DEVICE_ATTEST],
      )
    ).rows[0].id as string;

    const evvGeofenceEvaluation = (
      await db.query(
        `INSERT INTO evv_geofence_evaluation (organization_id, evv_event_id, applied_policy_id,
           applied_policy_scope, applied_radius_m, applied_max_accuracy_m, device_coords_cipher, decision)
         VALUES ($1,$2,$3,'tenant',150,50,'enc','inside') RETURNING id`,
        [org, evvEvent, evvGeofencePolicy],
      )
    ).rows[0].id as string;

    const evvMissingResolution = (
      await db.query(
        `INSERT INTO evv_missing_resolution (organization_id, visit_id, kind, detected_by_source)
         VALUES ($1,$2,'missing_checkout','sync_reconcile') RETURNING id`,
        [org, VISIT],
      )
    ).rows[0].id as string;

    const evvAggregatorSubmission = (
      await db.query(
        `INSERT INTO evv_aggregator_submission (organization_id, visit_id, state_code, aggregator_vendor)
         VALUES ($1,$2,'OR','sandata') RETURNING id`,
        [org, VISIT],
      )
    ).rows[0].id as string;

    const evvVisitRegistration = (
      await db.query(
        `INSERT INTO evv_visit_registration (organization_id, provider_entity_id, location_id,
           visit_id, patient_id, admission_id, assigned_membership_id, assigned_discipline,
           service_type_code, scheduled_started_at, scheduled_ended_at, source_outbox_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'rn','routine_visit',now(),now() + interval '1 hour',$8)
         RETURNING id`,
        [
          org,
          providerEntity,
          location,
          VISIT,
          PATIENT,
          `7777777${n}-7777-4777-8777-777777777777`,
          membership,
          `8888888${n}-8888-4888-8888-888888888888`,
        ],
      )
    ).rows[0].id as string;

    return {
      membership,
      providerEntity,
      location,
      evvDevice,
      evvGeofencePolicy,
      evvEvent,
      evvGeofenceEvaluation,
      evvMissingResolution,
      evvAggregatorSubmission,
      evvVisitRegistration,
    };
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m18-actor@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable.
  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M18 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = ["0047_evv_m18_rls_audit_triggers.sql", "0169_evv_visit_registration.sql"]
      .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    // All six get a standard org block — including the PARTITIONED evv_event (policy on the parent).
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses an evv_event forged into another tenant (the PHI visit-verification record)", async () => {
    // evv_event is the PHI-bearing Medicaid EVV / HQRP verification record; a cross-tenant write would let one
    // tenant manufacture another's visit events. event_at = now() is a partition-valid timestamp so the write
    // reaches the WITH CHECK (not a "no partition" error) and is refused there.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
             service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
             captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
             device_attestation_id_at_record)
           VALUES ($1,$2,$3,$4,$5,'check_in','T1021',$6,'rn',$7, now(), now(),'enc',1,4.5,'high',$8)`,
          [
            ORG_A,
            a.providerEntity,
            a.location,
            VISIT,
            PATIENT,
            a.membership,
            a.evvDevice,
            DEVICE_ATTEST,
          ],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's evv_device (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE evv_device SET status='suspended' WHERE id=$1", [a.evvDevice]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM evv_device WHERE id=$1", [a.evvDevice]);
    expect(still.rows[0].status).toBe("pending_approval");
  });

  it("the M4 write-audit trigger fired for the evv_device writes (§3.6)", async () => {
    // evv_device is NON-partitioned, so its per-table audit trigger fires normally. (evv_event's audit trigger
    // is a partitioned-table-safe variant and is deliberately not the resource asserted here.)
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'evv_device'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
