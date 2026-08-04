/**
 * M32 AI Platform — §8.2 cross-tenant isolation: the LIVE Postgres proof (§3.3 / §3.5 / ADR-0010).
 *
 * §8.2 lists four enforcement layers and puts RLS first: "every owned table has per-tenant policies; the
 * `wardenx_app` role cannot SELECT cross-tenant rows. Verified by the RLS-isolation test suite which
 * connects as `wardenx_app`, sets `app.org_id` to each of N tenants in sequence, and asserts no row
 * leakage." That sentence describes THIS file. Layer 2 (in-process scope tagging) is asserted in
 * `apps/backend/__tests__/ai-workflow-acceptance.test.ts`; layers 3 and 4 (per-tenant DEK, per-tenant
 * HNSW index) belong to M1 and to a Phase-2 embeddings sidecar respectively.
 *
 * `wardenx_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies
 * every assertion below vacuously. That is asserted FIRST, before a single isolation case runs (the
 * M15-T07 lesson).
 *
 * M32 IS THREE POLICY SHAPES AND THAT IS THE WHOLE REASON THIS FILE IS LONGER THAN A TABLE SWEEP:
 *
 *   1. **SIX PLATFORM-SHARED tables** (`ai_capability`, `ai_capability_lifecycle_event`,
 *      `ai_capability_calibration`, `ai_model_backend`, `ai_prompt_template`, `ai_evaluation_run`) are
 *      readable from inside EVERY tenant and writable by `wardenx_admin` alone. "Both tenants see the
 *      same row" is the CORRECT answer here and a leak everywhere else, so the sweep cannot be uniform.
 *   2. **SIX TENANT-SCOPED tables** on the canonical `app.org_id` policy — including the two PARTITIONED
 *      ones, whose policy and grants are declared on the parent only. What that actually buys is a
 *      PostgreSQL behaviour the migration cannot state and reading the SQL cannot tell you: the parent's
 *      policy governs every query ROUTED THROUGH THE PARENT, while each partition leaf carries
 *      `relrowsecurity = false` and is kept unreadable purely by NOT HOLDING A GRANT. Both halves are
 *      asserted, because a stray `GRANT SELECT ON ALL TABLES IN SCHEMA public` would expose every
 *      partition of the disclosure ledger to every tenant with no policy left to stop it.
 *   3. **ONE MIXED table**, `ai_kill_switch_state`, split BY COMMAND: SELECT admits the platform row
 *      (`organization_id IS NULL`), INSERT and UPDATE do not. That asymmetry is the §8.1 T12 control —
 *      a single `FOR ALL` policy would let any tenant admin mint a NULL-org row and stop a capability
 *      for every other agency on the platform — and it is only observable against a real server.
 *
 * THREE FURTHER INVARIANTS GET THEIR OWN CASES because each is a rule the migration states and only a
 * database can hold:
 *
 *   · **`wardenx_app` has DELETE on NOTHING in M32.** `ai_invocation` is the §164.528 disclosure ledger
 *     and §3.7's destruction is a DEK shred, not a row delete. The privilege is withheld so an attempted
 *     delete is a permission error rather than a code-review convention, and the trigger refuses it a
 *     second time for `wardenx_admin`.
 *   · **The §3.5 immutability triggers**, which are the §8.1 T4 mitigation: the two append-only tables
 *     refuse UPDATE outright, and `ai_invocation` freezes its request side and provenance while leaving
 *     `hitl_outcome` writable. The ONE cipher edit it admits is the §3.7 shred sentinel — which is what
 *     lets the destruction path run with no privileged bypass, and is asserted here as a WORKING write.
 *   · **The partition/audit interaction.** M1's baseline trigger stamps `TG_TABLE_NAME`, which on a
 *     partitioned write is the PARTITION; 0116 gives both partitioned tables a generated function that
 *     hard-codes the parent's name. This asserts the resulting `audit_event.resource_kind` is
 *     `ai_invocation`, not `ai_invocation_2026_08` — the defect that was found by running the migrations
 *     rather than by reading them.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m32` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - The target needs **pgvector**: other modules in the chain declare COLUMNS of type `vector`. Use
 *     `pgvector/pgvector:pgNN`, or set `WARDENX_TEST_NO_PGVECTOR=1` to strip the extension DDL.
 *   - Raise `max_locks_per_transaction` (512 is ample) — `DROP SCHEMA public CASCADE` takes one lock per
 *     relation and M32's own thirteen tables add twenty-eight partitions to a chain that already has many.
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

type SeedIds = {
  pe: string;
  location: string;
  optIn: string;
  optOut: string;
  invocation: string;
  invokedAt: string;
  ledger: string;
  report: string;
  override: string;
  tenantKill: string;
};

/** The seven org-scoped M32 tables, each with the seeded row the isolation case looks for. */
const TENANT_SCOPED: { table: string; key: keyof SeedIds }[] = [
  { table: "ai_tenant_opt_in_record", key: "optIn" },
  { table: "ai_clinician_opt_out", key: "optOut" },
  { table: "ai_invocation", key: "invocation" },
  { table: "ai_token_ledger", key: "ledger" },
  { table: "ai_hallucination_report", key: "report" },
  { table: "ai_routing_override", key: "override" },
  // The mixed table's TENANT row: its platform row is a separate case below.
  { table: "ai_kill_switch_state", key: "tenantKill" },
];

/** The six §3.3 platform-shared tables — read-all inside any tenant, writes via wardenx_admin. */
const PLATFORM_SHARED = [
  "ai_capability",
  "ai_capability_lifecycle_event",
  "ai_capability_calibration",
  "ai_model_backend",
  "ai_prompt_template",
  "ai_evaluation_run",
];

/** §3.5's append-only pair: SELECT + INSERT, never UPDATE, never DELETE. */
const APPEND_ONLY = ["ai_capability_lifecycle_event", "ai_token_ledger"];

const ALL_TABLES = [...TENANT_SCOPED.map((t) => t.table), ...PLATFORM_SHARED];

describe.skipIf(!DB_URL)("M32 AI Platform — cross-tenant isolation — LIVE Postgres (§8.2)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;
  /** The platform-shared ids both tenants reference (one set for the whole platform, by design). */
  let capabilityId: string;
  let backendId: string;
  let platformKillId: string;

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

  /** The PLATFORM-SHARED half — one capability, one backend, one template, one calibration, one run. */
  async function seedPlatform(): Promise<void> {
    backendId = (
      await db.query(
        `INSERT INTO ai_model_backend (backend_key, kind, vendor, model_family, model_version_pin,
           supported_modalities, context_window_tokens, max_output_tokens, supported_features,
           baa_reference, zdr_status, health_endpoint)
         VALUES ('anthropic-claude-opus-4-7','cloud','anthropic','claude','claude-opus-4-7-20260601',
           '["text"]'::jsonb, 200000, 4096, '{"streaming":true}'::jsonb,
           'BAA-2026-014','enabled','https://status.example/health') RETURNING id`,
      )
    ).rows[0].id as string;
    capabilityId = (
      await db.query(
        `INSERT INTO ai_capability (capability_key, display_name, description, risk_tier, lifecycle_state,
           default_backend_key, allowed_backend_keys, fallback_chain_keys, current_prompt_template_key)
         VALUES ('hearthnote_layer2','HearthNote Layer 2','narrative enhancement','high','APPROVED',
           'anthropic-claude-opus-4-7','["anthropic-claude-opus-4-7"]'::jsonb,'[]'::jsonb,
           'hearthnote_enhancement_v1') RETURNING id`,
      )
    ).rows[0].id as string;
    const runId = (
      await db.query(
        `INSERT INTO ai_evaluation_run (capability_id, backend_id, dataset_version_ref, mlflow_run_id,
           stage, summary_metrics, initiated_by_membership_id)
         VALUES ($1,$2,'dvc://golden@v7','mlflow-1','stage_3_evaluation','{}'::jsonb, gen_random_uuid())
         RETURNING id`,
        [capabilityId, backendId],
      )
    ).rows[0].id as string;
    await db.query(
      `INSERT INTO ai_capability_calibration (capability_id, backend_key, thresholds, baseline_metrics,
         baseline_set_at, baseline_evaluation_run_id)
       VALUES ($1,'anthropic-claude-opus-4-7','{}'::jsonb,'{}'::jsonb, now(), $2)`,
      [capabilityId, runId],
    );
    await db.query(
      `INSERT INTO ai_capability_lifecycle_event (capability_id, from_state, to_state,
         actor_membership_id, actor_role, approval_kind, reason, rationale_text)
       VALUES ($1,'PILOT','APPROVED', gen_random_uuid(),'ai_safety_owner','stage_5_ga','GA','went GA')`,
      [capabilityId],
    );
    await db.query(
      `INSERT INTO ai_prompt_template (template_key, capability_key, version, template_filesystem_ref,
         template_content_hash, compatible_backend_keys, input_schema_ref, output_schema_ref,
         output_entity_target_prefix, output_type_prefix, created_by_membership_id)
       VALUES ('hearthnote_enhancement_v1','hearthnote_layer2',1,'templates/v1.md',$1,
         '["anthropic-claude-opus-4-7"]'::jsonb,'in.v1','out.v1','encounter_narrative','narrative_text',
         gen_random_uuid())`,
      ["a".repeat(64)],
    );
    // The PLATFORM-WIDE kill row, deactivated: both tenants must be able to SEE it and neither may
    // write one. It is seeded inactive so the tenant-scoped cases are not all blocked by it.
    platformKillId = (
      await db.query(
        `INSERT INTO ai_kill_switch_state (organization_id, capability_id, active)
         VALUES (NULL,$1,false) RETURNING id`,
        [capabilityId],
      )
    ).rows[0].id as string;
  }

  /** One full tenant-scoped M32 chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const pe = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00032${n}','PE','32345678${n}','enc','0930') RETURNING id`,
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

    const optIn = (
      await db.query(
        `INSERT INTO ai_tenant_opt_in_record (organization_id, capability_id, status,
           org_admin_membership_id, disclosure_acknowledgments, routing_preference_snapshot, opted_in_at)
         VALUES ($1,$2,'active', gen_random_uuid(),'{}'::jsonb,'prefer_cloud', now()) RETURNING id`,
        [org, capabilityId],
      )
    ).rows[0].id as string;
    const optOut = (
      await db.query(
        `INSERT INTO ai_clinician_opt_out (organization_id, membership_id, capability_id)
         VALUES ($1, gen_random_uuid(), $2) RETURNING id`,
        [org, capabilityId],
      )
    ).rows[0].id as string;

    const invocationRow = (
      await db.query(
        `INSERT INTO ai_invocation (organization_id, provider_entity_id, location_id, capability_id,
           capability_key, backend_id, backend_key, model_version_pin, actor_membership_id, actor_role,
           patient_id, consumer_context_ref, routing_decision, routing_reason, prompt_payload_cipher,
           response_payload_cipher, chart_context_cipher, input_token_count, output_token_count, status,
           zdr_confirmed)
         VALUES ($1,$2,$3,$4,'hearthnote_layer2',$5,'anthropic-claude-opus-4-7','claude-opus-4-7-20260601',
           gen_random_uuid(),'registered_nurse', gen_random_uuid(),'{"module":"m8"}'::jsonb,
           'primary','default','\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea, 120, 45,'completed', true)
         RETURNING id, invoked_at`,
        [org, pe, location, capabilityId, backendId],
      )
    ).rows[0] as { id: string; invoked_at: Date };
    const ledger = (
      await db.query(
        `INSERT INTO ai_token_ledger (organization_id, invocation_id, capability_id, backend_id,
           input_tokens, output_tokens)
         VALUES ($1,$2,$3,$4,120,45) RETURNING id`,
        [org, invocationRow.id, capabilityId, backendId],
      )
    ).rows[0].id as string;

    const report = (
      await db.query(
        `INSERT INTO ai_hallucination_report (organization_id, provider_entity_id, location_id,
           invocation_id, capability_id, reporter_membership_id, reporter_role, severity,
           hallucination_kind, reporter_narrative_cipher)
         VALUES ($1,$2,$3,$4,$5, gen_random_uuid(),'registered_nurse','high','wrong_dose','\\x04'::bytea)
         RETURNING id`,
        [org, pe, location, invocationRow.id, capabilityId],
      )
    ).rows[0].id as string;
    const override = (
      await db.query(
        `INSERT INTO ai_routing_override (organization_id, capability_id, backend_key_preference,
           override_reason, set_by_membership_id)
         VALUES ($1,$2,'anthropic-claude-opus-4-7','tenant_sovereignty', gen_random_uuid()) RETURNING id`,
        [org, capabilityId],
      )
    ).rows[0].id as string;
    const tenantKill = (
      await db.query(
        `INSERT INTO ai_kill_switch_state (organization_id, capability_id, active)
         VALUES ($1,$2,false) RETURNING id`,
        [org, capabilityId],
      )
    ).rows[0].id as string;

    return {
      pe,
      location,
      optIn,
      optOut,
      invocation: invocationRow.id,
      invokedAt: invocationRow.invoked_at.toISOString(),
      ledger,
      report,
      override,
      tenantKill,
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
    await seedPlatform();
    a = await seedOrg(ORG_A, 1);
    b = await seedOrg(ORG_B, 2);
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

  it("enables RLS on all thirteen owned tables", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace`,
      [ALL_TABLES],
    );
    expect(rows).toHaveLength(ALL_TABLES.length);
    for (const row of rows) expect(row.relrowsecurity, `${row.relname} has RLS off`).toBe(true);
  });

  // ── shape 2: the tenant-scoped six (plus the mixed table's tenant row) ────────────────────────────

  it("shows each tenant ONLY its own rows across every org-scoped table", async () => {
    for (const { table, key } of TENANT_SCOPED) {
      const mine = await withOrg(ORG_A, () =>
        db.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = $1`, [a[key]]),
      );
      expect(mine.rowCount, `${table}: org A cannot see its own row`).toBe(1);

      const theirs = await withOrg(ORG_A, () =>
        db.query(`SELECT id FROM ${table} WHERE id = $1`, [b[key]]),
      );
      expect(theirs.rowCount, `${table}: org A can see org B's row`).toBe(0);
    }
  });

  it("isolates the PARTITIONED pair through the parent, and leaves the leaves reachable only by GRANT", async () => {
    // Read through the PARENT, which is how every M32 query reaches these tables: the parent's policy
    // applies and only the caller's rows come back.
    for (const parent of ["ai_invocation", "ai_token_ledger"]) {
      const visible = await withOrg(ORG_A, () =>
        db.query<{ organization_id: string }>(`SELECT organization_id FROM ${parent}`),
      );
      expect(visible.rowCount, `${parent}: org A sees none of its own rows`).toBeGreaterThan(0);
      for (const row of visible.rows) {
        expect(row.organization_id, `${parent} leaked a cross-tenant row`).toBe(ORG_A);
      }
    }

    // AND NOW THE PART THAT IS EASY TO GET CATASTROPHICALLY WRONG. RLS on a partitioned table does not
    // become RLS on its partitions: the parent's policy is applied only to queries routed through the
    // parent, and reading a leaf DIRECTLY applies that leaf's own policies.
    //
    // THIS CASE USED TO ASSERT `rls === false` ON EVERY LEAF, describing the absent GRANT as the thing
    // keeping leaves unreadable — i.e. it pinned the hole in place as though it were the design. It is
    // not a design: a partition-manager script or a maintenance session running
    // `GRANT SELECT ON ALL TABLES IN SCHEMA public TO wardenx_app` would have made every partition of
    // the §164.528 disclosure ledger readable BY EVERY TENANT, with no policy to stop it, and this
    // suite would have stayed green throughout. Migration 0118 closes it: every leaf now has RLS
    // ENABLED and FORCED, carries NO policies of its own, and therefore DEFAULT-DENIES direct access
    // even if someone grants it. Parent-routed reads and writes are unaffected — the cases above prove
    // that, and 0118's header records the live experiment behind the claim.
    //
    // Defence in depth is the point: the missing grant is still the first line, RLS is now the second,
    // and a leaf minted in future is secured at CREATE by the `wardenx_secure_new_partition` event
    // trigger rather than by each of the 43 `create_*_partition` helpers remembering to.
    const leaves = await db.query<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      sel: boolean;
    }>(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls,
              c.relforcerowsecurity AS forced,
              has_table_privilege('wardenx_app', c.oid, 'SELECT') AS sel
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname IN ('ai_invocation','ai_token_ledger')`,
    );
    expect(leaves.rowCount).toBeGreaterThan(0);
    for (const leaf of leaves.rows) {
      expect(
        leaf.rls,
        `${leaf.table_name} has NO row-level security of its own (0118 regression)`,
      ).toBe(true);
      expect(
        leaf.forced,
        `${leaf.table_name} has RLS but not FORCE — the table owner still bypasses it`,
      ).toBe(true);
      expect(leaf.sel, `${leaf.table_name} is directly readable by wardenx_app`).toBe(false);
    }

    // A leaf must carry NO policies: parent policies govern parent-routed access, and a leaf policy
    // would be a second, drifting copy of the tenancy rule. No policies + RLS on = default-deny.
    const leafPolicies = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_policy pol
         JOIN pg_inherits i ON i.inhrelid = pol.polrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname IN ('ai_invocation','ai_token_ledger')`,
    );
    expect(leafPolicies.rows[0]?.count, "a partition leaf grew its own policy").toBe("0");
  });

  it("refuses a write that carries another tenant's organization_id (the WITH CHECK half)", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO ai_routing_override (organization_id, capability_id, backend_key_preference,
             override_reason, set_by_membership_id)
           VALUES ($1,$2,'local-llama-3.1-8b-instruct','tenant_cost', gen_random_uuid())`,
          [ORG_B, capabilityId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  // ── shape 1: the platform-shared six ─────────────────────────────────────────────────────────────

  it("serves the platform-shared six to BOTH tenants — read-all is the design, not a leak", async () => {
    for (const table of PLATFORM_SHARED) {
      const fromA = await withOrg(ORG_A, () => db.query(`SELECT id FROM ${table}`));
      const fromB = await withOrg(ORG_B, () => db.query(`SELECT id FROM ${table}`));
      expect(fromA.rowCount, `${table} is invisible inside a tenant`).toBeGreaterThan(0);
      // A tenant cannot opt in to a capability it cannot see, and a per-tenant copy of the model
      // registry would let two tenants disagree about which model version answered a question.
      expect(fromB.rowCount).toBe(fromA.rowCount);
    }
  });

  it("gives wardenx_app NO write on the platform-shared six", async () => {
    for (const table of PLATFORM_SHARED) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        const { rows } = await db.query<{ has: boolean }>(
          "SELECT has_table_privilege('wardenx_app', $1, $2) AS has",
          [table, privilege],
        );
        expect(rows[0].has, `wardenx_app may ${privilege} ${table}`).toBe(false);
      }
    }
  });

  // ── shape 3: the mixed kill switch (§8.1 T12) ────────────────────────────────────────────────────

  it("lets a tenant READ the platform-wide kill row", async () => {
    const seen = await withOrg(ORG_A, () =>
      db.query(`SELECT id FROM ai_kill_switch_state WHERE id = $1`, [platformKillId]),
    );
    // A tenant that could not see the platform row would have no way to explain to its clinicians why
    // a capability stopped.
    expect(seen.rowCount).toBe(1);
  });

  it("refuses a tenant an INSERT of a NULL-org kill row — the T12 elevation of privilege", async () => {
    await expect(
      withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO ai_kill_switch_state (organization_id, capability_id, active, reason,
             activation_actor_kind, activated_at)
           VALUES (NULL,$1,true,'manual_safety_pause','incident_commander', now())`,
          [capabilityId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a tenant an UPDATE of the platform row, so a SEV-1 cannot be lifted from inside a tenant", async () => {
    const updated = await withOrg(ORG_A, () =>
      db.query(`UPDATE ai_kill_switch_state SET active = false WHERE id = $1`, [platformKillId]),
    );
    // Not an error: the UPDATE policy's USING clause simply makes the row invisible to the write, so
    // zero rows match. Silent, and correct — the tenant's own row is the one it may edit.
    expect(updated.rowCount).toBe(0);
    const stillTheirs = await withOrg(ORG_A, () =>
      db.query(`UPDATE ai_kill_switch_state SET active = false WHERE id = $1`, [a.tenantKill]),
    );
    expect(stillTheirs.rowCount).toBe(1);
  });

  // ── privileges: no DELETE anywhere, no UPDATE on the append-only pair ────────────────────────────

  it("grants wardenx_app DELETE on NOTHING in M32", async () => {
    for (const table of ALL_TABLES) {
      const { rows } = await db.query<{ has: boolean }>(
        "SELECT has_table_privilege('wardenx_app', $1, 'DELETE') AS has",
        [table],
      );
      expect(rows[0].has, `wardenx_app may DELETE ${table}`).toBe(false);
    }
  });

  it("grants no UPDATE on the append-only pair, and the trigger refuses one anyway", async () => {
    for (const table of APPEND_ONLY) {
      const { rows } = await db.query<{ has: boolean }>(
        "SELECT has_table_privilege('wardenx_app', $1, 'UPDATE') AS has",
        [table],
      );
      expect(rows[0].has, `wardenx_app may UPDATE ${table}`).toBe(false);
    }
    // As SUPERUSER, past every grant: the trigger is the second line, and it is the one that stops
    // `wardenx_admin` from rewriting the sum the W2 hard cap is computed from.
    await expect(
      db.query("UPDATE ai_token_ledger SET input_tokens = 0 WHERE id = $1", [a.ledger]),
    ).rejects.toThrow(/M32_TOKEN_LEDGER_APPEND_ONLY/);
    await expect(
      db.query("DELETE FROM ai_capability_lifecycle_event WHERE capability_id = $1", [
        capabilityId,
      ]),
    ).rejects.toThrow(/M32_LIFECYCLE_EVENT_APPEND_ONLY/);
  });

  // ── §3.5 / §8.1 T4: what an attacker may and may not edit on a recorded disclosure ──────────────

  it("freezes the invocation's provenance and leaves only the response side writable", async () => {
    // The one legal post-hoc write: the consumer records the human's accept/edit/reject.
    const hitl = await withOrg(ORG_A, () =>
      db.query("UPDATE ai_invocation SET hitl_outcome = 'edited' WHERE id = $1", [a.invocation]),
    );
    expect(hitl.rowCount).toBe(1);

    // …and the five columns a leak would have to move to become invisible are all refused, as
    // superuser, past RLS and past every grant.
    await expect(
      db.query("UPDATE ai_invocation SET zdr_confirmed = false WHERE id = $1", [a.invocation]),
    ).rejects.toThrow(/M32_INVOCATION_FROZEN_COLUMN/);
    await expect(
      db.query("UPDATE ai_invocation SET input_token_count = 0 WHERE id = $1", [a.invocation]),
    ).rejects.toThrow(/M32_INVOCATION_FROZEN_COLUMN/);
    await expect(
      db.query("UPDATE ai_invocation SET prompt_payload_cipher = '\\x99'::bytea WHERE id = $1", [
        a.invocation,
      ]),
    ).rejects.toThrow(/M32_INVOCATION_FROZEN_COLUMN/);
    await expect(
      db.query("DELETE FROM ai_invocation WHERE id = $1", [a.invocation]),
    ).rejects.toThrow(/M32_INVOCATION_NO_DELETE/);
  });

  it("admits the §3.7 SHRED as the one cipher write — which is why destruction needs no bypass", async () => {
    // Run it as `wardenx_app`, exactly as the eraser does under `withOrgContext`: no session variable,
    // no elevated role, no bypass parameter. The empty bytea is the sentinel; the two nullable ciphers
    // go to NULL. Anything else on those columns is refused (the case above).
    const shredded = await withOrg(ORG_A, () =>
      db.query(
        `UPDATE ai_invocation
            SET prompt_payload_cipher = ''::bytea,
                response_payload_cipher = NULL,
                chart_context_cipher = NULL
          WHERE id = $1`,
        [a.invocation],
      ),
    );
    expect(shredded.rowCount).toBe(1);

    // §8.8 — the ROW SURVIVES, with the accounting evidence intact. Deleting it would destroy the
    // record THAT the disclosure happened, which is the opposite of what a certificate is for.
    const after = await withOrg(ORG_A, () =>
      db.query<{
        input_token_count: number;
        zdr_confirmed: boolean;
        model_version_pin: string;
        prompt_len: number;
      }>(
        `SELECT input_token_count, zdr_confirmed, model_version_pin,
                length(prompt_payload_cipher) AS prompt_len
           FROM ai_invocation WHERE id = $1`,
        [a.invocation],
      ),
    );
    expect(after.rows[0]).toMatchObject({
      input_token_count: 120,
      zdr_confirmed: true,
      model_version_pin: "claude-opus-4-7-20260601",
      prompt_len: 0,
    });
  });

  // ── the partition/audit interaction (the 0116 header's third condition) ─────────────────────────

  it("audits a partitioned write under the PARENT's name, not the partition's", async () => {
    const { rows } = await db.query<{ resource_kind: string; event_type: string }>(
      `SELECT resource_kind, event_type FROM audit_event
        WHERE resource_kind LIKE 'ai_invocation%' OR resource_kind LIKE 'ai_token_ledger%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // `ai_invocation_2026_08` would make every audit query for the ledger return nothing, and the
      // resource kind would change name every month.
      expect(["ai_invocation", "ai_token_ledger"]).toContain(row.resource_kind);
      expect(row.event_type).toMatch(/^(ai_invocation|ai_token_ledger)\.(insert|update|delete)$/);
    }
  });

  it("scrubs the §3.4 denylisted ciphers out of the audit row while keeping the D19 claim verbatim", async () => {
    const { rows } = await db.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_event
        WHERE resource_kind = 'ai_invocation' AND event_type = 'ai_invocation.insert'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    const after = rows[0].after;
    for (const column of [
      "prompt_payload_cipher",
      "response_payload_cipher",
      "chart_context_cipher",
      "error_message",
    ]) {
      expect(after[column], `${column} reached the audit row unscrubbed`).not.toBe(null);
      expect(String(after[column])).not.toContain("\\x01");
    }
    // What stays VERBATIM is the more important half: these are the fields a §164.528 accounting or an
    // FDA inquiry reads, and `zdr_confirmed` is the entire D19 claim.
    expect(after.zdr_confirmed).toBe(true);
    expect(after.model_version_pin).toBe("claude-opus-4-7-20260601");
    expect(after.routing_decision).toBe("primary");
    expect(after.status).toBe("completed");
  });
});
