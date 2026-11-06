/**
 * M16 Bereavement — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §9.3 / ADR-0010).
 *
 * The pure suites (apps/backend/__tests__/bereavement-*.test.ts, packages/bereavement) exercise the §2.2–2.4
 * lifecycle, the D3/D17 risk rubric and the §4.1 authz composition, but they never touch a database — so
 * they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across
 * tenants. This test applies the real migrations to a real Postgres and exercises the policies as the
 * unprivileged `chartwarden_app` role, proving cross-tenant denial for real on ALL 9 org-scoped M16 tables
 * under the canonical `organization_id = current_setting('app.org_id')` ONE-SHAPE policy (ADR-0010 D3 —
 * no second PERMISSIVE provider-entity policy; the PE/location narrowing the seven patient-bearing tables
 * carry is M3 ABAC at the handler, never a second policy that would OR rather than AND).
 *
 * `chartwarden_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies every
 * assertion below vacuously. That is asserted first, before a single isolation case runs.
 *
 * Two M16-specific cases beyond the M15 template:
 *   - `bereavement_contact_log` is PARTITIONED (§3.6 / D12). RLS is declared on the PARENT and propagates
 *     to every partition (PG11+), so the isolation case runs through the parent and would fail if a
 *     partition had somehow been created outside the policy's reach.
 *   - `bereavement_risk_score` is APPEND-ONLY (D11): the immutability trigger refuses UPDATE outright. That
 *     is asserted here as well, because "the tenant cannot update another tenant's row" and "nobody can
 *     update this row at all" are different guarantees and the ledger relies on the second one.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m16` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - The target needs **pgvector**: the chain does not merely `CREATE EXTENSION vector`, it declares
 *     COLUMNS of type `vector`, so stripping the extension DDL cannot make a plain image work. A
 *     `pgvector/pgvector:pgNN` container is the throwaway to use. `CHARTWARDEN_TEST_NO_PGVECTOR=1` removes
 *     only the extension statements, which is enough for the earlier migrations but not the whole chain.
 *   - Raise `max_locks_per_transaction` (512 is ample). `DROP SCHEMA public CASCADE` takes one lock per
 *     relation, and the chain's partitioned tables put the default 64 well out of reach.
 *
 * Verified green against a throwaway `pgvector/pgvector:pg18 -c max_locks_per_transaction=512`: 18/18.
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
/** A membership sentinel — M16 stores membership ids without a cross-module FK (M2 owns that table). */
const MEMBERSHIP = "00000000-0000-0000-0000-000000000000";

type SeedIds = {
  pe: string;
  location: string;
  plan: string;
  contact: string;
  risk: string;
  outreach: string;
  log: string;
  anniversary: string;
  closure: string;
  optOut: string;
  gateOverride: string;
  idgRiskFlag: string;
  assessmentTask: string;
  assessmentDraft: string;
  physicianLetter: string;
  mailingConfig: string;
  mailingRun: string;
  mailingItem: string;
};

/** The 9 manifest-owned M16 tables, each with the seeded row the isolation case looks for. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "bereavement_plan", key: "plan" },
  { table: "bereaved_contact", key: "contact" },
  { table: "bereavement_risk_score", key: "risk" },
  { table: "bereavement_outreach", key: "outreach" },
  { table: "bereavement_contact_log", key: "log" },
  { table: "bereavement_anniversary_reminder", key: "anniversary" },
  { table: "bereavement_plan_closure", key: "closure" },
  { table: "bereavement_opt_out", key: "optOut" },
  { table: "tenant_bereavement_external_source_gate_override", key: "gateOverride" },
  { table: "bereavement_idg_risk_flag", key: "idgRiskFlag" },
  { table: "bereavement_assessment_task", key: "assessmentTask" },
  { table: "bereavement_risk_assessment_draft", key: "assessmentDraft" },
  { table: "bereavement_physician_letter", key: "physicianLetter" },
  // ADR-0109 D10 — the mailing program (config and run are org-level; the item names a plan and a contact).
  { table: "bereavement_mailing_config", key: "mailingConfig" },
  { table: "bereavement_mailing_run", key: "mailingRun" },
  { table: "bereavement_mailing_item", key: "mailingItem" },
];

describe.skipIf(!DB_URL)("M16 Bereavement — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;

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
        // Global, and tolerant of the unquoted spelling: the chain declares the extension in BOTH forms
        // (0001 quoted, 0014 bare), so a single-match anchored regex silently leaves the second one in
        // and the escape hatch fails on a migration nobody was looking at.
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M16 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const patient = `4444444${n}-4444-4444-4444-444444444444`;
    const admission = `5555555${n}-5555-5555-5555-555555555555`;
    const pe = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00000${n}','PE','123456789${n}','enc','0930') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Main Office','1 Main St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    // `active` requires an assigned counselor AND an opened_at (§3.3.1's three CHECKs).
    const plan = (
      await db.query(
        `INSERT INTO bereavement_plan (organization_id, patient_id, admission_id, provider_entity_id,
           location_id, status, death_date, death_time, assigned_counselor_user_id,
           assigned_counselor_assigned_at, opened_at)
         VALUES ($1,$2,$3,$4,$5,'active', (now() - interval '30 days')::date, now() - interval '30 days',
           $6, now() - interval '29 days', now() - interval '29 days') RETURNING id`,
        [org, patient, admission, pe, location, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const contact = (
      await db.query(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, location_id, plan_id, status,
           display_name, relationship_code, confirmed_at)
         VALUES ($1,$2,$3,$4,'active','Survivor','spouse', now()) RETURNING id`,
        [org, pe, location, plan],
      )
    ).rows[0].id as string;
    const risk = (
      await db.query(
        `INSERT INTO bereavement_risk_score (organization_id, provider_entity_id, location_id, plan_id,
           bereaved_contact_id, score_kind, risk_factors_jsonb, rule_score, rule_tier, data_completeness,
           confidence_band)
         VALUES ($1,$2,$3,$4,$5,'rule_deterministic','{"social_isolation":true}'::jsonb, 18,'moderate',
           'partial','MEDIUM') RETURNING id`,
        [org, pe, location, plan, contact],
      )
    ).rows[0].id as string;
    // The D4 ceiling CHECK is `due_at - death_anchor_at BETWEEN 0 AND 426` days, so the anchor is the plan's
    // death instant and the touchpoint sits inside the window.
    const outreach = (
      await db.query(
        `INSERT INTO bereavement_outreach (organization_id, provider_entity_id, location_id, plan_id,
           bereaved_contact_id, kind, status, anniversary_mark, death_anchor_at, due_at, late_grace_until,
           completed_at)
         VALUES ($1,$2,$3,$4,$5,'phone_call','completed','one_month', now() - interval '30 days',
           now() - interval '1 day', now() + interval '6 days', now()) RETURNING id`,
        [org, pe, location, plan, contact],
      )
    ).rows[0].id as string;
    const log = (
      await db.query(
        `INSERT INTO bereavement_contact_log (organization_id, provider_entity_id, location_id, plan_id,
           bereaved_contact_id, outreach_id, contact_at, kind, outcome, logged_by_user_id,
           contact_responded_directly)
         VALUES ($1,$2,$3,$4,$5,$6, now(),'phone_call','engaged',$7,true) RETURNING id`,
        [org, pe, location, plan, contact, outreach, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const anniversary = (
      await db.query(
        `INSERT INTO bereavement_anniversary_reminder (organization_id, provider_entity_id, location_id,
           plan_id, mark, target_date)
         VALUES ($1,$2,$3,$4,'anniversary', (now() + interval '335 days')::date) RETURNING id`,
        [org, pe, location, plan],
      )
    ).rows[0].id as string;
    // `thirteen_month_completion` is one of the four system-driven reasons: cosign-exempt and
    // narrative-exempt, which is exactly why it is the reason a seed row can legally carry.
    const closure = (
      await db.query(
        `INSERT INTO bereavement_plan_closure (organization_id, provider_entity_id, location_id, plan_id,
           reason, close_kind, outreach_completed_count, outreach_missed_count, contacts_active_count,
           contacts_opted_out_count)
         VALUES ($1,$2,$3,$4,'thirteen_month_completion','auto',5,0,1,0) RETURNING id`,
        [org, pe, location, plan],
      )
    ).rows[0].id as string;
    const optOut = (
      await db.query(
        `INSERT INTO bereavement_opt_out (organization_id, provider_entity_id, location_id,
           bereaved_contact_id, plan_id, opt_out_kind, source_kind, recorded_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'full','counselor_recorded',$6) RETURNING id`,
        [org, pe, location, contact, plan, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const gateOverride = (
      await db.query(
        `INSERT INTO tenant_bereavement_external_source_gate_override (organization_id,
           require_death_certificate_uploaded, configured_by_membership_id)
         VALUES ($1,true,$2) RETURNING id`,
        [org, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const idgRiskFlag = (
      await db.query(
        `INSERT INTO bereavement_idg_risk_flag (organization_id, idg_decision_id, idg_meeting_id,
           patient_id, risk_level, rationale_text, recorded_by_membership_id, recorded_at)
         VALUES ($1,$2,$3,$4,'high','clinical rationale',$5,now()) RETURNING id`,
        [
          org,
          `9999999${n}-9999-4999-8999-999999999999`,
          `aaaaaaa${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          patient,
          MEMBERSHIP,
        ],
      )
    ).rows[0].id as string;
    const assessmentTask = (
      await db.query(
        `INSERT INTO bereavement_assessment_task (organization_id, provider_entity_id, location_id, plan_id,
           bereaved_contact_id, task_kind, status, due_at, late_grace_until)
         VALUES ($1,$2,$3,$4,$5,'initial_assessment','scheduled', now() + interval '2 days',
           now() + interval '9 days') RETURNING id`,
        [org, pe, location, plan, contact],
      )
    ).rows[0].id as string;
    // A pre-death draft keys on the ADMISSION and exists before any plan (no FK to one).
    const assessmentDraft = (
      await db.query(
        `INSERT INTO bereavement_risk_assessment_draft (organization_id, provider_entity_id, location_id,
           patient_id, admission_id, last_edited_by_membership_id, last_edited_discipline)
         VALUES ($1,$2,$3,$4,$5,$6,'medical_social_worker') RETURNING id`,
        [org, pe, location, patient, `6666666${n}-6666-4666-8666-666666666666`, MEMBERSHIP],
      )
    ).rows[0].id as string;
    // ADR-0109 D6 — the plan's physician condolence letter (one per plan).
    const physicianLetter = (
      await db.query(
        `INSERT INTO bereavement_physician_letter (organization_id, provider_entity_id, location_id, plan_id,
           patient_id, due_at)
         VALUES ($1,$2,$3,$4,$5, now() + interval '2 days') RETURNING id`,
        [org, pe, location, plan, patient],
      )
    ).rows[0].id as string;
    // ADR-0109 D10 — one config, one run and one item of that run.
    const mailingConfig = (
      await db.query(
        `INSERT INTO bereavement_mailing_config (organization_id, mailing_key, enabled, configured_by_membership_id)
         VALUES ($1,'newsletter_quarterly',true,$2) RETURNING id`,
        [org, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const mailingRun = (
      await db.query(
        `INSERT INTO bereavement_mailing_run (organization_id, run_kind, mailing_key, occurrence_key, scheduled_for, content_jsonb)
         VALUES ($1,'newsletter','newsletter_quarterly','newsletter_quarterly:2026-Q4','2026-10-15','{}'::jsonb) RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const mailingItem = (
      await db.query(
        `INSERT INTO bereavement_mailing_item (organization_id, provider_entity_id, location_id, run_id, plan_id,
           bereaved_contact_id, channel, status)
         VALUES ($1,$2,$3,$4,$5,$6,'postal','included') RETURNING id`,
        [org, pe, location, mailingRun, plan, contact],
      )
    ).rows[0].id as string;
    return {
      pe,
      location,
      plan,
      contact,
      risk,
      outreach,
      log,
      anniversary,
      closure,
      optOut,
      gateOverride,
      idgRiskFlag,
      assessmentTask,
      assessmentDraft,
      physicianLetter,
      mailingConfig,
      mailingRun,
      mailingItem,
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
    a = await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M16 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    const rls = [
      "0102_bereavement_m16_rls_audit_triggers.sql",
      "0168_idg_downstream_consumer_projections.sql",
      "1342_m16_assessment_task.sql",
      "1343_m16_risk_assessment_draft.sql",
      "1345_m16_physician_letter.sql",
      "1374_m16_mailings.sql",
    ]
      .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (block) => COVERED.some(({ table }) => block.includes(`"${table}"`)),
    );
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
      // The PE narrowing the patient-bearing tables carry is ABAC at the handler, never a second pivot.
      expect(block).not.toMatch(/provider_entity_id\s*=/i);
    }
  });

  it("RLS is ENABLED and FORCEd on every owned table (a table-owner read would otherwise skip the policy)", async () => {
    const { rows } = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind IN ('r','p')`,
      [COVERED.map((c) => c.table)],
    );
    expect(rows).toHaveLength(COVERED.length);
    for (const r of rows) expect(r.relrowsecurity).toBe(true);
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
      expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
    },
  );

  it("a contact-log PARTITION cannot be addressed directly by chartwarden_app (the leaf carries no grant)", async () => {
    // PostgreSQL applies the PARENT's policy to a query routed THROUGH the parent, but a leaf addressed by
    // name is governed by its own `relrowsecurity` — and `CREATE TABLE … PARTITION OF` gives a leaf neither
    // the parent's policies nor the parent's ACL. So the leaf's protection is the GRANT layer, not RLS, and
    // that is what has to be asserted: an assertion that leaves inherit RLS would pass only by accident on
    // a database where someone had enabled it leaf-by-leaf, and would say nothing about the real defense.
    const leaves = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'bereavement_contact_log' ORDER BY c.relname`,
    );
    expect(leaves.rows.length).toBeGreaterThan(0); // the DEFAULT plus the seeded monthly leaves

    const granted = await db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_app' AND table_name = ANY($1)`,
      [leaves.rows.map((r) => r.relname)],
    );
    expect(granted.rows.map((r) => r.table_name)).toEqual([]);

    // And empirically: naming a leaf directly is refused outright.
    const leaf = leaves.rows[0]?.relname as string;
    await expect(withOrg(ORG_B, () => db.query(`SELECT 1 FROM ${leaf} LIMIT 1`))).rejects.toThrow();
  });

  it("the contact log read THROUGH the parent is tenant-scoped across every partition", async () => {
    // The read that matters: the app only ever queries the parent, and the parent's policy prunes to the
    // caller's org no matter which monthly leaf the row landed in.
    const asA = await withOrg(ORG_A, () =>
      db.query<{ n: number }>("SELECT count(*)::int AS n FROM bereavement_contact_log"),
    );
    const asB = await withOrg(ORG_B, () =>
      db.query<{ n: number }>("SELECT count(*)::int AS n FROM bereavement_contact_log"),
    );
    expect(asA.rows[0].n).toBe(1);
    expect(asB.rows[0].n).toBe(1); // each org sees ONLY its own seeded log row
  });

  it("an UPDATE from the wrong tenant touches zero rows (not just an unreadable SELECT)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE bereaved_contact SET display_name = 'tampered' WHERE id=$1", [a.contact]),
    );
    expect(res.rowCount).toBe(0);
    const check = await db.query("SELECT display_name FROM bereaved_contact WHERE id=$1", [
      a.contact,
    ]);
    expect(check.rows[0].display_name).toBe("Survivor");
  });

  it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name,
             relationship_code)
           VALUES ($1,$2,$3,'Injected','friend')`,
          [ORG_A, a.pe, a.plan], // B tries to write a row scoped to A
        ),
      ),
    ).rejects.toThrow();
  });

  it("the risk-score ledger is append-only — UPDATE is refused for the OWNING tenant too (D11)", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE bereavement_risk_score SET rule_tier = 'low' WHERE id=$1", [a.risk]),
      ),
    ).rejects.toThrow();
    const check = await db.query("SELECT rule_tier FROM bereavement_risk_score WHERE id=$1", [
      a.risk,
    ]);
    expect(check.rows[0].rule_tier).toBe("moderate");
  });

  it("an assessment task is `completed` only with the human score and instant that completed it (CHECK)", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE bereavement_assessment_task SET status = 'completed' WHERE id=$1", [
          a.assessmentTask,
        ]),
      ),
    ).rejects.toThrow(/berv_assessment_task_completion_chk/);
    const done = await withOrg(ORG_A, () =>
      db.query(
        `UPDATE bereavement_assessment_task SET status = 'completed', completed_at = now(), risk_score_id = $2
         WHERE id=$1`,
        [a.assessmentTask, a.risk],
      ),
    );
    expect(done.rowCount).toBe(1);
  });

  it("the assessment-task ledger holds one checkpoint of each kind per contact", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO bereavement_assessment_task (organization_id, provider_entity_id, plan_id,
             bereaved_contact_id, task_kind, due_at, late_grace_until)
           VALUES ($1,$2,$3,$4,'initial_assessment', now(), now())`,
          [ORG_A, a.pe, a.plan, a.contact],
        ),
      ),
    ).rejects.toThrow(/berv_assessment_task_contact_kind_uniq/);
  });

  it("a pre-death draft defaults to eight unknowns, pins its key set and is one per admission", async () => {
    const defaults = await db.query(
      "SELECT factors_jsonb FROM bereavement_risk_assessment_draft WHERE id=$1",
      [a.assessmentDraft],
    );
    expect(Object.keys(defaults.rows[0].factors_jsonb).sort()).toEqual(
      [
        "activeSubstanceUse",
        "ambivalentRelationship",
        "financialStrain",
        "preExistingMentalHealth",
        "priorUnresolvedLoss",
        "primaryCaregiverRole",
        "socialIsolation",
        "suddenUnexpectedDeath",
      ].sort(),
    );
    expect(Object.values(defaults.rows[0].factors_jsonb)).toEqual(Array(8).fill("unknown"));
    // a vector that drops a key (or is not an object) is refused by the CHECK
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          "UPDATE bereavement_risk_assessment_draft SET factors_jsonb = '{\"financialStrain\": true}'::jsonb WHERE id=$1",
          [a.assessmentDraft],
        ),
      ),
    ).rejects.toThrow(/berv_assessment_draft_factors_chk/);
    // a draft is carried with BOTH the score and the instant, or neither
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE bereavement_risk_assessment_draft SET carried_at = now() WHERE id=$1", [
          a.assessmentDraft,
        ]),
      ),
    ).rejects.toThrow(/berv_assessment_draft_carried_chk/);
    // one draft per (organization, admission)
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO bereavement_risk_assessment_draft (organization_id, provider_entity_id, patient_id,
             admission_id, last_edited_by_membership_id, last_edited_discipline)
           VALUES ($1,$2,$3,'66666661-6666-4666-8666-666666666666',$4,'chaplain')`,
          [ORG_A, a.pe, "44444441-4444-4444-4444-444444444444", MEMBERSHIP],
        ),
      ),
    ).rejects.toThrow(/berv_assessment_draft_admission_uniq/);
  });

  it("a physician letter pins its lifecycle: one per plan, a reviewer on every decision, a recipient before approval", async () => {
    // pending_review names no reviewer; any other status must
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE bereavement_physician_letter SET status='declined' WHERE id=$1", [
          a.physicianLetter,
        ]),
      ),
    ).rejects.toThrow(/berv_physician_letter_review_chk/);
    // an approved letter goes to an internal clinician and carries the render request instant
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `UPDATE bereavement_physician_letter SET status='approved', reviewed_at=now(),
             reviewed_by_membership_id=$2, m22_render_requested_at=now() WHERE id=$1`,
          [a.physicianLetter, MEMBERSHIP],
        ),
      ),
    ).rejects.toThrow(/berv_physician_letter_attending_chk/);
    // a decline reason is prose of at least 20 characters, and only a declined letter carries one
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `UPDATE bereavement_physician_letter SET status='declined', reviewed_at=now(),
             reviewed_by_membership_id=$2, decline_reason_redacted='too short' WHERE id=$1`,
          [a.physicianLetter, MEMBERSHIP],
        ),
      ),
    ).rejects.toThrow(/berv_physician_letter_decline_chk/);
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE bereavement_physician_letter SET decline_reason_redacted=$2 WHERE id=$1", [
          a.physicianLetter,
          "x".repeat(25),
        ]),
      ),
    ).rejects.toThrow(/berv_physician_letter_decline_chk/);
    // a sealed note rides only an approved or rendered letter
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          "UPDATE bereavement_physician_letter SET personal_note_cipher='v1.x' WHERE id=$1",
          [a.physicianLetter],
        ),
      ),
    ).rejects.toThrow(/berv_physician_letter_note_chk/);
    // the whole legal path: decline with a real reason, and the audit row scrubs it
    await withOrg(ORG_A, () =>
      db.query(
        `UPDATE bereavement_physician_letter SET status='declined', reviewed_at=now(),
           reviewed_by_membership_id=$2, decline_reason_redacted=$3, version=version+1 WHERE id=$1`,
        [a.physicianLetter, MEMBERSHIP, "The attending retired last spring."],
      ),
    );
    const audit = await db.query(
      `SELECT after FROM audit_event WHERE resource_kind='bereavement_physician_letter' AND resource_id=$1
       ORDER BY created_at DESC LIMIT 1`,
      [a.physicianLetter],
    );
    expect(audit.rows[0].after.status).toBe("declined");
    expect(JSON.stringify(audit.rows[0].after)).not.toContain("retired last spring");
    // one letter per plan
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO bereavement_physician_letter (organization_id, provider_entity_id, plan_id, patient_id, due_at)
           SELECT organization_id, provider_entity_id, plan_id, patient_id, due_at FROM bereavement_physician_letter WHERE id=$1`,
          [a.physicianLetter],
        ),
      ),
    ).rejects.toThrow(/berv_physician_letter_plan_uniq/);
  });

  it("a contact-log ACTIVITY row (no outreach, no kind) is tenant-scoped through the parent like any other log row (1373)", async () => {
    await db.query(
      `INSERT INTO bereavement_contact_log (organization_id, provider_entity_id, location_id, plan_id, bereaved_contact_id,
         contact_at, outcome, activity_kind, activity_ref_id, logged_by_user_id)
       VALUES ($1,$2,$3,$4,$5, now(), 'mailed', 'newsletter_mailing', $6, $7)`,
      [ORG_A, a.pe, a.location, a.plan, a.contact, a.mailingRun, MEMBERSHIP],
    );
    const count = (org: string) =>
      withOrg(org, () =>
        db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM bereavement_contact_log WHERE activity_kind IS NOT NULL AND outreach_id IS NULL AND kind IS NULL",
        ),
      );
    expect((await count(ORG_A)).rows[0].n).toBe(1);
    expect((await count(ORG_B)).rows[0].n).toBe(0);
    await db.query("DELETE FROM bereavement_contact_log WHERE activity_kind IS NOT NULL");
  });

  it("a mailing run pins its lifecycle: one run per occurrence, a rendered batch before ready, a mailer before mailed, a reason on every excluded item (1374)", async () => {
    const run = (status: string, over = "") =>
      db.query(
        `INSERT INTO bereavement_mailing_run (organization_id, run_kind, mailing_key, occurrence_key, scheduled_for, status, content_jsonb ${over ? ", rendered_document_id, mailed_at, mailed_by_membership_id, failure_code" : ""})
         VALUES ($1,'newsletter','newsletter_quarterly',$2,'2026-10-15',$3,'{}'::jsonb ${over})`,
        [ORG_A, `k-${status}-${Math.random()}`, status],
      );
    await expect(
      db.query(
        `INSERT INTO bereavement_mailing_run (organization_id, run_kind, mailing_key, occurrence_key, scheduled_for, content_jsonb)
         VALUES ($1,'newsletter','newsletter_quarterly','newsletter_quarterly:2026-Q4','2026-10-15','{}'::jsonb)`,
        [ORG_A],
      ),
    ).rejects.toThrow(/berv_mailing_run_occurrence_uniq/);
    await expect(run("ready")).rejects.toThrow(/berv_mailing_run_ready_chk/);
    await expect(run("mailed", ", gen_random_uuid(), NULL, NULL, NULL")).rejects.toThrow(/berv_mailing_run_mailed_chk/);
    await expect(run("failed")).rejects.toThrow(/berv_mailing_run_failed_chk/);
    const item = (status: string, reason: string | null) =>
      db.query(
        `INSERT INTO bereavement_mailing_item (organization_id, provider_entity_id, run_id, plan_id, bereaved_contact_id, channel, status, exclusion_reason)
         SELECT $1, i.provider_entity_id, i.run_id, i.plan_id, c.id, 'postal', $2, $3
           FROM bereavement_mailing_item i, bereaved_contact c WHERE i.id=$4 AND c.id <> i.bereaved_contact_id LIMIT 1`,
        [ORG_A, status, reason, a.mailingItem],
      );
    // a second contact is needed for the (run, contact) key: reuse the org's own contact via a fresh row
    await db.query(
      `INSERT INTO bereaved_contact (organization_id, provider_entity_id, location_id, plan_id, status, display_name, relationship_code)
       VALUES ($1,$2,$3,$4,'active','Second','child')`,
      [ORG_A, a.pe, a.location, a.plan],
    );
    await expect(item("excluded", null)).rejects.toThrow(/berv_mailing_item_excluded_chk/);
    await expect(item("included", "no_mailings")).rejects.toThrow(/berv_mailing_item_excluded_chk/);
    await expect(item("excluded", "because")).rejects.toThrow(/berv_mailing_item_reason_chk/);
    await expect(
      db.query(
        `INSERT INTO bereavement_mailing_item (organization_id, provider_entity_id, run_id, plan_id, bereaved_contact_id, channel, status)
         SELECT organization_id, provider_entity_id, run_id, plan_id, bereaved_contact_id, 'postal', 'included' FROM bereavement_mailing_item WHERE id=$1`,
        [a.mailingItem],
      ),
    ).rejects.toThrow(/berv_mailing_item_run_contact_uniq/);
    await expect(
      db.query("UPDATE bereavement_mailing_config SET lead_days = 2 WHERE id=$1", [a.mailingConfig]),
    ).rejects.toThrow(/berv_mailing_config_lead_chk/);
  });

  it("the destruction role holds DELETE on mailing items only (1376), and chartwarden_app holds no DELETE on any mailing table", async () => {
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_destruction' AND table_name LIKE 'bereavement_mailing_%' ORDER BY table_name, privilege_type`,
    );
    expect(rows).toEqual([
      { table_name: "bereavement_mailing_item", privilege_type: "DELETE" },
      { table_name: "bereavement_mailing_item", privilege_type: "SELECT" },
    ]);
    const policy = await db.query<{ qual: string }>(
      "SELECT qual FROM pg_policies WHERE tablename='bereavement_mailing_item' AND policyname='bereavement_mailing_item_destruction'",
    );
    expect(policy.rows[0]?.qual).toContain("app.org_id");
  });

  it("chartwarden_app holds no DELETE on the M16 tables — destruction runs through the eraser (§8.5)", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_app' AND privilege_type='DELETE' AND table_name = ANY($1)`,
      [COVERED.map((c) => c.table)],
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
