/**
 * M25 Remittance & Denials — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * The pure unit suites (apps/backend/.../25-remittance, packages/x12-835-client) exercise the domain +
 * adapter but never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK, or
 * a base-table grant that leaks across tenants. This test applies the actual migrations to a real Postgres
 * and exercises the policies as the unprivileged `chartwarden_app` role (no BYPASSRLS), proving cross-tenant
 * denial for real on all covered M25 tables under the canonical `organization_id = current_setting('app.org_id')`
 * predicate — including the four monthly RANGE(received_at)-partitioned tables (the policy is on the parent
 * and propagates to every partition, PG11+).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live` job provides a postgres service + CHARTWARDEN_TEST_DATABASE_URL.
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMedicaidEraReviewService } from "../../../../apps/backend/src/modules/25-remittance/domain/medicaid-era-trusted-review";
import { buildDrizzleMedicaidEraReviewReaders } from "../../../../apps/backend/src/modules/25-remittance/ingest/medicaid-era-review-readers";
import { buildDrizzleMedicaidEraReviewWorkflow } from "../../../../apps/backend/src/modules/25-remittance/ingest/medicaid-era-review-service";
import { createDbClient } from "../../src/client";
import { dropLiveRoles } from "./_live-roles";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type SeedIds = {
  advice: string;
  line: string;
  serviceLine: string;
  adjustment: string;
  remark: string;
  denial: string;
  assignment: string;
  appeal: string;
  appealEvent: string;
  overlay: string;
  prLedger: string;
  eraStage: string;
  matchDecision: string;
  financialReviewDecision: string;
  medicaidEraReview: string;
  medicaidEraReviewHistory: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "remittance_advice", key: "advice" },
  { table: "remittance_line", key: "line" },
  { table: "remittance_service_line", key: "serviceLine" },
  { table: "remittance_adjustment", key: "adjustment" },
  { table: "remittance_remark", key: "remark" },
  { table: "denial_case", key: "denial" },
  { table: "denial_case_assignment", key: "assignment" },
  { table: "appeal_case", key: "appeal" },
  { table: "appeal_case_event", key: "appealEvent" },
  { table: "denial_taxonomy_overlay", key: "overlay" },
  { table: "patient_responsibility_ledger", key: "prLedger" },
  { table: "claimmd_era_match_decision", key: "matchDecision" },
  { table: "claimmd_era_financial_review_decision", key: "financialReviewDecision" },
  { table: "medicaid_era_review", key: "medicaidEraReview" },
  { table: "medicaid_era_review_history", key: "medicaidEraReviewHistory" },
];

describe.skipIf(!DB_URL)(
  "M25 Remittance & Denials — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
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
          sql = sql.replace(
            /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
            "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR)",
          );
        }
        await db.query(sql);
      }
    }

    /** Seed one full M25 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes ISA/ST. */
    async function seedOrg(org: string, n: string): Promise<SeedIds> {
      const pe = "33333333-3333-3333-3333-333333333333";
      const advice = (
        await db.query(
          `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
           interchange_control_number, transaction_set_control_number, payment_method, total_payment_amount,
           production_date, minio_object_key, file_sha256)
         VALUES ($1,$2,gen_random_uuid(),'medicare',$3,$4,'eft',1000,now(),'k','sha') RETURNING id`,
          [org, pe, `ICN${n}`, `ST${n}`],
        )
      ).rows[0].id as string;
      const line = (
        await db.query(
          `INSERT INTO remittance_line (organization_id, remittance_advice_id, clp02_status_code,
           clp03_total_charge_amount, clp04_total_payment_amount, received_at)
         VALUES ($1,$2,1,1000,800,now()) RETURNING id`,
          [org, advice],
        )
      ).rows[0].id as string;
      const serviceLine = (
        await db.query(
          `INSERT INTO remittance_service_line (organization_id, remittance_line_id, svc02_charge_amount, svc03_paid_amount, received_at)
         VALUES ($1,$2,1000,800,now()) RETURNING id`,
          [org, line],
        )
      ).rows[0].id as string;
      const adjustment = (
        await db.query(
          `INSERT INTO remittance_adjustment (organization_id, remittance_line_id, cas_group_code, cas_reason_code,
           adjustment_amount, post_action, taxonomy_status, received_at)
         VALUES ($1,$2,'CO','45',200,'auto_posted','mapped',now()) RETURNING id`,
          [org, line],
        )
      ).rows[0].id as string;
      const remark = (
        await db.query(
          `INSERT INTO remittance_remark (organization_id, remittance_line_id, remark_kind, remark_code, received_at)
         VALUES ($1,$2,'MOA','MA01',now()) RETURNING id`,
          [org, line],
        )
      ).rows[0].id as string;
      const denial = (
        await db.query(
          `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, carc_code, category, source,
           dollar_value, taxonomy_status)
         VALUES ($1,$2,gen_random_uuid(),'50','denial','remittance_adjustment',800,'mapped') RETURNING id`,
          [org, pe],
        )
      ).rows[0].id as string;
      const assignment = (
        await db.query(
          `INSERT INTO denial_case_assignment (organization_id, denial_case_id, assigned_to_membership_id, assigned_by_membership_id)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid()) RETURNING id`,
          [org, denial],
        )
      ).rows[0].id as string;
      const appeal = (
        await db.query(
          `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, tier_deadline_at)
         VALUES ($1,$2,$3,gen_random_uuid(),'redetermination', now() + interval '120 days') RETURNING id`,
          [org, pe, denial],
        )
      ).rows[0].id as string;
      const appealEvent = (
        await db.query(
          `INSERT INTO appeal_case_event (organization_id, appeal_case_id, event_kind) VALUES ($1,$2,'created') RETURNING id`,
          [org, appeal],
        )
      ).rows[0].id as string;
      const overlay = (
        await db.query(
          `INSERT INTO denial_taxonomy_overlay (organization_id, carc_code, suggested_action, owner_role, severity)
         VALUES ($1,'50','Verify F2F documentation','billing_specialist','warn') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      const prLedger = (
        await db.query(
          `INSERT INTO patient_responsibility_ledger (organization_id, patient_id, remittance_line_id, remittance_adjustment_id, pr_amount)
         VALUES ($1,gen_random_uuid(),$2,$3,50) RETURNING id`,
          [org, line, adjustment],
        )
      ).rows[0].id as string;
      const eraStage = (
        await db.query(
          `INSERT INTO claimmd_era_m25_stage (organization_id, provider_entity_id, source_inbox_id,
           account_reference, usage, era_id, file_index, interchange_control_number,
           transaction_set_control_number, original_835_digest, source_file_digest, source_evidence, state)
           VALUES ($1,$2,gen_random_uuid(),'synthetic-m25-rls','test','${n === "A" ? "71" : "72"}',0,
           '${n === "A" ? "000000071" : "000000072"}','${n === "A" ? "0071" : "0072"}',repeat('a',64),repeat('e',64),
           '{"codes":["EXACT_PAYEE_NPI"]}'::jsonb,'staged') RETURNING id`,
          [org, pe],
        )
      ).rows[0].id as string;
      const matchDecision = (
        await db.query(
          `INSERT INTO claimmd_era_match_decision (organization_id, provider_entity_id, stage_id,
           transaction_set_control_number, claim_index, decision_version, outcome, claim_id,
           source_digest, evidence, reason, actor_membership_id)
           VALUES ($1,$2,$3,$4,0,1,'confirmed',gen_random_uuid(),repeat('b',64),
           '{"sourceOutcome":"verified"}'::jsonb,'Verified synthetic source identity',gen_random_uuid()) RETURNING id`,
          [org, pe, eraStage, n === "A" ? "0071" : "0072"],
        )
      ).rows[0].id as string;
      const financialReviewDecision = (
        await db.query(
          `INSERT INTO claimmd_era_financial_review_decision (organization_id, provider_entity_id, stage_id,
           item_type, item_index, decision_version, disposition, source_digest, idempotency_key_hash,
           reason, actor_membership_id)
           VALUES ($1,$2,$3,'era',-1,1,'reviewed',repeat('c',64),repeat('d',64),
           'Reviewed synthetic ERA totals',gen_random_uuid()) RETURNING id`,
          [org, pe, eraStage],
        )
      ).rows[0].id as string;
      const medicaidEraReview = (
        await db.query(
          `INSERT INTO medicaid_era_review (organization_id, provider_entity_id, stage_id, vendor,
           account_reference, source_environment, canonical_payer_id, program_id, source_digest,
           assessment_fingerprint, assessment_version, decision_status, reason_codes, claim_match_status, duplicate_status, safe_summary)
           VALUES ($1,$2,$3,'claimmd','synthetic-m25-rls','test',gen_random_uuid(),'synthetic-program',
           repeat('e',64),repeat('1',64),'l5-v1','review_required','["SOURCE_UNVERIFIED"]'::jsonb,'UNMATCHED','none',
           '{"postingAuthorized":false}'::jsonb) RETURNING id`,
          [org, pe, eraStage],
        )
      ).rows[0].id as string;
      const medicaidEraReviewHistory = (
        await db.query(
          `INSERT INTO medicaid_era_review_history (organization_id, provider_entity_id, review_id, version,
           action, reason_code, actor_membership_id, idempotency_key_hash)
           VALUES ($1,$2,$3,1,'assessed','NONPOSTING_ASSESSMENT',gen_random_uuid(),repeat('f',64)) RETURNING id`,
          [org, pe, medicaidEraReview],
        )
      ).rows[0].id as string;
      return {
        advice,
        line,
        serviceLine,
        adjustment,
        remark,
        denial,
        assignment,
        appeal,
        appealEvent,
        overlay,
        prLedger,
        eraStage,
        matchDecision,
        financialReviewDecision,
        medicaidEraReview,
        medicaidEraReviewHistory,
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
      a = await seedOrg(ORG_A, "A");
      await seedOrg(ORG_B, "B");
    }, 120_000);

    afterAll(async () => {
      if (db) await db.end();
    });

    // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
    // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
    // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
      const platformRole = await db.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='chartwarden_platform') AS exists",
      );
      if (platformRole.rows[0]?.exists) {
        const membership = await db.query<{ member: boolean }>(
          "SELECT pg_has_role('chartwarden_app', 'chartwarden_platform', 'member') AS member",
        );
        expect(membership.rows[0]?.member).toBe(false);
      }
    });

    it("tenant application SQL cannot forge or rewrite a Medicaid ERA assessment", async () => {
      await withOrg(ORG_A, async () => {
        await expect(
          db.query(
            `INSERT INTO medicaid_era_review (organization_id, provider_entity_id, stage_id, vendor,
             account_reference, source_environment, canonical_payer_id, program_id, source_digest,
             assessment_fingerprint, assessment_version, decision_status, reason_codes, claim_match_status,
             duplicate_status, safe_summary)
             SELECT organization_id, provider_entity_id, id, 'claimmd', account_reference, usage,
               gen_random_uuid(), 'forged-program', source_file_digest, repeat('9',64), 'forged',
               'payment_reported', '[]'::jsonb, 'MATCHED', 'none', '{"postingAuthorized":false}'::jsonb
             FROM claimmd_era_m25_stage WHERE id=$1`,
            [a.eraStage],
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query(
            `UPDATE medicaid_era_review SET decision_status='payment_reported',
               safe_summary='{"postingAuthorized":false,"amounts":{"claimPaidCents":999999}}'::jsonb,
               version=version+1 WHERE id=$1`,
            [a.medicaidEraReview],
          ),
        ).rejects.toThrow(/permission denied/);
      });
    });

    it("tenant role cannot enumerate the account-wide Claim.MD cursor or encrypted ERA inbox", async () => {
      await db.query("SET ROLE claimmd_capture");
      try {
        await db.query(`INSERT INTO claimmd_era_stream(account_reference,usage,cursor)
          VALUES('synthetic-era-rls','test','0') ON CONFLICT DO NOTHING`);
        const central = await db.query(
          `SELECT id FROM claimmd_era_stream WHERE account_reference='synthetic-era-rls'`,
        );
        expect(central.rows.length).toBeGreaterThan(0);
      } finally {
        await db.query("RESET ROLE");
      }
      await expect(
        withOrg(ORG_A, () => db.query("SELECT id FROM claimmd_era_stream")),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("SELECT id FROM claimmd_era_inbox")),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("SELECT id FROM claimmd_era_resolution")),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("SELECT id FROM claimmd_era_resolution_history")),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("SELECT id FROM claimmd_era_delivery")),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("SELECT id FROM claimmd_era_delivery_history")),
      ).rejects.toThrow();
      await db.query("SET ROLE claimmd_capture");
      try {
        await db.query("SELECT id FROM claimmd_era_resolution LIMIT 0");
        await db.query("SELECT id FROM claimmd_era_resolution_history LIMIT 0");
        await db.query("SELECT id FROM claimmd_era_delivery LIMIT 0");
        await db.query("SELECT id FROM claimmd_era_delivery_history LIMIT 0");
      } finally {
        await db.query("RESET ROLE");
      }
    });

    it("Claim.MD staging is visible only in its owner tenant and rejects a cross-tenant write", async () => {
      const stage = (
        await db.query(
          `INSERT INTO claimmd_era_m25_stage(organization_id,provider_entity_id,source_inbox_id,
        account_reference,usage,era_id,file_index,interchange_control_number,transaction_set_control_number,
        original_835_digest,source_evidence,state)
        VALUES($1,gen_random_uuid(),gen_random_uuid(),'synthetic-era-rls','test','77',0,'000000077','0001',
        repeat('a',64),'{"codes":["EXACT_PAYEE_NPI"]}'::jsonb,'staged') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      expect(
        (
          await withOrg(ORG_A, () =>
            db.query("SELECT id FROM claimmd_era_m25_stage WHERE id=$1", [stage]),
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await withOrg(ORG_B, () =>
            db.query("SELECT id FROM claimmd_era_m25_stage WHERE id=$1", [stage]),
          )
        ).rows,
      ).toHaveLength(0);
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO claimmd_era_m25_stage(organization_id,provider_entity_id,
        source_inbox_id,account_reference,usage,era_id,file_index,interchange_control_number,transaction_set_control_number,
        original_835_digest,source_evidence,state) VALUES($1,gen_random_uuid(),gen_random_uuid(),'synthetic-era-rls',
        'test','78',0,'000000078','0002',repeat('b',64),'{}','staged')`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("tenant operational stage aggregates exclude central and foreign-tenant records", async () => {
      const own = await withOrg(ORG_A, () =>
        db.query<{ state: string; count: number }>(
          `SELECT state, count(*)::int AS count
             FROM claimmd_era_m25_stage
            GROUP BY state
            ORDER BY state`,
        ),
      );
      const foreign = await withOrg(ORG_B, () =>
        db.query<{ state: string; count: number }>(
          `SELECT state, count(*)::int AS count
             FROM claimmd_era_m25_stage
            WHERE id=$1
            GROUP BY state`,
          [a.eraStage],
        ),
      );
      expect(own.rows.some((row) => row.state === "staged" && row.count > 0)).toBe(true);
      expect(foreign.rows).toHaveLength(0);
      await expect(
        withOrg(ORG_A, () => db.query("SELECT count(*) FROM claimmd_era_inbox")),
      ).rejects.toThrow();
    });

    it("every M25 RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      const rls = readFileSync(join(MIGRATIONS_DIR, "0083_remittance_m25_rls.sql"), "utf8");
      const policyBlocks = rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? [];
      expect(policyBlocks.length).toBeGreaterThan(0);
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
        expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
      },
    );

    it("a WITH CHECK refuses an INSERT into another tenant's scope", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO denial_taxonomy_overlay (organization_id, carc_code, suggested_action, owner_role, severity)
           VALUES ($1,'99','x','billing_specialist','info')`,
            [ORG_A], // B tries to write a row scoped to A
          ),
        ),
      ).rejects.toThrow();
    });

    it("Medicaid review identity is immutable and the workflow has no posting state", async () => {
      await expect(
        db.query(
          "UPDATE medicaid_era_review SET canonical_payer_id=gen_random_uuid() WHERE id=$1",
          [a.medicaidEraReview],
        ),
      ).rejects.toThrow(/assessment identity is immutable/);
      await expect(
        db.query(
          "UPDATE medicaid_era_review SET assessment_fingerprint=repeat('0',64) WHERE id=$1",
          [a.medicaidEraReview],
        ),
      ).rejects.toThrow(/reassessment requires a version increment/);
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "UPDATE medicaid_era_review SET workflow_state='posted', version=version+1 WHERE id=$1",
            [a.medicaidEraReview],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE medicaid_era_review_history SET reason_code='changed' WHERE id=$1", [
            a.medicaidEraReviewHistory,
          ]),
        ),
      ).rejects.toThrow(/append-only|permission denied/);
    });

    it("checks staged source identity on INSERT, including privileged direct SQL", async () => {
      await expect(
        db.query(
          `INSERT INTO medicaid_era_review (organization_id, provider_entity_id, stage_id, vendor,
             account_reference, source_environment, canonical_payer_id, program_id, source_digest,
             assessment_fingerprint, assessment_version, decision_status, reason_codes,
             claim_match_status, duplicate_status, safe_summary)
           SELECT organization_id, provider_entity_id, id, vendor, account_reference || '-tampered', usage,
             gen_random_uuid(), 'synthetic-program', source_file_digest, repeat('8',64), 'l5-v1',
             'payment_reported', '[]'::jsonb, 'MATCHED', 'none', '{"postingAuthorized":false}'::jsonb
             FROM claimmd_era_m25_stage WHERE id=$1`,
          [a.eraStage],
        ),
      ).rejects.toThrow(/source identity is not backed by a staged artifact/);
    });

    it("binds the repository readers and durable worklist without inventing an ERA source", async () => {
      await db.query("ALTER ROLE chartwarden_app LOGIN PASSWORD 'chartwarden_app_live_test'");
      const appUrl = new URL(DB_URL as string);
      appUrl.username = "chartwarden_app";
      appUrl.password = "chartwarden_app_live_test";
      const handle = createDbClient({ connectionString: appUrl.toString(), max: 1 });
      try {
        const actor = {
          organizationId: ORG_A,
          userId: "55555555-5555-5555-5555-555555555555",
          roles: ["billing_specialist"],
          providerEntityScope: ["33333333-3333-3333-3333-333333333333"],
          membershipId: "66666666-6666-6666-6666-666666666666",
          stepUpRecent: true,
        } as const;
        const readers = buildDrizzleMedicaidEraReviewReaders(handle.db);
        const workflow = buildDrizzleMedicaidEraReviewWorkflow(
          handle.db,
          createMedicaidEraReviewService(readers),
        );
        const page = await workflow.list(actor, 10);
        expect(page.items.map((item) => item.id)).toContain(a.medicaidEraReview);
        await expect(
          workflow.evaluate(actor, a.eraStage, "integration-synthetic-key-0001"),
        ).resolves.toEqual({
          status: "unavailable",
          reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE",
        });
      } finally {
        await handle.close();
      }
    });

    it("does not treat a test-account digest as a production duplicate", async () => {
      await db.query("ALTER ROLE chartwarden_app LOGIN PASSWORD 'chartwarden_app_live_test'");
      const appUrl = new URL(DB_URL as string);
      appUrl.username = "chartwarden_app";
      appUrl.password = "chartwarden_app_live_test";
      const handle = createDbClient({ connectionString: appUrl.toString(), max: 1 });
      try {
        const actor = {
          organizationId: ORG_A,
          userId: "55555555-5555-5555-5555-555555555555",
          roles: ["billing_specialist"],
          providerEntityScope: ["33333333-3333-3333-3333-333333333333"],
          membershipId: "66666666-6666-6666-6666-666666666666",
          stepUpRecent: true,
        } as const;
        const readers = buildDrizzleMedicaidEraReviewReaders(handle.db);
        const base = {
          vendor: "claimmd" as const,
          accountReference: "synthetic-m25-rls",
          artifactReference: "30000000-0000-4000-8000-000000000099",
          artifactDigest: "e".repeat(64),
          receivedAt: "2026-11-22T00:00:00.000Z",
        };
        const production = await readers.duplicateDecision({
          actor,
          source: { ...base, usage: "production" },
          observation: {} as never,
        });
        const test = await readers.duplicateDecision({
          actor,
          source: { ...base, usage: "test" },
          observation: {} as never,
        });
        expect(production).toBe("none");
        expect(test).toBe("exact");

        const raw = "synthetic duplicate fixture; reader-only test";
        const digest = createHash("sha256").update(raw, "utf8").digest("hex");
        await db.query(
          `UPDATE claimmd_era_m25_stage SET state='held', safe_reason_code='EXACT_CROSS_SOURCE_DUPLICATE',
             source_file_digest=$2 WHERE id=$1`,
          [a.eraStage, digest],
        );
        const duplicateStageReader = buildDrizzleMedicaidEraReviewReaders(handle.db, {
          readCapturedEra: async () => ({
            vendor: "claimmd",
            accountReference: "synthetic-m25-rls",
            usage: "test",
            eraId: "71",
            capturedAt: new Date("2026-11-22T00:00:00.000Z"),
            files: [raw],
          }),
        } as never);
        await expect(
          duplicateStageReader.readAuthenticatedArtifact(actor, a.eraStage),
        ).resolves.toMatchObject({ rawX12: raw, source: { artifactDigest: digest } });
      } finally {
        await handle.close();
      }
    });

    it("match decisions are tenant scoped and cannot be inserted for another organization", async () => {
      expect(
        (
          await withOrg(ORG_A, () =>
            db.query("SELECT id FROM claimmd_era_match_decision WHERE id=$1", [a.matchDecision]),
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await withOrg(ORG_B, () =>
            db.query("SELECT id FROM claimmd_era_match_decision WHERE id=$1", [a.matchDecision]),
          )
        ).rows,
      ).toHaveLength(0);
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO claimmd_era_match_decision (organization_id, provider_entity_id, stage_id,
         transaction_set_control_number, claim_index, decision_version, outcome, claim_id,
         source_digest, evidence, reason, actor_membership_id)
         VALUES ($1,gen_random_uuid(),$2,'0071',1,1,'confirmed',gen_random_uuid(),repeat('c',64),'{}',
         'Cross-tenant insert must fail',gen_random_uuid())`,
            [ORG_A, a.eraStage],
          ),
        ),
      ).rejects.toThrow();
    });

    it("match decision history is append-only", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE claimmd_era_match_decision SET reason='rewritten' WHERE id=$1", [
            a.matchDecision,
          ]),
        ),
      ).rejects.toThrow(/permission denied|append-only/);
      await expect(
        db.query("UPDATE claimmd_era_match_decision SET reason='rewritten' WHERE id=$1", [
          a.matchDecision,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("financial review history is tenant scoped and append-only", async () => {
      expect(
        (
          await withOrg(ORG_A, () =>
            db.query("SELECT id FROM claimmd_era_financial_review_decision WHERE id=$1", [
              a.financialReviewDecision,
            ]),
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await withOrg(ORG_B, () =>
            db.query("SELECT id FROM claimmd_era_financial_review_decision WHERE id=$1", [
              a.financialReviewDecision,
            ]),
          )
        ).rows,
      ).toHaveLength(0);
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "UPDATE claimmd_era_financial_review_decision SET reason='rewritten' WHERE id=$1",
            [a.financialReviewDecision],
          ),
        ),
      ).rejects.toThrow(/permission denied|append-only/);
      await expect(
        db.query(
          "UPDATE claimmd_era_financial_review_decision SET reason='rewritten' WHERE id=$1",
          [a.financialReviewDecision],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO claimmd_era_financial_review_decision (organization_id, provider_entity_id, stage_id,
         item_type, item_index, decision_version, disposition, source_digest, idempotency_key_hash,
         reason, actor_membership_id)
         VALUES ($1,gen_random_uuid(),$2,'era',-1,2,'reviewed',repeat('e',64),repeat('f',64),'Cross-tenant attempt',gen_random_uuid())`,
            [ORG_A, a.eraStage],
          ),
        ),
      ).rejects.toThrow();
    });
  },
);
