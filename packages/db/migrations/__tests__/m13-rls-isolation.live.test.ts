/**
 * M13 eMAR & Med Administration — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M13's pure suites exercise the PRN/witness/comfort-kit/five-rights machinery but never touch a database,
 * so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across
 * tenants. This applies the real migrations to a real Postgres and drives the policies as the unprivileged
 * `wardenx_app` role (no BYPASSRLS), covering all TWELVE org-scoped M13 tables.
 *
 * One of the twelve carries the risk that makes this worth more than a checkbox:
 *   • `administration_record` is the eMAR administration event — the CMS-billable, DEA-controlled record of a
 *     drug given to a patient. A cross-tenant write would let one tenant manufacture another's medication
 *     administrations; a cross-tenant read is a controlled-substance disclosure of another org's patient.
 *     It is PARTITIONED BY RANGE (administered_at) (§3.5 / D13): the RLS policy sits on the partitioned
 *     PARENT (row policies propagate to every partition, PG11+), its audit trigger is a bespoke function
 *     (NOT M1's `wardenx_audit_trigger()`, whose TG_TABLE_NAME would be the partition name), and any insert's
 *     `administered_at` must route to a live partition — now() lands in the current-month child (0041 creates
 *     current + 12 forward, plus a DEFAULT catch-all).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m13` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** M13 has NO owned FK to `user`; seeded for parity with the base-seed shape only. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id / medication_order_id / *_membership_id are NOT NULL but carry NO FK
 * (cross-module refs are plain uuid, §3.3) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const MED_ORDER = "66666666-6666-6666-6666-666666666666";
const MEMBERSHIP = "77777777-7777-7777-7777-777777777777";
const OUTBOX_EVENT = "88888888-8888-8888-8888-888888888888";
const DEVICE = "99999999-9999-9999-9999-999999999999";
const LOCAL_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type SeedIds = {
  providerEntity: string;
  location: string;
  administrationRecord: string;
  scheduledDose: string;
  prnAdministration: string;
  missedDose: string;
  administrationWitness: string;
  comfortKitDeployment: string;
  comfortKitDrawdown: string;
  reconciliationWorksheet: string;
  reconciliationDecision: string;
  barcodeScanEvent: string;
  offlineQueue: string;
  administrationPolicy: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "administration_record", key: "administrationRecord" },
  { table: "scheduled_dose", key: "scheduledDose" },
  { table: "prn_administration", key: "prnAdministration" },
  { table: "missed_dose", key: "missedDose" },
  { table: "administration_witness", key: "administrationWitness" },
  { table: "comfort_kit_deployment", key: "comfortKitDeployment" },
  { table: "comfort_kit_drawdown", key: "comfortKitDrawdown" },
  { table: "medication_reconciliation_worksheet", key: "reconciliationWorksheet" },
  { table: "medication_reconciliation_decision", key: "reconciliationDecision" },
  { table: "barcode_scan_event", key: "barcodeScanEvent" },
  { table: "administration_offline_queue", key: "offlineQueue" },
  { table: "administration_policy", key: "administrationPolicy" },
];

describe.skipIf(!DB_URL)("M13 eMAR — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE wardenx_app");
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
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M13 administration chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M13${n}`, `M13 Provider ${n}`, `NPI-M13${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M13${n}`],
      )
    ).rows[0].id as string;

    // administration_record — PARTITIONED; administered_at=now() routes to the current-month child.
    const administrationRecord = (
      await db.query(
        `INSERT INTO administration_record (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, mode, data, drug_name_snapshot, route_snapshot,
           administered_at, actor_kind)
         VALUES ($1,$2,$3,$4,$5,$6,'single_dose','{}'::jsonb,'Morphine','oral', now(), 'clinician')
         RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;

    const scheduledDose = (
      await db.query(
        `INSERT INTO scheduled_dose (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, due_at, grace_window_minutes, expected_dose_amount,
           expected_dose_unit, expected_route, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6, now(), 60, 5.0000, 'mg', 'oral', 1) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;

    const prnAdministration = (
      await db.query(
        `INSERT INTO prn_administration (organization_id, provider_entity_id, location_id,
           administration_record_id, patient_id, admission_id, medication_order_id, triggering_prn_reason,
           requested_by_kind, reassessment_window_minutes, reassessment_due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'breakthrough pain','clinician_observed', 60, now() + interval '1 hour')
         RETURNING id`,
        [org, providerEntity, location, administrationRecord, PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;

    const missedDose = (
      await db.query(
        `INSERT INTO missed_dose (organization_id, provider_entity_id, location_id, scheduled_dose_id,
           patient_id, admission_id, medication_order_id, missed_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'detected_by_sweep') RETURNING id`,
        [org, providerEntity, location, scheduledDose, PATIENT, ADMISSION, MED_ORDER],
      )
    ).rows[0].id as string;

    const administrationWitness = (
      await db.query(
        // attestation_token_digest carries a GLOBAL (not org-scoped) unique constraint (migration 0160,
        // the witness-token-burn anti-replay guard — a real token digest must be unique across every
        // tenant, not just within one) — so the two seedOrg() calls need distinct literals, like ccn/npi.
        `INSERT INTO administration_witness (organization_id, administration_record_id, witness_membership_id,
           witnesses_scope, attestation_text, attestation_token_digest)
         VALUES ($1,$2,$3,'administration_only','I witnessed the administration',$4) RETURNING id`,
        [org, administrationRecord, MEMBERSHIP, `digest-m13-${n}`],
      )
    ).rows[0].id as string;

    const comfortKitDeployment = (
      await db.query(
        `INSERT INTO comfort_kit_deployment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, deployed_at)
         VALUES ($1,$2,$3,$4,$5, now()) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION],
      )
    ).rows[0].id as string;

    const comfortKitDrawdown = (
      await db.query(
        `INSERT INTO comfort_kit_drawdown (organization_id, comfort_kit_deployment_id, medication_order_id,
           expected_quantity, expected_unit, remaining_quantity, replenishment_threshold)
         VALUES ($1,$2,$3, 10.0000, 'tab', 10.0000, 2.0000) RETURNING id`,
        [org, comfortKitDeployment, MED_ORDER],
      )
    ).rows[0].id as string;

    const reconciliationWorksheet = (
      await db.query(
        `INSERT INTO medication_reconciliation_worksheet (organization_id, provider_entity_id, location_id,
           patient_id, admission_id, trigger_kind, trigger_outbox_event_id, triggered_at, due_at)
         VALUES ($1,$2,$3,$4,$5,'admission',$6, now(), now() + interval '1 day') RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, OUTBOX_EVENT],
      )
    ).rows[0].id as string;

    const reconciliationDecision = (
      await db.query(
        `INSERT INTO medication_reconciliation_decision (organization_id, worksheet_id, line_kind,
           decision_kind, decision_made_by_membership_id)
         VALUES ($1,$2,'active_order','carry_forward',$3) RETURNING id`,
        [org, reconciliationWorksheet, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const barcodeScanEvent = (
      await db.query(
        `INSERT INTO barcode_scan_event (organization_id, administration_record_id, match_result)
         VALUES ($1,$2,'match') RETURNING id`,
        [org, administrationRecord],
      )
    ).rows[0].id as string;

    const offlineQueue = (
      await db.query(
        `INSERT INTO administration_offline_queue (organization_id, device_id, local_id,
           payload_envelope_digest)
         VALUES ($1,$2,$3,'envdigest') RETURNING id`,
        [org, DEVICE, LOCAL_ID],
      )
    ).rows[0].id as string;

    const administrationPolicy = (
      await db.query(
        `INSERT INTO administration_policy (organization_id) VALUES ($1) RETURNING id`,
        [org],
      )
    ).rows[0].id as string;

    return {
      providerEntity,
      location,
      administrationRecord,
      scheduledDose,
      prnAdministration,
      missedDose,
      administrationWitness,
      comfortKitDeployment,
      comfortKitDrawdown,
      reconciliationWorksheet,
      reconciliationDecision,
      barcodeScanEvent,
      offlineQueue,
      administrationPolicy,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m13-actor@x.test')`, [USER]);
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable.
  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M13 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0041_emar_m13_rls_audit_triggers.sql"),
      "utf8",
    );
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter((b) =>
      COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    // All twelve M13 tables — including the PARTITIONED administration_record, whose policy sits on the
    // partitioned parent — carry a standard app.org_id `_org` policy block, so the count is COVERED.length.
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

  it("a WITH CHECK refuses an administration_record forged into another tenant's org", async () => {
    // administration_record is the CMS-billable, DEA-controlled eMAR event — a cross-tenant write would let
    // one tenant manufacture another's medication administrations. administered_at=now() routes to a live
    // partition so the rejection is the RLS WITH CHECK, not a missing-partition error.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO administration_record (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, medication_order_id, mode, data, drug_name_snapshot, route_snapshot,
             administered_at, actor_kind)
           VALUES ($1,$2,$3,$4,$5,$6,'single_dose','{}'::jsonb,'forged','oral', now(), 'clinician')`,
          [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, MED_ORDER],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's administration_record (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE administration_record SET status='voided' WHERE id=$1", [a.administrationRecord]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM administration_record WHERE id=$1", [
      a.administrationRecord,
    ]);
    expect(still.rows[0].status).toBe("committed");
  });

  it("the M4 write-audit trigger fired for the scheduled_dose writes (§3.6)", async () => {
    // scheduled_dose is non-partitioned, so its bespoke trigger emits a stable resource_kind. (The
    // partitioned administration_record uses a different trigger function whose resource_kind is
    // hardcoded, but §3.6 asserts here against a non-partitioned table.)
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'scheduled_dose'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
