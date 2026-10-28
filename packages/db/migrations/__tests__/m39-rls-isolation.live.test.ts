/**
 * M39 Consent & Authorization Management — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §3.7).
 *
 * M39's pure suites exercise the consent state-machine (draft → active → superseded/revoked/expired), the
 * DPOA/recipient scoping, and the revocation cascade, but never touch a database — so they cannot catch a
 * wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants. This applies
 * the real migrations to a real Postgres and drives the policies as the unprivileged `chartwarden_app` role (no
 * BYPASSRLS), covering all TEN org-scoped M39 tables (0022 tables + the 0023 org-scope policies).
 *
 * Consent is the highest-stakes disclosure surface in the product — it is the record that authorizes (or
 * forbids) PHI to leave the org, and it is 42 CFR Part 2 adjacent:
 *   • `consent_record` is the authorization document itself — a cross-tenant read is a disclosure of another
 *     org's patient's release/DPOA/Part-2 decisions; a cross-tenant WRITE would let one tenant manufacture an
 *     authorization the other org's PHI is then released against.
 *   • `delegated_access` is the live portal grant a consent produces — a cross-tenant row would hand a
 *     caregiver a session into another org's patient chart.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m39` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropLiveRoles } from "./_live-roles";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** M39 has NO FK from consent actor columns (created_by_id / added_by_id / signed_by_id / delegate_*_id) to
 * `user` — they are org-context identifiers, not constrained. One seeded user is still enough for the
 * organization/base seed relabel. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / created_by_id / added_by_id / delegate_caregiver_id are NOT NULL but carry NO FK — literals. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const CAREGIVER = "55555555-5555-5555-5555-555555555555";

type SeedIds = {
  providerEntity: string;
  location: string;
  overlay: string;
  consentRecord: string;
  recipient: string;
  dpoaAgent: string;
  revocation: string;
  reminder: string;
  delegatedAccess: string;
  documentLink: string;
  renewalCycle: string;
  evalAudit: string;
};

const COVERED: { table: string; key: keyof SeedIds; idCol?: string }[] = [
  { table: "tenant_consent_type_overlay", key: "overlay" },
  { table: "consent_record", key: "consentRecord" },
  { table: "consent_record_recipient", key: "recipient" },
  { table: "consent_record_dpoa_agent", key: "dpoaAgent" },
  { table: "consent_revocation", key: "revocation" },
  { table: "consent_expiration_reminder", key: "reminder" },
  { table: "delegated_access", key: "delegatedAccess" },
  // consent_document_link has no `id` column — its PK is consent_record_id.
  { table: "consent_document_link", key: "documentLink", idCol: "consent_record_id" },
  { table: "consent_renewal_cycle", key: "renewalCycle" },
  // consent_eval_audit is PARTITION BY RANGE (evaluated_at); its `_org` policy sits on the partitioned
  // PARENT and (PG11+) applies to every partition, so it stays in the sweep AND the policy count.
  { table: "consent_eval_audit", key: "evalAudit" },
];

// EXCLUDED — consent_type_catalog: the platform-shared consent-type FLOOR. It has NO organization_id and its
// policy is `consent_type_catalog_read` (FOR SELECT USING true, dual-grant), NOT a tenant `_org` policy —
// writes go only through the consent_catalog_writer role, never chartwarden_app. Not tenant-isolated by design.

describe.skipIf(!DB_URL)("M39 Consent — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
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

  /** Seed one full M39 consent chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M39${n}`, `M39 Provider ${n}`, `NPI-M39${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M39${n}`],
      )
    ).rows[0].id as string;

    const overlay = (
      await db.query(
        `INSERT INTO tenant_consent_type_overlay (organization_id, type_key, tighter_expiration_seconds,
           jurisdiction_code_required, published_at, published_by_id)
         VALUES ($1,'portal_access',86400,true, now(), $2) RETURNING id`,
        [org, USER],
      )
    ).rows[0].id as string;

    const consentRecord = (
      await db.query(
        `INSERT INTO consent_record (organization_id, provider_entity_id, location_id, patient_id, type_key,
           scope_descriptor, grantor_kind, effective_at, status, capture_method, capture_evidence_jsonb,
           created_by_id)
         VALUES ($1,$2,$3,$4,'portal_access','{}'::jsonb,'patient_self', now(),'draft',
           'electronic_portal_signature','{}'::jsonb,$5) RETURNING id`,
        [org, providerEntity, location, PATIENT, USER],
      )
    ).rows[0].id as string;

    const recipient = (
      await db.query(
        `INSERT INTO consent_record_recipient (organization_id, consent_record_id, recipient_kind,
           recipient_free_text, recipient_resolved_display_name, added_by_id)
         VALUES ($1,$2,'free_text','Dr Away','Dr Away',$3) RETURNING id`,
        [org, consentRecord, USER],
      )
    ).rows[0].id as string;

    const dpoaAgent = (
      await db.query(
        `INSERT INTO consent_record_dpoa_agent (organization_id, consent_record_id, agent_kind, agent_name,
           agent_relationship, agent_contact_jsonb, activation_condition, scope_kind, term_kind, added_by_id)
         VALUES ($1,$2,'primary','Agent Smith','spouse','{}'::jsonb,'immediate','healthcare_full',
           'indefinite',$3) RETURNING id`,
        [org, consentRecord, USER],
      )
    ).rows[0].id as string;

    const revocation = (
      await db.query(
        `INSERT INTO consent_revocation (organization_id, consent_record_id, revoked_by_kind, reason_text)
         VALUES ($1,$2,'patient_self_via_portal','patient withdrew via portal') RETURNING id`,
        [org, consentRecord],
      )
    ).rows[0].id as string;

    const reminder = (
      await db.query(
        `INSERT INTO consent_expiration_reminder (organization_id, consent_record_id, reminder_kind,
           scheduled_for, delivery_channel, recipient_resolution_jsonb, idempotency_key)
         VALUES ($1,$2,'90_days', now(),'portal','{}'::jsonb,$3) RETURNING id`,
        [org, consentRecord, `idem-m39-${n}`],
      )
    ).rows[0].id as string;

    const delegatedAccess = (
      await db.query(
        `INSERT INTO delegated_access (organization_id, provider_entity_id, location_id, patient_id,
           consent_record_id, consent_record_recipient_id, delegate_caregiver_id, scope_kind, effective_from,
           portal_session_class)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'view_only_minimal', now(),'caregiver') RETURNING id`,
        [org, providerEntity, location, PATIENT, consentRecord, recipient, CAREGIVER],
      )
    ).rows[0].id as string;

    // consent_document_link PK is consent_record_id (no `id` column) — return that as the sweep key.
    const documentLink = (
      await db.query(
        `INSERT INTO consent_document_link (consent_record_id, organization_id, document_id,
           document_version_id, template_version)
         VALUES ($1,$2,$3,$4,'v1') RETURNING consent_record_id AS id`,
        [consentRecord, org, PATIENT, CAREGIVER],
      )
    ).rows[0].id as string;

    const renewalCycle = (
      await db.query(
        `INSERT INTO consent_renewal_cycle (organization_id, provider_entity_id, location_id,
           source_consent_record_id, patient_id, status)
         VALUES ($1,$2,$3,$4,$5,'open') RETURNING id`,
        [org, providerEntity, location, consentRecord, PATIENT],
      )
    ).rows[0].id as string;

    // consent_eval_audit: id has NO default and the PK is (id, evaluated_at) — supply a real uuid.
    const evalAudit = (
      await db.query(
        `INSERT INTO consent_eval_audit (id, organization_id, provider_entity_id, location_id, patient_id,
           consent_record_id, type_key, allowed, as_of, caller_module)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'portal_access',true, now(),'m39') RETURNING id`,
        [org, providerEntity, location, PATIENT, consentRecord],
      )
    ).rows[0].id as string;

    return {
      providerEntity,
      location,
      overlay,
      consentRecord,
      recipient,
      dpoaAgent,
      revocation,
      reminder,
      delegatedAccess,
      documentLink,
      renewalCycle,
      evalAudit,
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
    await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m39-actor@x.test')`, [USER]);
    // consent_type_catalog is the platform-shared floor consent_record.type_key + the overlay FK against.
    // Seed it once (no organization_id) as superuser.
    await db.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         capture_method_floor, reminder_cadence_floor, revocation_cascade_kind, is_per_recipient,
         is_per_named_agent, is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES ('portal_access','Portal Access','categorical',
         ARRAY['electronic_portal_signature']::text[], ARRAY['90_days']::text[],'none',
         false,false,false,false,false,true,'tmpl_portal','v1')`,
    );
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

  it("every M39 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0023_consent_m39_rls_audit_triggers.sql"),
      "utf8",
    );
    // Match only the org-scope policies (named `<table>_org`); the platform catalog's USING-only SELECT
    // policy is deliberately excluded by the `_org"` anchor.
    const policyBlocks = (
      rls.match(/CREATE POLICY "[^"]+_org"[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []
    ).filter((b) => COVERED.some((t) => b.includes(`"${t.table}"`)));
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
    async ({ table, key, idCol }) => {
      const id = a[key];
      const col = idCol ?? "id";
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("consent_record does not leak cross-tenant — org B reading org A's authorization sees nothing", async () => {
    // consent_record is the authorization document itself — a cross-tenant read is a disclosure of another
    // org's patient's release/DPOA/42-CFR-Part-2 decisions.
    const seenByB = await withOrg(ORG_B, () =>
      db.query("SELECT type_key, status FROM consent_record WHERE id=$1", [a.consentRecord]),
    );
    expect(seenByB.rowCount).toBe(0);
  });

  it("a WITH CHECK refuses a consent_record forged into another tenant", async () => {
    // A cross-tenant write would let one tenant manufacture an authorization the other org's PHI is then
    // released against — the WITH CHECK on organization_id must reject an org-A row written under org B.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO consent_record (organization_id, patient_id, type_key, scope_descriptor, grantor_kind,
             effective_at, status, capture_method, capture_evidence_jsonb, created_by_id)
           VALUES ($1,$2,'portal_access','{}'::jsonb,'patient_self', now(),'draft',
             'electronic_portal_signature','{}'::jsonb,$3)`,
          [ORG_A, PATIENT, USER],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's consent_record (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE consent_record SET status='active' WHERE id=$1", [a.consentRecord]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM consent_record WHERE id=$1", [
      a.consentRecord,
    ]);
    expect(still.rows[0].status).toBe("draft");
  });

  it("the M4 write-audit trigger fired for the consent_record writes (§3.7)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'consent_record'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
