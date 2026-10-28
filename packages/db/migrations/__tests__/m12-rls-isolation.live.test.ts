/**
 * M12 DoseSpot Integration — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M12's pure suites drive the 14-state medication-order machine (draft → signed → transmitted → active),
 * the verbal-order timer, the refill loop and the EPCS-OFF gate, but never touch a database, so they cannot
 * catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants. This
 * applies the real migrations to a real Postgres and drives the policies as the unprivileged `chartwarden_app`
 * role (no BYPASSRLS), covering all SIX org-scoped M12 tables.
 *
 * Two of the six carry the risk that makes this worth more than a checkbox:
 *   • `medication_order` is the prescription of record — for controlled substances it is the DEA-scheduled
 *     order CMS and the pharmacy act on. A cross-tenant write would let one tenant manufacture another's
 *     medication orders (incl. controlled-substance scripts); it is also the §3.5/D15 RANGE-partitioned
 *     table, so this proves the parent policy reaches through to the monthly partition children.
 *   • `epcs_signing_attempt` is the DEA §1311 electronic-prescribing-of-controlled-substances evidence; a
 *     cross-tenant read is a disclosure of another org's prescriber signing another org's controlled order.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m12` (SUPERUSER to a THROWAWAY db;
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
/** `medication_order.prescriber_membership_id`, `dosespot_prescriber.membership_id` and
 * `epcs_signing_attempt.prescriber_membership_id` carry real FKs to `membership`, so each org needs one. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id / prescribing_physician_mdm_id are NOT NULL but carry NO SQL FK (cross-module
 * refs stay plain uuid, §3.3) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  medicationOrder: string;
  medicationOrderTransmission: string;
  refillRequest: string;
  dosespotWebhookEvent: string;
  dosespotPrescriber: string;
  epcsSigningAttempt: string;
  medicationOrderIdgApplication: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  // medication_order is RANGE-partitioned on created_at; the `medication_order_org` policy lives on the
  // partitioned PARENT (0039) and covers every monthly child, so it stays in both the read/write sweep AND
  // the policy count — there is exactly one direct `_org` policy naming "medication_order".
  { table: "medication_order", key: "medicationOrder" },
  { table: "medication_order_transmission", key: "medicationOrderTransmission" },
  { table: "refill_request", key: "refillRequest" },
  { table: "dosespot_webhook_event", key: "dosespotWebhookEvent" },
  { table: "dosespot_prescriber", key: "dosespotPrescriber" },
  { table: "epcs_signing_attempt", key: "epcsSigningAttempt" },
  { table: "medication_order_idg_decision_application", key: "medicationOrderIdgApplication" },
];

describe.skipIf(!DB_URL)("M12 DoseSpot — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
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

  /** Seed one full M12 DoseSpot chain for `org` as superuser (RLS + grants bypassed). */
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
        [org, `CCN-M12${n}`, `M12 Provider ${n}`, `NPI-M12${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M12${n}`],
      )
    ).rows[0].id as string;

    // medication_order — the partitioned prescription of record. is_controlled_substance defaults false and
    // dea_schedule stays NULL, satisfying the controlled_schedule_consistency CHECK.
    const medicationOrder = (
      await db.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, med_class, drug_name, strength, dose_form, route, data, prescriber_membership_id,
           prescribing_physician_mdm_id)
         VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership, PHYSICIAN_MDM],
      )
    ).rows[0].id as string;

    // medication_order_id is a plain uuid here (medication_order is partitioned → no SQL FK), so the seeded
    // order id is a real reference without an enforced constraint.
    const medicationOrderTransmission = (
      await db.query(
        `INSERT INTO medication_order_transmission (organization_id, medication_order_id, idempotency_key,
           rx_business_key, correlation_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [org, medicationOrder, `idem-M12${n}`, `rxbk-M12${n}`, `corr-M12${n}`],
      )
    ).rows[0].id as string;

    const refillRequest = (
      await db.query(
        `INSERT INTO refill_request (organization_id, provider_entity_id, location_id,
           source_medication_order_id, patient_id, dosespot_event_id, received_at)
         VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
        [org, providerEntity, location, medicationOrder, PATIENT, `rx-evt-M12${n}`],
      )
    ).rows[0].id as string;

    const dosespotWebhookEvent = (
      await db.query(
        `INSERT INTO dosespot_webhook_event (organization_id, dosespot_event_id, event_type, raw_body_cipher,
           raw_body_dek, body_digest, signature_verified_at, correlation_id)
         VALUES ($1,$2,'script_status_update','cipher','dek','digest', now(), $2) RETURNING id`,
        [org, `wh-evt-M12${n}`],
      )
    ).rows[0].id as string;

    const dosespotPrescriber = (
      await db.query(
        `INSERT INTO dosespot_prescriber (organization_id, membership_id, npi)
         VALUES ($1,$2,$3) RETURNING id`,
        [org, membership, `NPI-PRES-M12${n}`],
      )
    ).rows[0].id as string;

    // epcs_signing_attempt.nonce is GLOBALLY unique (no org column in the index), so it must differ per org.
    const epcsSigningAttempt = (
      await db.query(
        `INSERT INTO epcs_signing_attempt (organization_id, medication_order_id, prescriber_membership_id,
           nonce, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '5 minutes') RETURNING id`,
        [org, medicationOrder, membership, `nonce-M12${n}`],
      )
    ).rows[0].id as string;

    const medicationOrderIdgApplication = (
      await db.query(
        `INSERT INTO medication_order_idg_decision_application
           (organization_id, idg_decision_id, medication_order_ids)
         VALUES ($1,$2,$3::jsonb) RETURNING id`,
        [org, `8888888${n}-8888-4888-8888-888888888888`, JSON.stringify([medicationOrder])],
      )
    ).rows[0].id as string;

    return {
      membership,
      providerEntity,
      location,
      medicationOrder,
      medicationOrderTransmission,
      refillRequest,
      dosespotWebhookEvent,
      dosespotPrescriber,
      epcsSigningAttempt,
      medicationOrderIdgApplication,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12-actor@x.test')`, [USER]);
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

  it("every M12 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = [
      "0039_dosespot_m12_rls_audit_triggers.sql",
      "0168_idg_downstream_consumer_projections.sql",
    ]
      .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
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

  it("a WITH CHECK refuses a medication order forged into another tenant (partition parent policy)", async () => {
    // medication_order is the prescription of record (controlled-substance scripts included) AND the
    // RANGE-partitioned table — a cross-tenant INSERT must be refused by the parent policy's WITH CHECK,
    // proving the policy reaches through to the monthly partition child the row would land in.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, med_class, drug_name, strength, dose_form, route, data,
             prescriber_membership_id, prescribing_physician_mdm_id)
           VALUES ($1,$2,$3,$4,$5,'standard','forged','5 mg','tablet','oral','{}'::jsonb,$6,$7)`,
          [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, b.membership, PHYSICIAN_MDM],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's medication order (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE medication_order SET status='discontinued' WHERE id=$1", [
        a.medicationOrder,
      ]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM medication_order WHERE id=$1", [
      a.medicationOrder,
    ]);
    expect(still.rows[0].status).toBe("draft");
  });

  it("the M4 write-audit trigger fired for the medication-order writes (§3.8)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'medication_order'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
