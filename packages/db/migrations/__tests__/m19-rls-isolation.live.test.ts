/**
 * M19 On-Call Triage — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §9.3 / ADR-0010).
 *
 * The pure suites (apps/backend/__tests__/oncall-*.test.ts) exercise the §2.2.1 call machine, the D5
 * protocol gate, the D6 disposition matrix, the D7 escalation ladder and the §4.1 authz composition, but
 * they never touch a database — so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or a
 * grant that lets a tenant edit the platform floor. This test applies the real migrations to a real
 * Postgres and exercises the policies as the unprivileged `wardenx_app` role.
 *
 * `wardenx_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies
 * every assertion below vacuously. That is asserted FIRST, before a single isolation case runs (the
 * M15-T07 lesson).
 *
 * M19 IS TWO POLICY SHAPES, NOT ONE, and each needs a different proof (§3.5):
 *
 *   1. **Eight canonical org-scoped tables** — `FOR ALL` on `organization_id = current_setting('app.org_id')`.
 *      Ordinary cross-tenant denial.
 *   2. **Two floor-plus-overlay tables** (`triage_protocol`, `triage_protocol_question`) — the 28
 *      platform-floor protocols migration 0109 seeds are ORG-LESS and `is_system_locked`, readable inside
 *      every tenant and writable by none. Split by COMMAND on purpose: two permissive `FOR ALL` policies on
 *      one table would OR together, which is the shape ADR-0010 D3 forbids. So the proof is three-sided —
 *      the floor is visible to both tenants, neither can UPDATE it, and neither can INSERT a new locked or
 *      org-less row.
 *
 * THE FLOOR PROOF IS THE POINT OF THIS FILE, not a bonus case. D7 makes four platform protocols
 * (`unresponsive_patient`, `suicidal_ideation`, `suspected_abuse_neglect`,
 * `emergency_drug_request_unfulfillable`) escalate mandatorily, and §8.3.2 names "alter the tenant
 * configuration to lower a mandatory-escalation tier" as the tampering threat. The service refuses first,
 * with the protocol named; these policies are what still stands when a route is added carelessly. An agency
 * under staffing pressure must not be able to clear the flag on a row it has no policy to write.
 *
 * TWO GRANT ASYMMETRIES ALSO GET THEIR OWN CASES, because each encodes a rule that is otherwise only a
 * code-review convention:
 *   • `triage_call_answer` and `triage_call_state_history` carry SELECT + INSERT and NO UPDATE. §2.2.3
 *     makes a correction a NEW row (a "no" later corrected to "yes" means the call HAD a red flag, and
 *     that is what a suppression investigation reads), and the transition ledger is what §2.7 reconstructs
 *     an outage window from. Withholding UPDATE makes an in-place rewrite a permission error.
 *   • NO M19 table grants DELETE to `wardenx_app` at all. Destruction runs through the M4 eraser under
 *     `wardenx_admin`, never through a request.
 *
 * NOTHING IN M19 IS PARTITIONED, and that is deliberate rather than an omission: a partition key would have
 * had to join every UNIQUE index, which would have destroyed both the D10 inbound-event redelivery guard
 * (one call per source event, forever) and the one-original-answer rule. So there is no partition-leaf case
 * here — there are no leaves.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m19` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - The target needs **pgvector**: the chain declares COLUMNS of type `vector`, so stripping the
 *     extension DDL cannot make a plain image work. Use `pgvector/pgvector:pgNN`.
 *   - Raise `max_locks_per_transaction` (512 is ample) — `DROP SCHEMA public CASCADE` takes one lock per
 *     relation and the chain's partitioned tables (other modules') put the default 64 well out of reach.
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

/** Two platform-floor rows migration 0109 seeds on deterministic ids. The second is one of D7's four
 *  mandatory-escalation protocols, which is the row the tamper case aims at. */
const FLOOR_PROTOCOL = "00000000-0019-0000-0000-000000000001";

type SeedIds = {
  pe: string;
  location: string;
  user: string;
  membership: string;
  policy: string;
  vendor: string;
  shift: string;
  protocol: string;
  question: string;
  call: string;
  answer: string;
  escalation: string;
  history: string;
  worklist: string;
};

/** The 10 org-scoped M19 tables, each with the seeded row the isolation case looks for. The two
 *  floor-plus-overlay tables appear here with the row a TENANT authored — their platform-floor half is
 *  proved separately, because "every tenant sees it" is the CORRECT outcome for those rows. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "tenant_oncall_policy", key: "policy" },
  { table: "external_triage_vendor", key: "vendor" },
  { table: "on_call_shift", key: "shift" },
  { table: "triage_protocol", key: "protocol" },
  { table: "triage_protocol_question", key: "question" },
  { table: "triage_call", key: "call" },
  { table: "triage_call_answer", key: "answer" },
  { table: "triage_escalation", key: "escalation" },
  { table: "triage_call_state_history", key: "history" },
  { table: "triage_paper_reentry_worklist", key: "worklist" },
];

const ALL_TABLES = COVERED.map((c) => c.table);

/** The two append-only ledgers (§2.2.3 / §2.7) — SELECT + INSERT, never UPDATE. */
const APPEND_ONLY = ["triage_call_answer", "triage_call_state_history"];

describe.skipIf(!DB_URL)("M19 On-Call Triage — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;

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
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M19 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const pe = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00019${n}','PE','19345678${n}','enc','0930') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Branch','1 Main St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    // A REAL membership: unlike M21, M19's attribution columns carry SQL foreign keys to `membership`.
    const user = (
      await db.query(`INSERT INTO "user" (email) VALUES ('m19-actor-${n}@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;

    const policy = (
      await db.query(
        `INSERT INTO tenant_oncall_policy (organization_id, provider_entity_id, model, escalation_tiers,
           callback_sla_per_severity)
         VALUES ($1,$2,'direct','{}'::jsonb,'{}'::jsonb) RETURNING id`,
        [org, pe],
      )
    ).rows[0].id as string;
    const vendor = (
      await db.query(
        `INSERT INTO external_triage_vendor (organization_id, mdm_vendor_id, name, adapter_key,
           rn_coverage_attested, baa_in_effect, default_minimization_policy)
         VALUES ($1, gen_random_uuid(), 'Night desk ${n}', 'demo', true, true,
                 '{"profile":"hybrid_phi_min"}'::jsonb) RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const shift = (
      await db.query(
        // An `active` shift MUST carry `opened_at` (§2.2.2's CHECK): "on call" is a fact about a moment a
        // named clinician went on, not a status somebody set.
        `INSERT INTO on_call_shift (organization_id, provider_entity_id, shift_starts_at, shift_ends_at,
           discipline, primary_on_call_membership_id, policy_snapshot, status, opened_at)
         VALUES ($1,$2, now() - interval '1 hour', now() + interval '11 hours', 'clinical_rn', $3,
                 '{}'::jsonb, 'active', now() - interval '1 hour') RETURNING id`,
        [org, pe, membership],
      )
    ).rows[0].id as string;
    // A TENANT protocol: org-bearing and NOT locked (the CHECK pair makes the other combination impossible,
    // which is what keeps a nullable organization_id safe).
    const protocol = (
      await db.query(
        `INSERT INTO triage_protocol (organization_id, key, chief_complaint_label, snomed_code,
           discipline_required, is_system_locked, effective_from)
         VALUES ($1,'tenant_anxiety_${n}','Anxiety / panic','48694002','clinical_rn', false,
                 now() - interval '1 day') RETURNING id`,
        [org],
      )
    ).rows[0].id as string;
    const question = (
      await db.query(
        `INSERT INTO triage_protocol_question (triage_protocol_id, organization_id, question_order, prompt,
           answer_type, required, is_red_flag_question, red_flag_match, is_system_locked)
         VALUES ($1,$2,1,'Is the patient safe right now?','boolean', true, true,
                 '{"kind":"bool_is","value":false}'::jsonb, false) RETURNING id`,
        [protocol, org],
      )
    ).rows[0].id as string;
    const call = (
      await db.query(
        `INSERT INTO triage_call (organization_id, provider_entity_id, location_id, on_call_shift_id,
           caller_kind, inbound_channel, source, state, selected_protocol_id, selected_protocol_version)
         VALUES ($1,$2,$3,$4,'caregiver','phone','manual','protocol_in_progress',$5,'1.0') RETURNING id`,
        [org, pe, location, shift, protocol],
      )
    ).rows[0].id as string;
    const answer = (
      await db.query(
        `INSERT INTO triage_call_answer (organization_id, provider_entity_id, location_id, triage_call_id,
           triage_protocol_question_id, answer_value_bool, red_flag_hit, answered_by_membership_id)
         VALUES ($1,$2,$3,$4,$5, false, true, $6) RETURNING id`,
        [org, pe, location, call, question, membership],
      )
    ).rows[0].id as string;
    const escalation = (
      await db.query(
        `INSERT INTO triage_escalation (organization_id, provider_entity_id, location_id, triage_call_id,
           tier, trigger_kind, escalated_to_membership_id)
         VALUES ($1,$2,$3,$4,'tier_1_rn_supervisor','red_flag_question',$5) RETURNING id`,
        [org, pe, location, call, membership],
      )
    ).rows[0].id as string;
    const history = (
      await db.query(
        `INSERT INTO triage_call_state_history (organization_id, provider_entity_id, location_id,
           triage_call_id, from_state, to_state, actor_membership_id)
         VALUES ($1,$2,$3,$4,'open','protocol_in_progress',$5) RETURNING id`,
        [org, pe, location, call, membership],
      )
    ).rows[0].id as string;
    const worklist = (
      await db.query(
        `INSERT INTO triage_paper_reentry_worklist (organization_id, provider_entity_id, location_id,
           outage_window_id, shift_id, shift_starts_at, shift_ends_at, assigned_to_membership_id, expires_at)
         VALUES ($1,$2,$3, gen_random_uuid(), $4, now() - interval '12 hours', now() - interval '1 hour',
                 $5, now() + interval '72 hours') RETURNING id`,
        [org, pe, location, shift, membership],
      )
    ).rows[0].id as string;

    return {
      pe,
      location,
      user,
      membership,
      policy,
      vendor,
      shift,
      protocol,
      question,
      call,
      answer,
      escalation,
      history,
      worklist,
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
  }, 180_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M19 policy keys ONLY on app.org_id (no subqueries / pg_has_role / second pivot)", () => {
    const rls = readFileSync(join(MIGRATIONS_DIR, "0108_oncall_m19_rls_audit_triggers.sql"), "utf8");
    const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?(?:WITH CHECK \([^;]*\)|USING \([^;]*\));/g) ?? [];
    // 8 canonical org policies + 2 floor-plus-overlay tables × 3 command-split policies.
    expect(policyBlocks.length).toBe(14);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
      expect(vars.length).toBeGreaterThan(0);
      for (const v of vars) expect(v).toBe("app.org_id");
      expect(block).not.toMatch(/pg_has_role/i);
      // No EXISTS-subquery tenancy: tenancy is a column, never a join (ADR-0010 D2). A parent-join policy
      // on `triage_call_answer` would have been the obvious shape and is exactly what the denormalized
      // organization_id on every child row exists to avoid.
      expect(block).not.toMatch(/EXISTS\s*\(/i);
      // The PE / Location narrowing is M3 ABAC at the handler, never a second pivot that would OR rather
      // than AND with the org predicate.
      expect(block).not.toMatch(/provider_entity_id\s*=/i);
    }
  });

  it("RLS is ENABLED on every one of the 10 owned tables", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind IN ('r','p')`,
      [ALL_TABLES],
    );
    expect(rows).toHaveLength(ALL_TABLES.length);
    for (const r of rows) expect(r.relrowsecurity).toBe(true);
  });

  it("NOTHING in M19 is partitioned — the D10 redelivery guard and the one-answer rule depend on it", async () => {
    const { rows } = await db.query<{ relname: string; relkind: string }>(
      `SELECT relname, relkind FROM pg_class WHERE relname = ANY($1)`,
      [ALL_TABLES],
    );
    expect(rows).toHaveLength(ALL_TABLES.length);
    // 'p' would be a partitioned parent. A partition key must join every UNIQUE index, and the two indexes
    // that matter here — one call per inbound source event, one original answer per question — are exactly
    // the ones a partition key would have broken.
    for (const r of rows) expect(r.relkind).toBe("r");
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
    },
  );

  it("the 28-protocol platform floor is readable inside EVERY tenant", async () => {
    for (const org of [ORG_A, ORG_B]) {
      const seen = await withOrg(org, () =>
        db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM triage_protocol WHERE organization_id IS NULL AND is_system_locked = true",
        ),
      );
      // §1.1 requires ≥ 25; the seed ships 28. Asserting the floor rather than the exact count keeps this
      // case about VISIBILITY, so adding a protocol does not read as an isolation regression.
      expect(seen.rows[0].n).toBeGreaterThanOrEqual(25);
    }
  });

  it("a tenant cannot UPDATE a platform-floor protocol — the D7 mandatory escalations are undisableable", async () => {
    const before = await db.query<{ requires_mandatory_escalation: boolean; chief_complaint_label: string }>(
      "SELECT requires_mandatory_escalation, chief_complaint_label FROM triage_protocol WHERE id=$1",
      [FLOOR_PROTOCOL],
    );
    expect(before.rows).toHaveLength(1);
    // The UPDATE policy's USING clause excludes `is_system_locked = true`, so this touches zero rows rather
    // than raising — the same outcome for the caller and a stronger one for the record.
    const res = await withOrg(ORG_A, () =>
      db.query(
        "UPDATE triage_protocol SET requires_mandatory_escalation = false, chief_complaint_label='tampered' WHERE id=$1",
        [FLOOR_PROTOCOL],
      ),
    );
    expect(res.rowCount).toBe(0);
    const after = await db.query<{ requires_mandatory_escalation: boolean; chief_complaint_label: string }>(
      "SELECT requires_mandatory_escalation, chief_complaint_label FROM triage_protocol WHERE id=$1",
      [FLOOR_PROTOCOL],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("a tenant cannot clear a red flag on a system-locked question — the cheapest way to disable an escalation", async () => {
    const locked = await db.query<{ id: string }>(
      `SELECT q.id FROM triage_protocol_question q
       WHERE q.is_system_locked = true AND q.is_red_flag_question = true
       ORDER BY q.id LIMIT 1`,
    );
    expect(locked.rows).toHaveLength(1);
    const id = locked.rows[0].id;
    const res = await withOrg(ORG_A, () =>
      db.query(
        "UPDATE triage_protocol_question SET is_red_flag_question = false, red_flag_match = NULL WHERE id=$1",
        [id],
      ),
    );
    expect(res.rowCount).toBe(0);
    const after = await db.query<{ is_red_flag_question: boolean }>(
      "SELECT is_red_flag_question FROM triage_protocol_question WHERE id=$1",
      [id],
    );
    expect(after.rows[0].is_red_flag_question).toBe(true);
  });

  it("a tenant cannot INSERT a locked or org-less protocol (or question) — it cannot mint a floor row", async () => {
    // Two gates deep: the §4.2 TypeBox omits `isSystemLocked` AND the WITH CHECK refuses it. This proves
    // the second one, which is the gate that still stands if a route is ever added carelessly.
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO triage_protocol (organization_id, key, chief_complaint_label, snomed_code,
             discipline_required, is_system_locked, effective_from)
           VALUES ($1,'injected_floor','Injected','74964007','clinical_rn', true, now())`,
          [ORG_A],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO triage_protocol (organization_id, key, chief_complaint_label, snomed_code,
             discipline_required, is_system_locked, effective_from)
           VALUES (NULL,'orgless_injected','Injected','74964007','clinical_rn', false, now())`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO triage_protocol_question (triage_protocol_id, organization_id, question_order,
             prompt, answer_type, is_system_locked)
           VALUES ($1,$2,99,'Injected locked question','boolean', true)`,
          [FLOOR_PROTOCOL, ORG_A],
        ),
      ),
    ).rejects.toThrow();
  });

  it("a tenant cannot attach a question to the ORG-LESS platform parent", async () => {
    // §4.1's "additive only on platform protocols" is NOT implemented as an exception: an unlocked,
    // org-bearing child under an org-less parent is refused by the parent's own CHECK pair / policy, which
    // is why the route refuses first with the protocol NAMED rather than letting a policy violation surface.
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO triage_protocol_question (triage_protocol_id, organization_id, question_order,
             prompt, answer_type)
           VALUES ($1, NULL, 98,'Injected orphan question','boolean')`,
          [FLOOR_PROTOCOL],
        ),
      ),
    ).rejects.toThrow();
  });

  it.each(APPEND_ONLY)(
    "%s is APPEND-ONLY: wardenx_app holds SELECT + INSERT and no UPDATE",
    async (table) => {
      const { rows } = await db.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee='wardenx_app' AND table_name=$1`,
        [table],
      );
      expect([...new Set(rows.map((r) => r.privilege_type))].sort()).toEqual(["INSERT", "SELECT"]);
    },
  );

  it("no M19 table grants DELETE to wardenx_app — destruction runs through the M4 eraser", async () => {
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee='wardenx_app' AND table_name = ANY($1) AND privilege_type IN ('DELETE','TRUNCATE')`,
      [ALL_TABLES],
    );
    expect(rows).toEqual([]);
  });

  it("a tenant cannot INSERT a row carrying ANOTHER org's id (the WITH CHECK half)", async () => {
    // A USING-only policy would let org A write a row stamped org B and then be unable to see it — the row
    // would still exist in org B's tenant. The WITH CHECK is what makes that impossible.
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO triage_call (organization_id, provider_entity_id, on_call_shift_id, caller_kind,
             inbound_channel, source, state)
           VALUES ($1,$2,$3,'caregiver','phone','manual','open')`,
          [ORG_B, a.pe, a.shift],
        ),
      ),
    ).rejects.toThrow();
  });

  it("an UPDATE cannot move a row from org A into org B", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query("UPDATE triage_call SET organization_id=$1 WHERE id=$2", [ORG_B, a.call]),
      ),
    ).rejects.toThrow();
    const still = await db.query<{ organization_id: string }>(
      "SELECT organization_id FROM triage_call WHERE id=$1",
      [a.call],
    );
    expect(still.rows[0].organization_id).toBe(ORG_A);
  });

  it("the §3.6 write-audit trigger exists on every owned table", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `SELECT DISTINCT c.relname FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
       WHERE NOT tg.tgisinternal AND c.relname = ANY($1) AND tg.tgname LIKE '%audit%'`,
      [ALL_TABLES],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...ALL_TABLES].sort());
  });

  it("the D5 red-flag evaluation is NOT audit-denylisted — it is the suppression tamper-evidence", () => {
    const rls = readFileSync(join(MIGRATIONS_DIR, "0108_oncall_m19_rls_audit_triggers.sql"), "utf8");
    const fn = rls.match(
      /FUNCTION audit_phi_write_triage_call_answer\(\)[\s\S]*?\$\$ LANGUAGE plpgsql|FUNCTION audit_phi_write_triage_call_answer\(\)[\s\S]*?LANGUAGE plpgsql[\s\S]*?\$\$;/,
    );
    expect(fn).not.toBeNull();
    const body = fn?.[0] ?? "";
    // The caller's free text is scrubbed; the server's own verdict is not. Scrubbing `red_flag_hit` would
    // erase the only record a mandatory-escalation-suppression investigation reads.
    expect(body).toMatch(/answer_value_text/);
    expect(body).not.toMatch(/'red_flag_hit'/);
  });
});
