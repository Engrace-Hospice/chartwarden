import { spawn, spawnSync } from "node:child_process";
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
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { createDbClient } from "@chartwarden/db";
import { encodeCursor } from "@chartwarden/shared/route-kit";
import { chromium } from "@playwright/test";
import { makeSignature } from "better-auth/crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaimMdProtectedPayloadCipher } from "../src/bootstrap/claimmd-payload-cipher";
import { registerM24PublishedSeams } from "../src/modules/24-billing-medicaid/wiring";
import { createMedicaidEraReviewService } from "../src/modules/25-remittance/domain/medicaid-era-review-service";
import { createClaimMdEraStore } from "../src/modules/25-remittance/ingest/claimmd-era-store";
import {
  M25_EVALUATOR_ASSERTION_HEADER,
  createEvaluatorCommandSigner,
  createHttpEvaluatorTransport,
} from "../src/modules/25-remittance/ingest/isolated-evaluator-command";
import { buildDrizzleMedicaidEraReviewReaders } from "../src/modules/25-remittance/ingest/medicaid-era-review-readers";
import { buildDrizzleMedicaidEraReviewWorkflow } from "../src/modules/25-remittance/ingest/medicaid-era-review-service";
import { createDbMdmStore } from "../src/modules/40-mdm/mdm-store-db";
import { registerMdmSeams } from "../src/modules/40-mdm/seams";
import { dropLiveRoles } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const TEST_BETTER_AUTH_SECRET = "synthetic-l6d-better-auth-secret-0123456789abcdef0123456789abcdef";

async function signedBetterAuthCookie(token: string): Promise<string> {
  return `better-auth.session_token=${token}.${await makeSignature(token, TEST_BETTER_AUTH_SECRET)}`;
}

function containerDatabaseUrl(url: URL): URL {
  const result = new URL(url);
  result.hostname = "postgres";
  result.port = "5432";
  return result;
}

async function freeTcpPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function evaluatorContainerFetch(
  containerName: string,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const target = new URL(request?.url ?? input.toString());
  target.protocol = "http:";
  target.hostname = "127.0.0.1";
  target.port = "3012";
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const body =
    typeof init?.body === "string" ? init.body : request ? await request.clone().text() : null;
  const payload = JSON.stringify({
    url: target.toString(),
    method: init?.method ?? request?.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    body,
  });
  const script = [
    "const chunks=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));",
    'const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));',
    "const response=await fetch(input.url,{method:input.method,headers:input.headers,...(input.body===null?{}:{body:input.body})});",
    "process.stdout.write(JSON.stringify({status:response.status,body:await response.text()}));",
  ].join("");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", containerName, "bun", "-e", script], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let length = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("isolated evaluator internal command timed out"));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024) {
        child.kill("SIGKILL");
        reject(new Error("isolated evaluator response exceeded the test limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("isolated evaluator internal command could not start"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error("isolated evaluator internal command transport failed"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(payload);
  });
  if (!output) throw new Error("isolated evaluator internal command transport failed");
  const response = JSON.parse(output) as { status: number; body: string };
  return new Response(response.body, { status: response.status });
}

function provisionM25RuntimeRoles(values: Readonly<Record<string, string>>): void {
  const result = spawnSync("bun", ["run", "scripts/db/provision-runtime-roles.ts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? tmpdir(),
      PROVISION_DATABASE_URL: DB_URL ?? "",
      ...values,
    },
  });
  if (result.status !== 0)
    throw new Error("isolated M25 runtime role provisioner failed (output suppressed)");
}

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
           production_date, object_key, file_sha256)
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
      // The production platform carrier is created by the runtime role provisioner. Create the same
      // isolated login before migrations so conditional platform grants in migrations are exercised.
      await db.query("CREATE ROLE chartwarden_platform NOLOGIN");
      await db.query(
        "CREATE ROLE chartwarden_platform_login LOGIN PASSWORD 'synthetic-platform-l6b'",
      );
      await db.query("GRANT chartwarden_platform TO chartwarden_platform_login");
      await db.query("ALTER ROLE chartwarden_platform_login BYPASSRLS");
      await applyMigrations();
      await db.query(
        "GRANT EXECUTE ON FUNCTION audit_writer_insert_platform_event(text,text,uuid,text,text,text,jsonb,text) TO chartwarden_platform",
      );
      await db.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      a = await seedOrg(ORG_A, "A");
      b = await seedOrg(ORG_B, "B");
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
      // The application role has no UPDATE grant on the review table at all (1544) ...
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "UPDATE medicaid_era_review SET workflow_state='investigating', version=version+1 WHERE id=$1",
            [a.medicaidEraReview],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      // ... so the workflow CHECK is proven on the privileged connection: 'posted' is not representable.
      await expect(
        db.query(
          "UPDATE medicaid_era_review SET workflow_state='posted', version=version+1 WHERE id=$1",
          [a.medicaidEraReview],
        ),
      ).rejects.toThrow(/medicaid_era_review_workflow_state_check/);
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE medicaid_era_review_history SET reason_code='changed' WHERE id=$1", [
            a.medicaidEraReviewHistory,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      // The append-only trigger holds for the privileged connection too (the grant alone is not the proof).
      await expect(
        db.query("UPDATE medicaid_era_review_history SET reason_code='changed' WHERE id=$1", [
          a.medicaidEraReviewHistory,
        ]),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.query("DELETE FROM medicaid_era_review_history WHERE id=$1", [
          a.medicaidEraReviewHistory,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("the platform audit writer cannot be redirected into a caller's TEMP audit_event", async () => {
      // The source reader audits each read through audit_writer_insert_platform_event; without pg_temp pinned last in its
      // search_path a caller's temporary audit_event table is searched first and swallows the row.
      await db.query("SET ROLE chartwarden_platform");
      try {
        await db.query(
          `CREATE TEMP TABLE audit_event (organization_id uuid, actor_user_id uuid, actor_kind text, event_type text,
             resource_kind text, resource_id uuid, outcome text, correlation_id text, severity text, context jsonb,
             retention_class text)`,
        );
        await db.query("GRANT INSERT ON pg_temp.audit_event TO PUBLIC");
        await db.query(
          `SELECT audit_writer_insert_platform_event('m25.temp_redirect_probe', 'probe', gen_random_uuid(), 'success',
             'info', 'temp-redirect-probe', '{}'::jsonb, 'compliance')`,
        );
        const swallowed = await db.query("SELECT count(*)::int AS n FROM pg_temp.audit_event");
        expect(swallowed.rows[0].n).toBe(0);
      } finally {
        await db.query("DROP TABLE IF EXISTS pg_temp.audit_event");
        await db.query("RESET ROLE");
      }
      const landed = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type='m25.temp_redirect_probe'",
      );
      expect(landed.rows[0].n).toBe(1);
    });

    it("every workflow change takes the next version, so it has a history slot", async () => {
      await db.query("BEGIN");
      try {
        await expect(
          db.query("UPDATE medicaid_era_review SET workflow_state='investigating' WHERE id=$1", [
            a.medicaidEraReview,
          ]),
        ).rejects.toThrow(/workflow transition requires a version increment/);
      } finally {
        await db.query("ROLLBACK");
      }
      // Control: the same change with the next version is admitted.
      await db.query("BEGIN");
      try {
        const moved = await db.query(
          "UPDATE medicaid_era_review SET workflow_state='investigating', version=version+1 WHERE id=$1",
          [a.medicaidEraReview],
        );
        expect(moved.rowCount).toBe(1);
      } finally {
        await db.query("ROLLBACK");
      }
    });

    it("admits the evaluator's reassessment update that reopens a completed review", async () => {
      const reassess = (workflow: string) =>
        `UPDATE medicaid_era_review SET workflow_state='${workflow}', version=version+1,
           assessment_fingerprint=repeat('a',64), assessment_evidence_fingerprint=repeat('b',64),
           assessment_observed_at=now(), assessment_version='l6d-v2', decision_status='review_required',
           reason_codes='[]'::jsonb, claim_match_status='MATCHED', duplicate_status='none',
           safe_summary='{"transactionSetCount":1,"claims":[]}'::jsonb,
           assessment_trust_status='isolated_evaluator', updated_at=now() WHERE id=$1`;
      await db.query("BEGIN");
      try {
        // A trusted, completed review (set up on the privileged connection) ...
        await db.query(reassess("reviewed_not_posted"), [a.medicaidEraReview]);
        // ... that the evaluator reassesses: the new workflow state rides the same version bump, under its RLS policy.
        await db.query("SET LOCAL ROLE chartwarden_m25_evaluator");
        await db.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        const reopened = await db.query(reassess("reopened"), [a.medicaidEraReview]);
        expect(reopened.rowCount).toBe(1);
        await db.query("RESET ROLE");
        const state = await db.query<{ workflow_state: string; version: number }>(
          "SELECT workflow_state, version FROM medicaid_era_review WHERE id=$1",
          [a.medicaidEraReview],
        );
        expect(state.rows[0].workflow_state).toBe("reopened");
      } finally {
        await db.query("ROLLBACK");
      }
    });

    it("ERA review and history audit records land with the summary, account and note scrubbed", async () => {
      const review = await db.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_event
          WHERE resource_kind='medicaid_era_review' AND resource_id=$1
          ORDER BY created_at DESC LIMIT 1`,
        [a.medicaidEraReview],
      );
      expect(review.rows).toHaveLength(1);
      expect(review.rows[0].after.safe_summary).toBe("<changed>");
      expect(review.rows[0].after.account_reference).toBe("<changed>");
      // Inside a transaction that is rolled back: later tests count this review's history rows.
      await db.query("BEGIN");
      try {
        const history = (
          await db.query<{ id: string }>(
            `INSERT INTO medicaid_era_review_history
               (organization_id, provider_entity_id, review_id, version, action, note, actor_membership_id)
             SELECT organization_id, provider_entity_id, id, 99, 'note', 'synthetic free text note', gen_random_uuid()
               FROM medicaid_era_review WHERE id=$1 RETURNING id`,
            [a.medicaidEraReview],
          )
        ).rows[0].id;
        const noteAudit = await db.query<{ after: Record<string, unknown> }>(
          `SELECT after FROM audit_event
            WHERE resource_kind='medicaid_era_review_history' AND resource_id=$1`,
          [history],
        );
        expect(noteAudit.rows).toHaveLength(1);
        expect(noteAudit.rows[0].after.note).toBe("<changed>");
        expect(JSON.stringify(noteAudit.rows[0].after)).not.toContain("synthetic free text note");
      } finally {
        await db.query("ROLLBACK");
      }
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
        // The cursor anchor keeps the stored microseconds: a page starting at the review's own (created_at, id) does not
        // repeat it, and one starting a microsecond later does include it.
        const stored = await db.query<{ ts: string; later: string }>(
          `SELECT created_at::text AS ts, (created_at + interval '1 microsecond')::text AS later
             FROM medicaid_era_review WHERE id=$1`,
          [a.medicaidEraReview],
        );
        const pageFrom = (anchor: string) =>
          workflow.list(actor, 10, encodeCursor(ORG_A, { a: anchor, id: a.medicaidEraReview }));
        expect((await pageFrom(stored.rows[0].ts)).items.map((item) => item.id)).not.toContain(
          a.medicaidEraReview,
        );
        expect((await pageFrom(stored.rows[0].later)).items.map((item) => item.id)).toContain(
          a.medicaidEraReview,
        );
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

    it(
      "persists a synthetic Claim.MD 835 through the isolated evaluator runtime and restricted writer",
      async () => {
        const providerEntityId = "33333333-3333-4333-8333-333333333390";
        const payerId = "44444444-4444-4444-8444-444444444490";
        const actorMembershipId = "66666666-6666-4666-8666-666666666690";
        const actorUserId = "55555555-5555-4555-8555-555555555590";
        const actorSessionId = "77777777-7777-4777-8777-777777777790";
        const reviewerMembershipId = "66666666-6666-4666-8666-666666666691";
        const accountReference = "synthetic-l6b-integration";
        const eraId = "76001";
        const rawX12 = readFileSync(
          join(
            __dirname,
            "../../../packages/x12-835-client/samples/01-clean-routine-home-care.835",
          ),
          "utf8",
        )
          .trim()
          .replace("N1*PR*SYNTHETIC MAC*XV*99999", "N1*PR*SYNTHETIC MAC*PI*99999")
          .replaceAll("1999999999", "1234567893")
          .replaceAll("1AA1AA1AA11", "1EG4TE5MK73");
        const capturedFiles = [rawX12];
        const rawFileDigest = createHash("sha256").update(rawX12, "utf8").digest("hex");
        const captureDigest = createHash("sha256")
          .update(JSON.stringify(capturedFiles), "utf8")
          .digest("hex");
        const sourceKey = Buffer.alloc(32, 0x31);
        const sourceKeyRing = {
          activeId: "synthetic-l6b",
          byId: new Map([["synthetic-l6b", sourceKey]]),
        };
        const sourceCipher = createClaimMdProtectedPayloadCipher(sourceKeyRing, "claimmd-era:v1");
        const detailsCipher = createClaimMdProtectedPayloadCipher(
          sourceKeyRing,
          "claimmd-era-stage:v1",
        );

        await db.query(
          `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'0000390','Synthetic Review Provider','1234567893','synthetic-cipher','0930')`,
          [providerEntityId, ORG_A],
        );
        await db.query(
          `INSERT INTO "user" (id,email,name) VALUES ($1,'synthetic-l6c2@example.test','Synthetic L6C2 Reviewer')`,
          [actorUserId],
        );
        await db.query(
          `INSERT INTO membership (id,user_id,organization_id,status,default_provider_entity_id) VALUES ($1,$2,$3,'active',$4)`,
          [actorMembershipId, actorUserId, ORG_A, providerEntityId],
        );
        const evaluatorRoleId = (
          await db.query(
            `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'billing_specialist','Synthetic billing specialist','billing_finance',true) RETURNING id`,
            [ORG_A],
          )
        ).rows[0].id as string;
        await db.query(
          `INSERT INTO role_permission (organization_id,role_id,permission_key)
         VALUES ($1,$2,'remittance.read'),($1,$2,'remittance.match_review'),($1,$2,'remittance.financial_review')`,
          [ORG_A, evaluatorRoleId],
        );
        await db.query(
          `INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)`,
          [ORG_A, actorMembershipId, evaluatorRoleId],
        );
        await db.query(
          `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at) VALUES ($1,$2,$3,'synthetic-l6c2-token',now()+interval '1 day')`,
          [actorSessionId, actorUserId, ORG_A],
        );
        const unauthorizedUserId = "55555555-5555-4555-8555-555555555591";
        const unauthorizedMembershipId = "66666666-6666-4666-8666-666666666692";
        const unauthorizedSessionId = "77777777-7777-4777-8777-777777777791";
        await db.query(
          `INSERT INTO "user" (id,email,name) VALUES ($1,'synthetic-l6d-no-permission@example.test','Synthetic Unprivileged Reviewer')`,
          [unauthorizedUserId],
        );
        await db.query(
          `INSERT INTO membership (id,user_id,organization_id,status,default_provider_entity_id)
         VALUES ($1,$2,$3,'active',$4)`,
          [unauthorizedMembershipId, unauthorizedUserId, ORG_A, providerEntityId],
        );
        await db.query(
          `INSERT INTO "session" (id,user_id,active_organization_id,token,expires_at)
         VALUES ($1,$2,$3,'synthetic-l6d-unprivileged-token',now()+interval '1 day')`,
          [unauthorizedSessionId, unauthorizedUserId, ORG_A],
        );
        await db.query(
          `INSERT INTO payer (id,kind,state_code,payer_id,name,status)
         VALUES ($1,'medicaid','OR','99999','Synthetic Oregon Medicaid','active')`,
          [payerId],
        );
        const classificationId = (
          await db.query<{ id: string }>(
            `INSERT INTO mdm_medicaid_payer_program_classification
           (canonical_payer_id,state_code,classification,effective_from,effective_to,verification_status,
            source_kind,source_reference,verified_at,verified_by)
         VALUES ($1,'OR','oregon_ffs','2026-01-01','2026-12-31','verified','state_registry',
            'registry:synthetic-l6b-ffs',now(),'synthetic-reviewer') RETURNING id`,
            [payerId],
          )
        ).rows[0]!.id;
        await db.query(
          `INSERT INTO medicaid_enrollment_evidence
           (organization_id,provider_entity_id,service_state,program_kind,canonical_payer_id,clearinghouse,
            vendor_account_ref,source_environment,vendor_payer_id,transaction_type,evidence_kind,status,
            effective_from,effective_to,evidence_fresh_until,verification_source,evidence_reference,verified_at,
            verified_by_membership_id,recorded_by_membership_id)
         VALUES ($1,$2,'OR','ffs_open_card',$3,'claimmd',$4,'test','99999','835','835_era_enrollment','verified',
            '2026-01-01','2026-12-31','2026-12-31','payer_confirmation','approval:synthetic-l6b-era',
            '2026-01-02T00:00:00Z',$5,$6)`,
          [
            ORG_A,
            providerEntityId,
            payerId,
            accountReference,
            reviewerMembershipId,
            actorMembershipId,
          ],
        );

        const streamId = randomUUID();
        const inboxId = randomUUID();
        const stageId = randomUUID();
        const sourceMetadata = "{}";
        const sourceMetadataDigest = createHash("sha256").update(sourceMetadata).digest("hex");
        const encryptedFiles = sourceCipher.seal(
          streamId,
          `${eraId}:835`,
          JSON.stringify(capturedFiles),
        );
        const encryptedDetails = detailsCipher.seal(streamId, `${eraId}:details`, "{}");
        await db.query(
          `INSERT INTO claimmd_era_stream (id,account_reference,usage,cursor)
         VALUES ($1,$2,'test','0')`,
          [streamId, accountReference],
        );
        await db.query(
          `INSERT INTO claimmd_era_inbox
           (id,stream_id,account_reference,usage,era_id,source_metadata_cipher,source_metadata_key_id,
            source_metadata_digest,capture_state,original_835_cipher,original_835_key_id,original_835_digest,
            original_835_file_count,structured_details_cipher,structured_details_key_id,structured_details_digest,
            discovery_page_digest,captured_at)
         VALUES ($1,$2,$3,'test',$4,'synthetic-metadata','synthetic-l6b',$5,'captured',$6,'synthetic-l6b',$7,1,
            $8,'synthetic-l6b',$9,repeat('a',64),'2026-06-16T12:00:00Z')`,
          [
            inboxId,
            streamId,
            accountReference,
            eraId,
            sourceMetadataDigest,
            encryptedFiles.toString("base64"),
            captureDigest,
            encryptedDetails.toString("base64"),
            createHash("sha256").update("{}").digest("hex"),
          ],
        );
        const resolutionId = randomUUID();
        await db.query(
          `INSERT INTO claimmd_era_resolution
           (id,inbox_id,vendor,account_reference,usage,original_835_digest,status,organization_id,
            provider_entity_id,algorithm_version,decision_cipher,decision_key_id,decision_digest)
         VALUES ($1,$2,'claimmd',$3,'test',$4,'verified',$5,$6,'BIL141A_V1','synthetic-resolution',
            'synthetic-l6b',repeat('b',64))`,
          [resolutionId, inboxId, accountReference, captureDigest, ORG_A, providerEntityId],
        );
        await db.query(
          `INSERT INTO claimmd_era_m25_stage
           (id,organization_id,provider_entity_id,source_inbox_id,account_reference,usage,era_id,file_index,
            interchange_control_number,transaction_set_control_number,original_835_digest,source_file_digest,
            resolution_id,resolution_version,source_evidence,state,protected_details_cipher,protected_details_key_id)
         VALUES ($1,$2,$3,$4,$5,'test',$6,0,'100000001','0001',$7,$8,$9,1,
            '{"codes":["SYNTHETIC_TEST_FIXTURE"]}'::jsonb,'staged',$10,'synthetic-l6b')`,
          [
            stageId,
            ORG_A,
            providerEntityId,
            inboxId,
            accountReference,
            eraId,
            captureDigest,
            rawFileDigest,
            resolutionId,
            encryptedDetails.toString("base64"),
          ],
        );
        await db.query(
          `INSERT INTO claimmd_era_delivery
           (inbox_id,resolution_id,resolution_version,account_reference,usage,era_id,original_835_digest,
            organization_id,provider_entity_id,idempotency_key,state,tenant_finalized,stage_ids)
         VALUES ($1,$2,1,$3,'test',$4,$5,$6,$7,repeat('1',64),'delivered',true,ARRAY[$8::uuid])`,
          [
            inboxId,
            resolutionId,
            accountReference,
            eraId,
            captureDigest,
            ORG_A,
            providerEntityId,
            stageId,
          ],
        );

        const appUrl = new URL(DB_URL as string);
        appUrl.username = "chartwarden_app";
        appUrl.password = "chartwarden_app_live_test";
        await db.query("ALTER ROLE chartwarden_app LOGIN PASSWORD 'chartwarden_app_live_test'");
        const appHandle = createDbClient({ connectionString: appUrl.toString(), max: 5 });
        const platformUrl = new URL(DB_URL as string);
        platformUrl.username = "chartwarden_platform_login";
        platformUrl.password = "synthetic-platform-l6b";
        const platformSql = new Client({ connectionString: platformUrl.toString() });
        await platformSql.connect();
        await db.query(
          "CREATE ROLE chartwarden_m25_evaluator_login LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS PASSWORD 'synthetic-evaluator-overprivileged'",
        );
        await db.query(
          "GRANT chartwarden_platform TO chartwarden_m25_evaluator_login WITH ADMIN OPTION",
        );
        await db.query(
          "CREATE ROLE chartwarden_m25_era_source_login LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS PASSWORD 'synthetic-source-overprivileged'",
        );
        await db.query(
          "GRANT chartwarden_platform TO chartwarden_m25_era_source_login WITH ADMIN OPTION",
        );
        await db.query("GRANT chartwarden_m25_evaluator_login TO chartwarden_platform_login");
        await db.query("GRANT chartwarden_m25_era_source_login TO chartwarden_platform_login");
        provisionM25RuntimeRoles({
          CHARTWARDEN_M25_EVALUATOR_PASSWORD: "synthetic-m25-evaluator-first",
          CHARTWARDEN_M25_ERA_SOURCE_PASSWORD: "synthetic-m25-era-source-first",
        });
        const normalizedRoles = await db.query<{
          rolname: string;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
          rolcanlogin: boolean;
          rolinherit: boolean;
          carrier_member: boolean;
          carrier_admin: boolean;
          platform_member: boolean;
          has_unexpected_membership: boolean;
          reverse_platform_membership: boolean;
          reverse_member_count: number;
        }>(
          `SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolcanlogin,r.rolinherit,
                pg_has_role(r.rolname,CASE WHEN r.rolname='chartwarden_m25_evaluator_login'
                  THEN 'chartwarden_m25_evaluator' ELSE 'chartwarden_m25_era_source' END,'member') AS carrier_member,
                COALESCE((SELECT membership.admin_option FROM pg_auth_members membership
                  JOIN pg_roles granted ON granted.oid=membership.roleid
                  WHERE membership.member=r.oid AND granted.rolname=CASE WHEN r.rolname='chartwarden_m25_evaluator_login'
                    THEN 'chartwarden_m25_evaluator' ELSE 'chartwarden_m25_era_source' END),false) AS carrier_admin,
                pg_has_role(r.rolname,'chartwarden_platform','member') AS platform_member,
                EXISTS(SELECT 1 FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid
                  WHERE membership.member=r.oid AND granted.rolname NOT IN ('chartwarden_m25_evaluator','chartwarden_m25_era_source'))
                  AS has_unexpected_membership,
                pg_has_role('chartwarden_platform_login',r.rolname,'member') AS reverse_platform_membership,
                (SELECT count(*)::int FROM pg_auth_members reverse_membership
                  WHERE reverse_membership.roleid=r.oid) AS reverse_member_count
           FROM pg_roles r WHERE r.rolname IN ('chartwarden_m25_evaluator_login','chartwarden_m25_era_source_login')
           ORDER BY r.rolname`,
        );
        expect(normalizedRoles.rows).toHaveLength(2);
        for (const role of normalizedRoles.rows) {
          expect(role).toMatchObject({
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false,
            rolcanlogin: true,
            rolinherit: true,
            carrier_member: true,
            carrier_admin: false,
            platform_member: false,
            has_unexpected_membership: false,
            reverse_platform_membership: false,
            reverse_member_count: 0,
          });
        }
        const sourceUrl = new URL(DB_URL as string);
        sourceUrl.username = "chartwarden_m25_era_source_login";
        sourceUrl.password = "synthetic-m25-era-source-first";
        const sourceSql = new Client({ connectionString: sourceUrl.toString() });
        sourceSql.on("error", () => undefined);
        await sourceSql.connect();
        expect(
          (await sourceSql.query<{ current_user: string }>("SELECT current_user")).rows[0]
            ?.current_user,
        ).toBe("chartwarden_m25_era_source_login");
        await db.query("GRANT chartwarden_m25_era_source_login TO chartwarden_platform_login");
        provisionM25RuntimeRoles({ CHARTWARDEN_M25_ERA_SOURCE_REVOKE: "true" });
        const revokedSource = await db.query<{
          login: boolean;
          inherit_memberships: boolean;
          password_cleared: boolean;
          member: boolean;
          reverse_platform_membership: boolean;
          reverse_member_count: number;
          sessions: number;
        }>(
          `SELECT role.rolcanlogin AS login,role.rolinherit AS inherit_memberships,
                (SELECT auth.rolpassword IS NULL FROM pg_authid auth WHERE auth.oid=role.oid) AS password_cleared,
                pg_has_role('chartwarden_m25_era_source_login','chartwarden_m25_era_source','member') AS member,
                pg_has_role('chartwarden_platform_login','chartwarden_m25_era_source_login','member') AS reverse_platform_membership,
                (SELECT count(*)::int FROM pg_auth_members reverse_membership WHERE reverse_membership.roleid=role.oid) AS reverse_member_count,
                (SELECT count(*)::int FROM pg_stat_activity WHERE usename='chartwarden_m25_era_source_login') AS sessions
           FROM pg_roles role WHERE role.rolname='chartwarden_m25_era_source_login'`,
        );
        expect(revokedSource.rows[0]).toEqual({
          login: false,
          inherit_memberships: false,
          password_cleared: true,
          member: false,
          reverse_platform_membership: false,
          reverse_member_count: 0,
          sessions: 0,
        });
        await sourceSql.end().catch(() => undefined);
        provisionM25RuntimeRoles({
          CHARTWARDEN_M25_EVALUATOR_PASSWORD: "synthetic-m25-evaluator-rotated",
          CHARTWARDEN_M25_ERA_SOURCE_PASSWORD: "synthetic-m25-era-source-rotated",
        });
        sourceUrl.password = "synthetic-m25-era-source-rotated";
        const sourceReaderSql = new Client({ connectionString: sourceUrl.toString() });
        await sourceReaderSql.connect();
        await expect(
          sourceReaderSql.query("SELECT original_835_cipher FROM claimmd_era_inbox"),
        ).rejects.toThrow(/permission denied/);
        const sourceProjection = await sourceReaderSql.query<{
          stage_id: string;
          stage_digest: string;
          cipher_text: string;
        }>("SELECT stage_id,stage_digest,cipher_text FROM m25_read_staged_claimmd_era($1,$2,$3)", [
          stageId,
          ORG_A,
          providerEntityId,
        ]);
        expect(sourceProjection.rows).toEqual([
          {
            stage_id: stageId,
            stage_digest: rawFileDigest,
            cipher_text: encryptedFiles.toString("base64"),
          },
        ]);
        await expect(
          sourceReaderSql.query(
            "SELECT protected_details_cipher FROM claimmd_era_m25_stage WHERE id=$1",
            [stageId],
          ),
        ).rejects.toThrow(/permission denied/);
        const foreignSourceProjection = await sourceReaderSql.query(
          "SELECT * FROM m25_read_staged_claimmd_era($1,$2,$3)",
          [stageId, ORG_B, providerEntityId],
        );
        expect(foreignSourceProjection.rows).toEqual([]);
        const evaluatorUrl = new URL(DB_URL as string);
        evaluatorUrl.username = "chartwarden_m25_evaluator_login";
        evaluatorUrl.password = "synthetic-m25-evaluator-rotated";
        let runtimeProcess: ReturnType<typeof spawn> | null = null;
        let apiProcess: ReturnType<typeof spawn> | null = null;
        let runtimeDirectory: string | null = null;
        let sourceReaderHandle: ReturnType<typeof createDbClient> | null = null;
        let evaluatorReaderSql: Client | null = null;
        const runtimeContainerName = `m25-l6c2-${randomUUID().slice(0, 8)}`;
        const apiContainerName = `m25-l6d-api-${randomUUID().slice(0, 8)}`;
        const runtimeNetworkName = `m25-l6c2-net-${randomUUID().slice(0, 8)}`;
        const apiEdgeNetworkName = `m25-l6d-edge-${randomUUID().slice(0, 8)}`;
        const repositoryRoot = join(__dirname, "../../..");
        const postgresContainerName = process.env.M25_TEST_POSTGRES_CONTAINER;
        const useRuntimeContainer = process.env.M25_TEST_EVALUATOR_CONTAINER === "1";
        const useImmutableImage = process.env.M25_TEST_IMMUTABLE_IMAGE === "1";
        const useBrowserJourney = process.env.M25_TEST_BROWSER_E2E === "1";
        const apiImage = process.env.M25_EVALUATOR_TEST_IMAGE ?? "wardenx-api:latest";
        const webImage = process.env.M25_WEB_TEST_IMAGE;
        if (useImmutableImage && (!useRuntimeContainer || apiImage === "wardenx-api:latest"))
          throw new Error(
            "immutable image qualification requires the current API image and container mode",
          );
        if (useBrowserJourney && (!useImmutableImage || !webImage))
          throw new Error("the browser journey requires current immutable API and web images");
        let webContainerName: string | null = null;
        let proxyConfigPath: string | null = null;
        try {
          registerMdmSeams({ store: createDbMdmStore(appHandle.db) });
          registerM24PublishedSeams(appHandle.db);
          const sourceReaderClient = createDbClient({
            connectionString: sourceUrl.toString(),
            max: 1,
          });
          sourceReaderHandle = sourceReaderClient;
          const store = createClaimMdEraStore({
            sourceReaderDb: sourceReaderClient.db,
            keyRing: sourceKeyRing,
          });
          const actor = {
            organizationId: ORG_A,
            userId: actorUserId,
            roles: ["billing_specialist"],
            providerEntityScope: [providerEntityId, "33333333-3333-3333-3333-333333333333"],
            membershipId: actorMembershipId,
            sessionId: actorSessionId,
            stepUpRecent: true,
          } as const;
          const readers = buildDrizzleMedicaidEraReviewReaders(appHandle.db, store);
          const evaluator = createMedicaidEraReviewService(readers);
          expect((await evaluator.inspect(actor, stageId)).status).toBe("review_only");
          const evaluatorSql = new Client({ connectionString: evaluatorUrl.toString() });
          evaluatorReaderSql = evaluatorSql;
          await evaluatorSql.connect();
          expect(
            (await evaluatorSql.query<{ current_user: string }>("SELECT current_user")).rows[0]
              ?.current_user,
          ).toBe("chartwarden_m25_evaluator_login");
          const readEvaluatorStageForOrg = async (organizationId: string) => {
            await evaluatorSql.query("BEGIN");
            try {
              await evaluatorSql.query("SELECT set_config('app.org_id',$1,true)", [organizationId]);
              return await evaluatorSql.query<{ protected_details_cipher: string }>(
                "SELECT protected_details_cipher FROM claimmd_era_m25_stage WHERE id=$1",
                [stageId],
              );
            } finally {
              await evaluatorSql.query("ROLLBACK");
            }
          };
          expect((await readEvaluatorStageForOrg(ORG_A)).rows).toEqual([
            { protected_details_cipher: encryptedDetails.toString("base64") },
          ]);
          expect((await readEvaluatorStageForOrg(ORG_B)).rows).toEqual([]);
          const workflow = buildDrizzleMedicaidEraReviewWorkflow(appHandle.db, evaluator);
          runtimeDirectory = mkdtempSync(join(tmpdir(), "cw-l6c2-"));
          const { privateKey, publicKey } = generateKeyPairSync("ed25519");
          writeFileSync(
            join(runtimeDirectory, "db-url"),
            (useRuntimeContainer ? containerDatabaseUrl(evaluatorUrl) : evaluatorUrl).toString(),
            { mode: 0o600 },
          );
          writeFileSync(
            join(runtimeDirectory, "app-db-url"),
            (useRuntimeContainer ? containerDatabaseUrl(appUrl) : appUrl).toString(),
            { mode: 0o600 },
          );
          writeFileSync(
            join(runtimeDirectory, "source-db-url"),
            (useRuntimeContainer ? containerDatabaseUrl(sourceUrl) : sourceUrl).toString(),
            { mode: 0o600 },
          );
          writeFileSync(
            join(runtimeDirectory, "keyring"),
            JSON.stringify({
              activeId: "synthetic-l6b",
              keys: { "synthetic-l6b": sourceKey.toString("base64url") },
            }),
            { mode: 0o600 },
          );
          writeFileSync(
            join(runtimeDirectory, "public"),
            publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
            { mode: 0o600 },
          );
          writeFileSync(
            join(runtimeDirectory, "private"),
            privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
            { mode: 0o600 },
          );
          if (useRuntimeContainer) {
            if (!postgresContainerName)
              throw new Error(
                "M25_TEST_POSTGRES_CONTAINER is required for isolated runtime testing",
              );
            const network = spawnSync(
              "docker",
              ["network", "create", "--internal", runtimeNetworkName],
              { stdio: "ignore" },
            );
            if (network.status !== 0)
              throw new Error("could not create isolated evaluator test network");
            const edgeNetwork = spawnSync("docker", ["network", "create", apiEdgeNetworkName], {
              stdio: "ignore",
            });
            if (edgeNetwork.status !== 0)
              throw new Error("could not create the disposable API ingress test network");
            const connected = spawnSync(
              "docker",
              [
                "network",
                "connect",
                "--alias",
                "postgres",
                runtimeNetworkName,
                postgresContainerName,
              ],
              { stdio: "ignore" },
            );
            if (connected.status !== 0)
              throw new Error("could not attach disposable PostgreSQL to evaluator test network");
          }
          const childProcess = useRuntimeContainer
            ? spawn(
                "docker",
                [
                  "run",
                  "--name",
                  runtimeContainerName,
                  "--network",
                  runtimeNetworkName,
                  "--network-alias",
                  "m25-evaluator",
                  "--read-only",
                  "--tmpfs",
                  "/tmp:rw,noexec,nosuid,size=16m",
                  "--tmpfs",
                  "/run/secrets:rw,noexec,nosuid,size=1m",
                  "--cap-drop=ALL",
                  "--security-opt=no-new-privileges",
                  "--pids-limit=64",
                  "--memory=768m",
                  "--cpus=1",
                  "--user=1000:1000",
                  "--mount",
                  `type=bind,src=${join(runtimeDirectory, "public")},dst=/run/secrets/public,readonly`,
                  "--mount",
                  `type=bind,src=${join(runtimeDirectory, "db-url")},dst=/run/secrets/db-url,readonly`,
                  "--mount",
                  `type=bind,src=${join(runtimeDirectory, "app-db-url")},dst=/run/secrets/app-db-url,readonly`,
                  "--mount",
                  `type=bind,src=${join(runtimeDirectory, "source-db-url")},dst=/run/secrets/source-db-url,readonly`,
                  "--mount",
                  `type=bind,src=${join(runtimeDirectory, "keyring")},dst=/run/secrets/keyring,readonly`,
                  ...(useImmutableImage
                    ? []
                    : [
                        "--mount",
                        `type=bind,src=${join(repositoryRoot, "apps/backend/src")},dst=/app/apps/backend/src,readonly`,
                        "--mount",
                        `type=bind,src=${join(repositoryRoot, "packages")},dst=/app/packages,readonly`,
                        "--mount",
                        `type=bind,src=${join(repositoryRoot, "node_modules")},dst=/app/node_modules,readonly`,
                      ]),
                  "--env",
                  "M25_EVALUATOR_DATABASE_URL_FILE=/run/secrets/db-url",
                  "--env",
                  "M25_EVALUATOR_APP_DATABASE_URL_FILE=/run/secrets/app-db-url",
                  "--env",
                  "M25_EVALUATOR_ERA_SOURCE_DATABASE_URL_FILE=/run/secrets/source-db-url",
                  "--env",
                  "M25_EVALUATOR_CLAIMMD_KEYRING_FILE=/run/secrets/keyring",
                  "--env",
                  "M25_EVALUATOR_PUBLIC_KEY_FILE=/run/secrets/public",
                  "--env",
                  "M25_EVALUATOR_SIGNING_KEY_ID=synthetic-l6d",
                  "--env",
                  "M25_EVALUATOR_PORT=3012",
                  apiImage,
                  "bun",
                  "run",
                  "apps/backend/src/m25-evaluator.ts",
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
              )
            : spawn("bun", ["run", "apps/backend/src/m25-evaluator.ts"], {
                cwd: join(__dirname, "../../.."),
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                  PATH: process.env.PATH ?? "",
                  HOME: process.env.HOME ?? tmpdir(),
                  TMPDIR: process.env.TMPDIR ?? tmpdir(),
                  M25_EVALUATOR_DATABASE_URL_FILE: join(runtimeDirectory, "db-url"),
                  M25_EVALUATOR_APP_DATABASE_URL_FILE: join(runtimeDirectory, "app-db-url"),
                  M25_EVALUATOR_ERA_SOURCE_DATABASE_URL_FILE: join(
                    runtimeDirectory,
                    "source-db-url",
                  ),
                  M25_EVALUATOR_CLAIMMD_KEYRING_FILE: join(runtimeDirectory, "keyring"),
                  M25_EVALUATOR_PUBLIC_KEY_FILE: join(runtimeDirectory, "public"),
                  M25_EVALUATOR_SIGNING_KEY_ID: "synthetic-l6d",
                  M25_EVALUATOR_PORT: "39125",
                },
              });
          runtimeProcess = childProcess;
          let runtimeOutput = "";
          childProcess.stderr.on("data", (chunk) => {
            runtimeOutput += String(chunk);
          });
          childProcess.on("error", (error) => {
            runtimeOutput += `runtime spawn failed (${error.name})`;
          });
          for (let attempt = 0; attempt < 80; attempt++) {
            const isReady = useRuntimeContainer
              ? await evaluatorContainerFetch(runtimeContainerName, "http://evaluator/ready")
                  .then((response) => response.ok)
                  .catch(() => false)
              : await fetch("http://127.0.0.1:39125/ready")
                  .then((response) => response.ok)
                  .catch(() => false);
            if (isReady) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (childProcess.exitCode !== null)
              throw new Error(`isolated evaluator exited: ${runtimeOutput}`);
          }
          if (useRuntimeContainer) {
            const envInspection = spawnSync(
              "docker",
              ["inspect", "--format", "{{json .Config.Env}}", runtimeContainerName],
              { encoding: "utf8" },
            );
            expect(envInspection.status).toBe(0);
            const runtimeEnv = JSON.parse(envInspection.stdout.trim()) as string[];
            expect(runtimeEnv.some((entry) => entry.startsWith("DATABASE_PLATFORM_URL="))).toBe(
              false,
            );
            expect(runtimeEnv.some((entry) => entry.startsWith("DATABASE_URL="))).toBe(false);
            expect(
              runtimeEnv.some((entry) => entry.startsWith("CLAIMMD_RESPONSE_INBOX_KEYRING=")),
            ).toBe(false);
            expect(
              runtimeEnv.every(
                (entry) =>
                  !entry.includes("synthetic-m25-evaluator-rotated") &&
                  !entry.includes("synthetic-m25-era-source-rotated") &&
                  !entry.includes(sourceKey.toString("base64url")),
              ),
            ).toBe(true);
            const mountsInspection = spawnSync(
              "docker",
              ["inspect", "--format", "{{json .Mounts}}", runtimeContainerName],
              { encoding: "utf8" },
            );
            expect(mountsInspection.status).toBe(0);
            const secretMounts = JSON.parse(mountsInspection.stdout.trim()) as {
              Destination: string;
              RW: boolean;
            }[];
            for (const destination of [
              "/run/secrets/public",
              "/run/secrets/db-url",
              "/run/secrets/app-db-url",
              "/run/secrets/source-db-url",
              "/run/secrets/keyring",
            ])
              expect(secretMounts).toContainEqual(
                expect.objectContaining({ Destination: destination, RW: false }),
              );
            expect(
              secretMounts.some(
                (mount) =>
                  mount.Destination === "/var/run/docker.sock" ||
                  mount.Destination === "/app/.env.production",
              ),
            ).toBe(false);
            if (useImmutableImage)
              expect(secretMounts.some((mount) => mount.Destination.startsWith("/app/"))).toBe(
                false,
              );
            const networkInspection = spawnSync(
              "docker",
              ["network", "inspect", "--format", "{{.Internal}}", runtimeNetworkName],
              { encoding: "utf8" },
            );
            expect(networkInspection.status).toBe(0);
            expect(networkInspection.stdout.trim()).toBe("true");
            const containerInspection = spawnSync(
              "docker",
              ["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", runtimeContainerName],
              { encoding: "utf8" },
            );
            expect(containerInspection.status).toBe(0);
            expect(containerInspection.stdout.trim()).toBe("true");
            const publishedPorts = spawnSync(
              "docker",
              ["inspect", "--format", "{{json .HostConfig.PortBindings}}", runtimeContainerName],
              { encoding: "utf8" },
            );
            expect(publishedPorts.status).toBe(0);
            expect(JSON.parse(publishedPorts.stdout.trim())).toEqual({});
          }
          const apiPort = await freeTcpPort();
          const apiUrl = useRuntimeContainer
            ? `http://127.0.0.1:${apiPort}`
            : `http://127.0.0.1:${apiPort}`;
          const apiDatabaseUrl = (
            useRuntimeContainer ? containerDatabaseUrl(appUrl) : appUrl
          ).toString();
          const apiEvaluatorUrl = useRuntimeContainer
            ? "http://m25-evaluator:3012"
            : "http://127.0.0.1:39125";
          const apiEnvironment = {
            NODE_ENV: "test",
            PORT: useRuntimeContainer ? "3000" : String(apiPort),
            DATABASE_URL: apiDatabaseUrl,
            BETTER_AUTH_SECRET: TEST_BETTER_AUTH_SECRET,
            BETTER_AUTH_URL: useRuntimeContainer
              ? "http://localhost:3000"
              : `http://127.0.0.1:${apiPort}`,
            M25_TEST_API_RUNTIME: "1",
            M25_EVALUATOR_ENABLED: "true",
            M25_EVALUATOR_URL: apiEvaluatorUrl,
            M25_EVALUATOR_SIGNING_KEY_ID: "synthetic-l6d",
            M25_EVALUATOR_SIGNING_KEY_FILE: useRuntimeContainer
              ? "/run/secrets/private"
              : join(runtimeDirectory, "private"),
            ...(useBrowserJourney ? { M25_TEST_CLAIMMD_KEYRING_FILE: "/run/secrets/keyring" } : {}),
          };
          const apiChild = useRuntimeContainer
            ? spawn(
                "docker",
                [
                  "run",
                  "--name",
                  apiContainerName,
                  "--network",
                  runtimeNetworkName,
                  "--publish",
                  `127.0.0.1:${apiPort}:3000`,
                  "--read-only",
                  "--tmpfs",
                  "/tmp:rw,noexec,nosuid,size=16m",
                  "--tmpfs",
                  "/run/secrets:rw,noexec,nosuid,size=1m",
                  "--cap-drop=ALL",
                  "--security-opt=no-new-privileges",
                  "--pids-limit=128",
                  "--memory=1536m",
                  "--cpus=2",
                  "--user=1000:1000",
                  "--mount",
                  `type=bind,src=${join(runtimeDirectory, "private")},dst=/run/secrets/private,readonly`,
                  ...(useBrowserJourney
                    ? [
                        "--mount",
                        `type=bind,src=${join(runtimeDirectory, "keyring")},dst=/run/secrets/keyring,readonly`,
                      ]
                    : []),
                  ...(useImmutableImage
                    ? []
                    : [
                        "--mount",
                        `type=bind,src=${join(repositoryRoot, "apps/backend/src")},dst=/app/apps/backend/src,readonly`,
                        "--mount",
                        `type=bind,src=${join(repositoryRoot, "apps/backend/__tests__")},dst=/app/apps/backend/__tests__,readonly`,
                        "--mount",
                        `type=bind,src=${join(repositoryRoot, "packages")},dst=/app/packages,readonly`,
                        "--mount",
                        `type=bind,src=${join(repositoryRoot, "node_modules")},dst=/app/node_modules,readonly`,
                      ]),
                  ...Object.entries(apiEnvironment).flatMap(([key, value]) => [
                    "--env",
                    `${key}=${value}`,
                  ]),
                  apiImage,
                  "bun",
                  "run",
                  "apps/backend/__tests__/m25-review-api-runtime.ts",
                ],
                { stdio: ["ignore", "pipe", "pipe"] },
              )
            : spawn("bun", ["run", "apps/backend/__tests__/m25-review-api-runtime.ts"], {
                cwd: repositoryRoot,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                  PATH: process.env.PATH ?? "",
                  HOME: process.env.HOME ?? tmpdir(),
                  TMPDIR: process.env.TMPDIR ?? tmpdir(),
                  ...apiEnvironment,
                },
              });
          apiProcess = apiChild;
          let apiOutput = "";
          apiChild.stderr.on("data", (chunk) => {
            apiOutput += String(chunk);
          });
          apiChild.on("error", (error) => {
            apiOutput += `API runtime spawn failed (${error.name})`;
          });
          if (useRuntimeContainer) {
            let attached = false;
            for (let attempt = 0; attempt < 80; attempt++) {
              const inspect = spawnSync(
                "docker",
                ["inspect", "--format", "{{.State.Running}}", apiContainerName],
                { encoding: "utf8" },
              );
              if (inspect.status === 0 && inspect.stdout.trim() === "true") {
                const connection = spawnSync(
                  "docker",
                  ["network", "connect", "--alias", "api", apiEdgeNetworkName, apiContainerName],
                  { stdio: "ignore" },
                );
                attached = connection.status === 0;
                if (attached) break;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
              if (apiChild.exitCode !== null)
                throw new Error(`disposable Fastify API exited: ${apiOutput}`);
            }
            if (!attached)
              throw new Error("disposable API did not join the isolated ingress network");
          }
          const resolvedApiUrl = apiUrl;
          let apiReady = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            apiReady = await fetch(`${resolvedApiUrl}/ready`)
              .then((response) => response.ok)
              .catch(() => false);
            if (apiReady) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (apiChild.exitCode !== null)
              throw new Error(`disposable Fastify API exited: ${apiOutput}`);
          }
          if (!apiReady)
            throw new Error(`disposable Fastify API did not become ready: ${apiOutput}`);
          if (useRuntimeContainer) {
            const apiEnvInspection = spawnSync(
              "docker",
              ["inspect", "--format", "{{json .Config.Env}}", apiContainerName],
              { encoding: "utf8" },
            );
            expect(apiEnvInspection.status).toBe(0);
            const apiEnv = JSON.parse(apiEnvInspection.stdout.trim()) as string[];
            expect(apiEnv).toContain("M25_EVALUATOR_URL=http://m25-evaluator:3012");
            expect(apiEnv.some((entry) => entry.startsWith("M25_EVALUATOR_DATABASE_URL"))).toBe(
              false,
            );
            expect(
              apiEnv.some((entry) => entry.startsWith("M25_EVALUATOR_ERA_SOURCE_DATABASE_URL")),
            ).toBe(false);
            expect(apiEnv.some((entry) => entry.startsWith("M25_EVALUATOR_CLAIMMD_KEYRING"))).toBe(
              false,
            );
            expect(apiEnv.some((entry) => entry.includes("synthetic-m25-evaluator-rotated"))).toBe(
              false,
            );
            expect(apiEnv.some((entry) => entry.includes("synthetic-m25-era-source-rotated"))).toBe(
              false,
            );
            const apiMountInspection = spawnSync(
              "docker",
              ["inspect", "--format", "{{json .Mounts}}", apiContainerName],
              { encoding: "utf8" },
            );
            expect(apiMountInspection.status).toBe(0);
            const apiMounts = JSON.parse(apiMountInspection.stdout.trim()) as {
              Destination: string;
              RW: boolean;
            }[];
            expect(apiMounts).toContainEqual(
              expect.objectContaining({ Destination: "/run/secrets/private", RW: false }),
            );
            if (!useBrowserJourney)
              expect(apiMounts.some((mount) => mount.Destination === "/run/secrets/keyring")).toBe(
                false,
              );
            expect(apiMounts.some((mount) => mount.Destination === "/var/run/docker.sock")).toBe(
              false,
            );
            if (useBrowserJourney) {
              expect(apiMounts).toContainEqual(
                expect.objectContaining({ Destination: "/run/secrets/keyring", RW: false }),
              );
              expect(apiEnv.some((entry) => entry.includes(sourceKey.toString("base64url")))).toBe(
                false,
              );
            }
            if (useImmutableImage)
              expect(apiMounts.some((mount) => mount.Destination.startsWith("/app/"))).toBe(false);
            const apiNetworkInspection = spawnSync(
              "docker",
              ["inspect", "--format", `{{json .NetworkSettings.Networks}}`, apiContainerName],
              { encoding: "utf8" },
            );
            expect(apiNetworkInspection.status).toBe(0);
            expect(apiNetworkInspection.stdout).toContain(runtimeNetworkName);
            expect(apiNetworkInspection.stdout).toContain(apiEdgeNetworkName);
          }
          let browserBaseUrl: string | null = null;
          if (useBrowserJourney) {
            webContainerName = `m25-l7v-web-${randomUUID().slice(0, 8)}`;
            const webPort = await freeTcpPort();
            proxyConfigPath = join(runtimeDirectory!, "web-test.conf");
            const productionWebConfig = readFileSync(
              join(repositoryRoot, "deploy/production/web-nginx.conf"),
              "utf8",
            );
            const routeMarker = "    # React Router is client-side:";
            if (!productionWebConfig.includes(routeMarker))
              throw new Error(
                "production web routing changed; browser proxy fixture must be reviewed",
              );
            const apiProxyLocation = `    location ^~ /api/ {\n      proxy_http_version 1.1;\n      proxy_set_header Host $host;\n      proxy_set_header X-Real-IP $remote_addr;\n      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n      proxy_set_header X-Forwarded-Proto $scheme;\n      proxy_pass http://api:3000;\n    }\n\n`;
            writeFileSync(
              proxyConfigPath,
              productionWebConfig.replace(routeMarker, `${apiProxyLocation}${routeMarker}`),
              { mode: 0o644 },
            );
            const startedWeb = spawnSync(
              "docker",
              [
                "run",
                "--detach",
                "--name",
                webContainerName,
                "--network",
                apiEdgeNetworkName,
                "--network-alias",
                "web",
                "--publish",
                `127.0.0.1:${webPort}:8080`,
                "--memory=128m",
                "--cpus=0.5",
                "--pids-limit=64",
                "--security-opt=no-new-privileges",
                "--cap-drop=ALL",
                "--mount",
                `type=bind,src=${proxyConfigPath},dst=/etc/nginx/conf.d/default.conf,readonly`,
                webImage!,
              ],
              { encoding: "utf8" },
            );
            if (startedWeb.status !== 0)
              throw new Error(`immutable web runtime did not start: ${startedWeb.stderr}`);
            browserBaseUrl = `http://127.0.0.1:${webPort}`;
            let webReady = false;
            for (let attempt = 0; attempt < 80; attempt++) {
              webReady = await fetch(browserBaseUrl)
                .then((response) => response.ok)
                .catch(() => false);
              if (webReady) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!webReady) throw new Error("immutable web runtime did not serve the staff SPA");
            const webInspection = spawnSync(
              "docker",
              ["inspect", "--format", "{{json .Mounts}}", webContainerName],
              { encoding: "utf8" },
            );
            expect(webInspection.status).toBe(0);
            const webMounts = JSON.parse(webInspection.stdout.trim()) as {
              Destination: string;
              RW: boolean;
            }[];
            expect(webMounts).toContainEqual(
              expect.objectContaining({ Destination: "/etc/nginx/conf.d/default.conf", RW: false }),
            );
            expect(
              webMounts.some((mount) => mount.Destination.startsWith("/usr/share/nginx/html")),
            ).toBe(false);
          }
          const sessionCookie = await signedBetterAuthCookie("synthetic-l6c2-token");
          const initialListResponse = await fetch(
            `${resolvedApiUrl}/api/v1/remittance/medicaid-era-reviews?limit=25`,
            { headers: { cookie: sessionCookie } },
          );
          expect(initialListResponse.status).toBe(200);
          const initialList = (await initialListResponse.json()) as {
            items: { id: string; assessmentSemantics: string }[];
          };
          // The seeded legacy row belongs to a different provider entity. The mounted API must
          // apply provider ABAC and must not reveal that review in this actor's worklist.
          expect(initialList.items.some((item) => item.id === a.medicaidEraReview)).toBe(false);
          const listReadAudit = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_event
             WHERE organization_id=$1 AND actor_user_id=$2
               AND event_type='medicaid_era_review.list_viewed'
               AND resource_kind='medicaid_era_review'`,
            [ORG_A, actorUserId],
          );
          expect(listReadAudit.rows[0]?.n).toBeGreaterThanOrEqual(1);
          const setCookieHeaders = (
            initialListResponse.headers as Headers & { getSetCookie?: () => string[] }
          ).getSetCookie?.() ?? [initialListResponse.headers.get("set-cookie") ?? ""];
          const csrfCookie = setCookieHeaders
            .map((value) => value.match(/(?:^|,\s*)chartwarden_csrf=([^;,]+)/)?.[1])
            .find((value): value is string => typeof value === "string");
          expect(csrfCookie).toBeTruthy();
          const authenticatedCookie = `${sessionCookie}; chartwarden_csrf=${csrfCookie}`;
          const apiRequest = async (
            method: "GET" | "POST",
            path: string,
            options: {
              body?: Readonly<Record<string, unknown>>;
              idempotencyKey?: string;
              cookie?: string;
              csrf?: boolean;
            } = {},
          ) => {
            const headers: Record<string, string> = {
              cookie: options.cookie ?? authenticatedCookie,
            };
            if (options.body) headers["content-type"] = "application/json";
            if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
            if (options.csrf !== false && method === "POST") headers["x-csrf-token"] = csrfCookie!;
            return fetch(`${resolvedApiUrl}${path}`, {
              method,
              headers,
              ...(options.body ? { body: JSON.stringify(options.body) } : {}),
            });
          };
          const outboxBefore = await db.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM outbox_event WHERE organization_id=$1",
            [ORG_A],
          );
          const signCommand = createEvaluatorCommandSigner({
            kid: "synthetic-l6d",
            key: privateKey,
          });
          const transport = createHttpEvaluatorTransport({
            url: "http://127.0.0.1:39125",
            signer: signCommand,
            ...(useRuntimeContainer
              ? {
                  fetchImpl: (url, init) =>
                    evaluatorContainerFetch(runtimeContainerName, url, init),
                }
              : {}),
          });
          const forgedActor = { ...actor, userId: "55555555-5555-4555-8555-555555555599" };
          const forgedActorCommand = {
            operation: "evaluate" as const,
            artifactId: stageId,
            idempotencyKey: "synthetic-l6c2-forged-actor-0001",
          };
          const forgedUrl = useRuntimeContainer
            ? "http://evaluator/internal/m25/commands"
            : "http://127.0.0.1:39125/internal/m25/commands";
          const forgedActorResponse = await (useRuntimeContainer
            ? evaluatorContainerFetch(runtimeContainerName, forgedUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  [M25_EVALUATOR_ASSERTION_HEADER]: signCommand(forgedActor, forgedActorCommand),
                },
                body: JSON.stringify(forgedActorCommand),
              })
            : fetch(forgedUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  [M25_EVALUATOR_ASSERTION_HEADER]: signCommand(forgedActor, forgedActorCommand),
                },
                body: JSON.stringify(forgedActorCommand),
              }));
          expect(forgedActorResponse.status).toBe(403);
          expect(await forgedActorResponse.json()).toEqual({ error: "authority_denied" });
          expect(
            (
              await (useRuntimeContainer
                ? evaluatorContainerFetch(runtimeContainerName, "http://evaluator/ready")
                : fetch("http://127.0.0.1:39125/ready"))
            ).status,
          ).toBe(200);
          await db.query(`UPDATE "session" SET expires_at=now()-interval '1 minute' WHERE id=$1`, [
            actorSessionId,
          ]);
          const expiredSessionCommand = {
            operation: "evaluate" as const,
            artifactId: stageId,
            idempotencyKey: "synthetic-l6c2-expired-session-0001",
          };
          const expiredSessionUrl = useRuntimeContainer
            ? "http://evaluator/internal/m25/commands"
            : "http://127.0.0.1:39125/internal/m25/commands";
          const expiredSessionInit = {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [M25_EVALUATOR_ASSERTION_HEADER]: signCommand(actor, expiredSessionCommand),
            },
            body: JSON.stringify(expiredSessionCommand),
          };
          const expiredSessionResponse = await (useRuntimeContainer
            ? evaluatorContainerFetch(runtimeContainerName, expiredSessionUrl, expiredSessionInit)
            : fetch(expiredSessionUrl, expiredSessionInit));
          expect(expiredSessionResponse.status).toBe(403);
          expect(await expiredSessionResponse.json()).toEqual({ error: "authority_denied" });
          expect(
            (
              await (useRuntimeContainer
                ? evaluatorContainerFetch(runtimeContainerName, "http://evaluator/ready")
                : fetch("http://127.0.0.1:39125/ready"))
            ).status,
          ).toBe(200);
          await db.query(`UPDATE "session" SET expires_at=now()+interval '1 day' WHERE id=$1`, [
            actorSessionId,
          ]);
          expect(
            await transport.execute(actor, {
              operation: "evaluate",
              artifactId: b.eraStage,
              idempotencyKey: "synthetic-l6c2-foreign-stage-0001",
            }),
          ).toEqual({ status: "unavailable", reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" });
          await db.query(`
          CREATE OR REPLACE FUNCTION m25_l6d_test_delay_assessment_insert() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.25); RETURN NEW; END $$
        `);
          await db.query(`
          CREATE TRIGGER m25_l6d_test_delay_assessment_insert
          BEFORE INSERT ON medicaid_era_review
          FOR EACH ROW EXECUTE FUNCTION m25_l6d_test_delay_assessment_insert()
        `);
          let maximumConcurrentEvaluatorStatements = 0;
          let observedArtifactLockWait = false;
          let completedApiEvaluations = 0;
          let concurrentEvaluationResults: Awaited<ReturnType<typeof workflow.evaluate>>[] = [];
          try {
            const apiEvaluations = [
              apiRequest("POST", `/api/v1/remittance/medicaid-era-artifacts/${stageId}/evaluate`, {
                idempotencyKey: "synthetic-l6d-api-eval-0001",
              }).finally(() => {
                completedApiEvaluations += 1;
              }),
              apiRequest("POST", `/api/v1/remittance/medicaid-era-artifacts/${stageId}/evaluate`, {
                idempotencyKey: "synthetic-l6d-api-eval-0002",
              }).finally(() => {
                completedApiEvaluations += 1;
              }),
            ];
            const deadline = Date.now() + 10_000;
            while (completedApiEvaluations < 2 && Date.now() < deadline) {
              const active = await db.query<{ count: number; lock_wait: boolean }>(
                `SELECT count(*)::int AS count,
                      coalesce(bool_or(wait_event_type='Lock'),false) AS lock_wait
                 FROM pg_stat_activity
                WHERE usename='chartwarden_m25_evaluator_login' AND state='active'
                  AND (lower(query) LIKE '%insert into "medicaid_era_review"%'
                       OR lower(query) LIKE '%pg_advisory_xact_lock%')`,
              );
              maximumConcurrentEvaluatorStatements = Math.max(
                maximumConcurrentEvaluatorStatements,
                active.rows[0]?.count ?? 0,
              );
              observedArtifactLockWait ||= active.rows[0]?.lock_wait ?? false;
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const responses = await Promise.all(apiEvaluations);
            expect(responses.map((response) => response.status)).toEqual([200, 200]);
            concurrentEvaluationResults = (await Promise.all(
              responses.map((response) => response.json()),
            )) as Awaited<ReturnType<typeof workflow.evaluate>>[];
          } finally {
            await db.query(
              "DROP TRIGGER IF EXISTS m25_l6d_test_delay_assessment_insert ON medicaid_era_review",
            );
            await db.query("DROP FUNCTION IF EXISTS m25_l6d_test_delay_assessment_insert()");
          }
          expect(maximumConcurrentEvaluatorStatements).toBeGreaterThanOrEqual(2);
          expect(observedArtifactLockWait).toBe(true);
          expect(concurrentEvaluationResults).toHaveLength(2);
          expect(
            concurrentEvaluationResults.filter(
              (item) => item.status === "review_saved" && item.replay === false,
            ),
          ).toHaveLength(1);
          expect(
            concurrentEvaluationResults.filter(
              (item) => item.status === "review_saved" && item.replay === true,
            ),
          ).toHaveLength(1);
          const persisted = concurrentEvaluationResults.find(
            (item) => item.status === "review_saved" && item.replay === false,
          )!;
          expect(persisted).toMatchObject({ status: "review_saved", version: 1, replay: false });
          if (persisted.status !== "review_saved")
            throw new Error("synthetic evaluation was not persisted");
          const trusted = await workflow.detail(actor, persisted.reviewId);
          expect(trusted).toMatchObject({
            assessmentTrustStatus: "isolated_evaluator",
            sourceDigest: rawFileDigest,
            assessmentVersion: "l6d-v2",
            assessmentObservedAt: expect.any(Date),
          });
          expect(trusted).not.toHaveProperty("assessmentEvidenceFingerprint");
          const persistedSnapshot = await db.query<{
            assessment_evidence_fingerprint: string | null;
            assessment_observed_at: Date | null;
          }>(
            `SELECT assessment_evidence_fingerprint, assessment_observed_at
             FROM medicaid_era_review WHERE id=$1`,
            [persisted.reviewId],
          );
          expect(persistedSnapshot.rows[0]).toMatchObject({
            assessment_evidence_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
            assessment_observed_at: expect.any(Date),
          });
          await expect(
            db.query(
              `UPDATE medicaid_era_review
                SET assessment_evidence_fingerprint=NULL, assessment_observed_at=now()
              WHERE id=$1`,
              [persisted.reviewId],
            ),
          ).rejects.toThrow(/observation provenance cannot be removed/);
          await expect(
            db.query(
              `UPDATE medicaid_era_review
                SET assessment_observed_at=now(), version=version+1
              WHERE id=$1`,
              [a.medicaidEraReview],
            ),
          ).rejects.toThrow(/medicaid_era_review_evidence_fingerprint_ck/);
          await expect(
            db.query(
              `UPDATE medicaid_era_review
                SET assessment_evidence_fingerprint=repeat('a',64), assessment_observed_at=NULL,
                    version=version+1
              WHERE id=$1`,
              [a.medicaidEraReview],
            ),
          ).rejects.toThrow(/medicaid_era_review_evidence_fingerprint_ck/);
          await expect(
            db.query(
              `UPDATE medicaid_era_review
                SET assessment_evidence_fingerprint=repeat('b',64), assessment_observed_at=now()
              WHERE id=$1`,
              [persisted.reviewId],
            ),
          ).rejects.toThrow(/requires a version increment/);
          const apiDetailResponse = await apiRequest(
            "GET",
            `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}`,
          );
          expect(apiDetailResponse.status).toBe(200);
          const apiDetail = (await apiDetailResponse.json()) as Record<string, unknown>;
          expect(apiDetail).toMatchObject({
            assessmentTrustStatus: "isolated_evaluator",
            assessmentSemantics: "point_in_time_nonposting",
            sourceDigest: rawFileDigest,
            workflowState: "needs_review",
            version: 1,
          });
          const detailReadAudit = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_event
             WHERE organization_id=$1 AND actor_user_id=$2
               AND event_type='medicaid_era_review.viewed'
               AND resource_kind='medicaid_era_review' AND resource_id=$3`,
            [ORG_A, actorUserId, persisted.reviewId],
          );
          expect(detailReadAudit.rows[0]?.n).toBeGreaterThanOrEqual(1);
          const apiHistoryResponse = await apiRequest(
            "GET",
            `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/history`,
          );
          expect(apiHistoryResponse.status).toBe(200);
          expect(await apiHistoryResponse.json()).toMatchObject({
            items: [{ version: 1, action: "assessed", trustStatus: "isolated_evaluator" }],
          });
          const historyReadAudit = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_event
             WHERE organization_id=$1 AND actor_user_id=$2
               AND event_type='medicaid_era_review.viewed'
               AND resource_kind='medicaid_era_review' AND resource_id=$3`,
            [ORG_A, actorUserId, persisted.reviewId],
          );
          expect(historyReadAudit.rows[0]?.n).toBeGreaterThanOrEqual(2);
          const reassessPath = `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/reassess`;
          const reassessBefore = await db.query<{ version: number; history_count: number }>(
            `SELECT review.version,
                  (SELECT count(*)::int FROM medicaid_era_review_history AS history
                    WHERE history.review_id=review.id) AS history_count
             FROM medicaid_era_review AS review WHERE review.id=$1`,
            [persisted.reviewId],
          );
          const reassessKey = "synthetic-l7v-mounted-reassess-replay-0001";
          const reassessed = await apiRequest("POST", reassessPath, {
            idempotencyKey: reassessKey,
          });
          expect(reassessed.status).toBe(200);
          const reassessResult = await reassessed.json();
          expect(reassessResult).toMatchObject({
            status: "review_saved",
            reviewId: persisted.reviewId,
            version: 1,
            replay: true,
          });
          expect(
            await (await apiRequest("POST", reassessPath, { idempotencyKey: reassessKey })).json(),
          ).toEqual(reassessResult);
          const reassessAfter = await db.query<{ version: number; history_count: number }>(
            `SELECT review.version,
                  (SELECT count(*)::int FROM medicaid_era_review_history AS history
                    WHERE history.review_id=review.id) AS history_count
             FROM medicaid_era_review AS review WHERE review.id=$1`,
            [persisted.reviewId],
          );
          expect(reassessAfter.rows).toEqual(reassessBefore.rows);
          expect(
            (
              await apiRequest(
                "POST",
                `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/notes`,
                {
                  body: { expectedVersion: 1, reasonCode: "SOURCE_CONTEXT_REVIEWED" },
                  idempotencyKey: reassessKey,
                },
              )
            ).status,
          ).toBe(409);
          for (const hiddenReviewId of [b.medicaidEraReview, a.medicaidEraReview])
            expect(
              (
                await apiRequest(
                  "POST",
                  `/api/v1/remittance/medicaid-era-reviews/${hiddenReviewId}/reassess`,
                  { idempotencyKey: `synthetic-l7v-hidden-reassess-${hiddenReviewId.slice(-4)}` },
                )
              ).status,
            ).toBe(404);
          expect(
            (
              await apiRequest("POST", reassessPath, {
                cookie: await signedBetterAuthCookie("synthetic-l6d-unprivileged-token"),
                idempotencyKey: "synthetic-l7v-no-permission-reassess-0001",
              })
            ).status,
          ).toBe(403);
          await db.query("UPDATE membership SET status='revoked' WHERE id=$1", [actorMembershipId]);
          const revokedMembershipResponse = await apiRequest("POST", reassessPath, {
            idempotencyKey: "synthetic-l7v-revoked-membership-reassess-0001",
          });
          expect(revokedMembershipResponse.status).toBeGreaterThanOrEqual(401);
          expect(revokedMembershipResponse.status).toBeLessThan(500);
          await db.query("UPDATE membership SET status='active' WHERE id=$1", [actorMembershipId]);
          expect(
            (
              await apiRequest(
                "GET",
                `/api/v1/remittance/medicaid-era-reviews/${b.medicaidEraReview}`,
              )
            ).status,
          ).toBe(404);
          expect(
            (
              await apiRequest("GET", "/api/v1/remittance/medicaid-era-reviews", {
                cookie: await signedBetterAuthCookie("synthetic-l6d-unprivileged-token"),
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await apiRequest(
                "POST",
                `/api/v1/remittance/medicaid-era-artifacts/${stageId}/evaluate`,
                { idempotencyKey: "synthetic-l6d-no-csrf-0001", csrf: false },
              )
            ).status,
          ).toBe(403);
          expect(
            (
              await apiRequest(
                "POST",
                `/api/v1/remittance/medicaid-era-artifacts/${stageId}/evaluate`,
              )
            ).status,
          ).not.toBe(200);
          expect(
            await transport.execute(actor, {
              operation: "evaluate",
              artifactId: stageId,
              idempotencyKey: "synthetic-l6d-direct-eval-0003",
            }),
          ).toMatchObject({
            status: "review_saved",
            replay: true,
          });
          await expect(
            transport.execute(actor, {
              operation: "note",
              reviewId: persisted.reviewId,
              expectedVersion: 1,
              reasonCode: "REUSE_EVALUATION_KEY",
              idempotencyKey: "synthetic-l6d-direct-eval-0003",
            }),
          ).rejects.toThrow(/conflicts with current state/);
          const notePath = `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/notes`;
          const failedHistoryKey = "synthetic-l6d-atomic-history-failure-0001";
          const failedHistoryKeyHash = createHash("sha256").update(failedHistoryKey).digest("hex");
          const beforeAtomicFailure = await db.query<{
            version: number;
            history_count: number;
          }>(
            `SELECT review.version,
                  (SELECT count(*)::int FROM medicaid_era_review_history AS history
                    WHERE history.review_id=review.id) AS history_count
             FROM medicaid_era_review AS review WHERE review.id=$1`,
            [persisted.reviewId],
          );
          await db.query(`
          CREATE OR REPLACE FUNCTION m25_l6d_test_fail_history_insert() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic atomic history failure'; END $$
        `);
          await db.query(`
          CREATE TRIGGER m25_l6d_test_fail_history_insert
          BEFORE INSERT ON medicaid_era_review_history
          FOR EACH ROW EXECUTE FUNCTION m25_l6d_test_fail_history_insert()
        `);
          try {
            const failedHistoryResponse = await apiRequest("POST", notePath, {
              body: { expectedVersion: 1, reasonCode: "ATOMIC_FAILURE_TEST" },
              idempotencyKey: failedHistoryKey,
            });
            expect(failedHistoryResponse.status).toBeGreaterThanOrEqual(500);
            const afterAtomicFailure = await db.query<{
              version: number;
              history_count: number;
            }>(
              `SELECT review.version,
                    (SELECT count(*)::int FROM medicaid_era_review_history AS history
                      WHERE history.review_id=review.id) AS history_count
               FROM medicaid_era_review AS review WHERE review.id=$1`,
              [persisted.reviewId],
            );
            const failedIdempotency = await db.query(
              `SELECT 1 FROM medicaid_era_review_idempotency
              WHERE organization_id=$1 AND idempotency_key_hash=$2`,
              [ORG_A, failedHistoryKeyHash],
            );
            expect(afterAtomicFailure.rows).toEqual(beforeAtomicFailure.rows);
            expect(failedIdempotency.rows).toHaveLength(0);
          } finally {
            await db.query(
              "DROP TRIGGER IF EXISTS m25_l6d_test_fail_history_insert ON medicaid_era_review_history",
            );
            await db.query("DROP FUNCTION IF EXISTS m25_l6d_test_fail_history_insert()");
          }
          const noteBody = { expectedVersion: 1, reasonCode: "INVESTIGATION_STARTED" };
          const noteResponse = await apiRequest("POST", notePath, {
            body: noteBody,
            idempotencyKey: "synthetic-l6d-api-note-0001",
          });
          expect(noteResponse.status).toBe(200);
          expect(await noteResponse.json()).toMatchObject({ version: 2, replay: false });
          // The Fastify idempotency middleware replays the original HTTP response, while the
          // evaluator's domain-level key independently returns a replay result.
          expect(
            await (
              await apiRequest("POST", notePath, {
                body: noteBody,
                idempotencyKey: "synthetic-l6d-api-note-0001",
              })
            ).json(),
          ).toMatchObject({ version: 2, replay: false });
          expect(
            await transport.execute(actor, {
              operation: "note",
              reviewId: persisted.reviewId,
              expectedVersion: 1,
              reasonCode: "INVESTIGATION_STARTED",
              idempotencyKey: "synthetic-l6d-api-note-0001",
            }),
          ).toMatchObject({ version: 2, replay: true });
          expect(
            (
              await apiRequest("POST", notePath, {
                body: { expectedVersion: 2, reasonCode: "DIFFERENT_NOTE" },
                idempotencyKey: "synthetic-l6d-api-note-0001",
              })
            ).status,
          ).toBe(409);
          expect(
            (
              await apiRequest("POST", notePath, {
                body: { expectedVersion: 1, reasonCode: "STALE_NOTE" },
                idempotencyKey: "synthetic-l6d-api-note-stale-0001",
              })
            ).status,
          ).toBe(409);
          const dispositionPath = `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/disposition`;
          expect(
            (
              await apiRequest("POST", dispositionPath, {
                body: {
                  expectedVersion: 1,
                  state: "reviewed_not_posted",
                  reasonCode: "REVIEW_COMPLETE",
                },
                idempotencyKey: "synthetic-l6d-api-disposition-stale-0001",
              })
            ).status,
          ).toBe(409);
          const dispositionBody = {
            expectedVersion: 2,
            state: "reviewed_not_posted",
            reasonCode: "REVIEW_COMPLETE",
          };
          const dispositionResponse = await apiRequest("POST", dispositionPath, {
            body: dispositionBody,
            idempotencyKey: "synthetic-l6d-api-disposition-0001",
          });
          expect(dispositionResponse.status).toBe(200);
          expect(await dispositionResponse.json()).toMatchObject({
            version: 3,
            workflowState: "reviewed_not_posted",
            replay: false,
          });
          expect(
            await (
              await apiRequest("POST", dispositionPath, {
                body: { expectedVersion: 3, state: "reopened", reasonCode: "FOLLOW_UP_REOPENED" },
                idempotencyKey: "synthetic-l6d-api-reopen-0001",
              })
            ).json(),
          ).toMatchObject({ version: 4, workflowState: "reopened", replay: false });
          expect(await workflow.history(actor, persisted.reviewId)).toMatchObject([
            { version: 1, action: "assessed", trustStatus: "isolated_evaluator" },
            { version: 2, action: "note", trustStatus: "isolated_evaluator" },
            { version: 3, action: "reviewed_not_posted", trustStatus: "isolated_evaluator" },
            { version: 4, action: "reopened", trustStatus: "isolated_evaluator" },
          ]);
          const outboxAfter = await db.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM outbox_event WHERE organization_id=$1",
            [ORG_A],
          );
          expect(outboxAfter.rows[0]?.count).toBe(outboxBefore.rows[0]?.count);
          if (useRuntimeContainer) {
            const historyBeforeFailure = await workflow.history(actor, persisted.reviewId);
            const stopped = spawnSync("docker", ["stop", runtimeContainerName], {
              encoding: "utf8",
            });
            expect(stopped.status).toBe(0);
            const unavailableResponse = await apiRequest(
              "POST",
              `/api/v1/remittance/medicaid-era-artifacts/${stageId}/evaluate`,
              { idempotencyKey: "synthetic-l6d-api-failure-0001" },
            );
            expect(unavailableResponse.status).toBe(503);
            const unavailableReassessment = await apiRequest(
              "POST",
              `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/reassess`,
              { idempotencyKey: "synthetic-l7v-evaluator-unavailable-reassess-0001" },
            );
            expect(unavailableReassessment.status).toBe(503);
            expect(await workflow.history(actor, persisted.reviewId)).toEqual(historyBeforeFailure);
            const restarted = spawnSync("docker", ["start", runtimeContainerName], {
              encoding: "utf8",
            });
            expect(restarted.status).toBe(0);
            let evaluatorReady = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              evaluatorReady = await evaluatorContainerFetch(
                runtimeContainerName,
                "http://evaluator/ready",
              )
                .then((response) => response.ok)
                .catch(() => false);
              if (evaluatorReady) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            expect(evaluatorReady).toBe(true);
            const recovered = await apiRequest(
              "POST",
              `/api/v1/remittance/medicaid-era-artifacts/${stageId}/evaluate`,
              { idempotencyKey: "synthetic-l6d-api-recovery-0001" },
            );
            expect(recovered.status).toBe(200);
            expect(await recovered.json()).toMatchObject({
              status: "review_saved",
              reviewId: persisted.reviewId,
              replay: true,
            });
            expect(await workflow.history(actor, persisted.reviewId)).toEqual(historyBeforeFailure);
          }
          await db.query(
            `UPDATE claimmd_era_delivery
              SET state='possible_duplicate', safe_error_code='POSSIBLE_CROSS_SOURCE_DUPLICATE', updated_at=now()
            WHERE inbox_id=$1`,
            [inboxId],
          );
          const revalidationWriter = createDbClient({
            connectionString: evaluatorUrl.toString(),
            max: 1,
          });
          try {
            let inspections = 0;
            const changingEvaluator = {
              async inspect(reviewActor: typeof actor, artifactReference: string) {
                const assessment = await evaluator.inspect(reviewActor, artifactReference);
                inspections += 1;
                if (inspections === 1)
                  await db.query(
                    `UPDATE claimmd_era_delivery
                      SET state='exact_duplicate', safe_error_code='EXACT_CROSS_SOURCE_DUPLICATE', updated_at=now()
                    WHERE inbox_id=$1`,
                    [inboxId],
                  );
                return assessment;
              },
            };
            const staleWorkflow = buildDrizzleMedicaidEraReviewWorkflow(
              appHandle.db,
              changingEvaluator,
              revalidationWriter.db,
            );
            await expect(
              staleWorkflow.evaluate(actor, stageId, "synthetic-l6c2-stale-eval-0001"),
            ).rejects.toThrow(/authoritative ERA evidence changed/);
            expect(await workflow.detail(actor, persisted.reviewId)).toMatchObject({ version: 4 });
          } finally {
            await revalidationWriter.close();
          }
          const changedEvidenceReassessment = await apiRequest(
            "POST",
            `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/reassess`,
            { idempotencyKey: "synthetic-l7v-changed-evidence-reassess-0001" },
          );
          expect(changedEvidenceReassessment.status).toBe(200);
          expect(await changedEvidenceReassessment.json()).toMatchObject({
            status: "review_saved",
            reviewId: persisted.reviewId,
            version: 5,
            replay: false,
          });
          expect(await workflow.detail(actor, persisted.reviewId)).toMatchObject({
            version: 5,
            duplicateStatus: "exact",
          });
          expect(await workflow.history(actor, persisted.reviewId)).toMatchObject([
            { version: 1, action: "assessed", trustStatus: "isolated_evaluator" },
            { version: 2, action: "note", trustStatus: "isolated_evaluator" },
            { version: 3, action: "reviewed_not_posted", trustStatus: "isolated_evaluator" },
            { version: 4, action: "reopened", trustStatus: "isolated_evaluator" },
            { version: 5, action: "reassessed", trustStatus: "isolated_evaluator" },
          ]);
          // Simulate a historical row that retained an exact current fingerprint but was not
          // written by the isolated evaluator. Fingerprint equality alone must trigger reassessment.
          await db.query(
            `UPDATE medicaid_era_review
              SET assessment_trust_status='legacy_unverified', version=version+1, updated_at=now()
            WHERE id=$1 AND version=5 AND assessment_trust_status='isolated_evaluator'`,
            [persisted.reviewId],
          );
          await db.query(
            `INSERT INTO medicaid_era_review_history
             (organization_id,provider_entity_id,review_id,version,action,reason_code,
              actor_membership_id,trust_status)
           VALUES ($1,$2,$3,6,'assessed','LEGACY_FIXTURE',gen_random_uuid(),'legacy_unverified')`,
            [ORG_A, providerEntityId, persisted.reviewId],
          );
          const beforeLegacyReassess = await db.query<{ version: number; history_count: number }>(
            `SELECT review.version,
                  (SELECT count(*)::int FROM medicaid_era_review_history AS history
                    WHERE history.review_id=review.id) AS history_count
             FROM medicaid_era_review AS review WHERE review.id=$1`,
            [persisted.reviewId],
          );
          const legacyReassessResponse = await apiRequest(
            "POST",
            `/api/v1/remittance/medicaid-era-reviews/${persisted.reviewId}/reassess`,
            { idempotencyKey: "synthetic-l7v-legacy-reassess-held-0001" },
          );
          expect(legacyReassessResponse.status).toBe(200);
          expect(await legacyReassessResponse.json()).toEqual({
            status: "held",
            reasonCode: "REASSESSMENT_SOURCE_UNAVAILABLE",
          });
          const afterLegacyReassess = await db.query<{ version: number; history_count: number }>(
            `SELECT review.version,
                  (SELECT count(*)::int FROM medicaid_era_review_history AS history
                    WHERE history.review_id=review.id) AS history_count
             FROM medicaid_era_review AS review WHERE review.id=$1`,
            [persisted.reviewId],
          );
          expect(afterLegacyReassess.rows).toEqual(beforeLegacyReassess.rows);
          const legacyReassessmentResponse = await apiRequest(
            "POST",
            `/api/v1/remittance/medicaid-era-artifacts/${stageId}/evaluate`,
            { idempotencyKey: "synthetic-l6d-legacy-fingerprint-match-0001" },
          );
          expect(legacyReassessmentResponse.status).toBe(200);
          expect(await legacyReassessmentResponse.json()).toMatchObject({
            status: "review_saved",
            version: 7,
            replay: false,
          });
          const legacyPromotionHistory = await workflow.history(actor, persisted.reviewId);
          expect(
            legacyPromotionHistory.map(({ version, action, trustStatus }) => ({
              version,
              action,
              trustStatus,
            })),
          ).toEqual([
            { version: 1, action: "assessed", trustStatus: "isolated_evaluator" },
            { version: 2, action: "note", trustStatus: "isolated_evaluator" },
            { version: 3, action: "reviewed_not_posted", trustStatus: "isolated_evaluator" },
            { version: 4, action: "reopened", trustStatus: "isolated_evaluator" },
            { version: 5, action: "reassessed", trustStatus: "isolated_evaluator" },
            { version: 6, action: "legacy_unverified", trustStatus: "legacy_unverified" },
            { version: 7, action: "reassessed", trustStatus: "isolated_evaluator" },
          ]);
          const legacyDetail = await workflow.detail(actor, a.medicaidEraReview);
          expect(legacyDetail).toMatchObject({
            organizationId: ORG_A,
            providerEntityId: "33333333-3333-3333-3333-333333333333",
            assessmentTrustStatus: "legacy_unverified",
            accountReference: null,
            sourceEnvironment: null,
            sourceDigest: null,
            stageId: null,
            canonicalPayerId: null,
            programId: null,
            decisionStatus: "unverified",
            reasonCodes: ["LEGACY_ASSESSMENT_UNVERIFIED"],
            claimMatchStatus: "UNVERIFIED",
            duplicateStatus: "unverified",
            safeSummary: null,
          });
          const legacyHistory = await workflow.history(actor, a.medicaidEraReview);
          expect(legacyHistory).toHaveLength(1);
          expect(legacyHistory[0]).toMatchObject({
            version: 1,
            action: "legacy_unverified",
            reasonCode: null,
            actorMembershipId: null,
            trustStatus: "legacy_unverified",
          });
          const legacyPage = await workflow.list(actor);
          expect(legacyPage.items.find((item) => item.id === a.medicaidEraReview)).toMatchObject({
            assessmentTrustStatus: "legacy_unverified",
            assessmentObservedAt: null,
            sourceEnvironment: null,
            canonicalPayerId: null,
            programId: null,
            decisionStatus: "unverified",
            claimMatchStatus: "UNVERIFIED",
            duplicateStatus: "unverified",
          });

          if (useBrowserJourney) {
            if (!browserBaseUrl) throw new Error("the immutable web runtime was not started");
            const browser = await chromium.launch({
              headless: true,
              args: ["--no-sandbox"],
              ...(process.env.M25_TEST_CHROMIUM_EXECUTABLE_PATH
                ? { executablePath: process.env.M25_TEST_CHROMIUM_EXECUTABLE_PATH }
                : {}),
            });
            try {
              const context = await browser.newContext({
                viewport: { width: 1440, height: 1000 },
                reducedMotion: "reduce",
              });
              const sessionValue = sessionCookie.slice("better-auth.session_token=".length);
              await context.addCookies([
                {
                  name: "better-auth.session_token",
                  value: sessionValue,
                  url: browserBaseUrl,
                  httpOnly: true,
                  sameSite: "Lax",
                },
              ]);
              const page = await context.newPage();
              const browserErrors: string[] = [];
              const browserApiResponses: string[] = [];
              page.on("pageerror", (error) => browserErrors.push(error.name));
              page.on("response", (response) => {
                const url = new URL(response.url());
                if (url.pathname.startsWith("/api/"))
                  browserApiResponses.push(
                    `${response.request().method()} ${url.pathname} ${response.status()}`,
                  );
              });
              const screenshotDir = join(repositoryRoot, "scratchpad", "l7-v-qualification");
              mkdirSync(screenshotDir, { recursive: true });
              const sideEffectsBeforeBrowser = await db.query<{
                medicaidClaims: number;
                remittanceAdvices: number;
                postingEvents: number;
                outboxEvents: number;
              }>(
                `SELECT
                 (SELECT count(*)::int FROM medicaid_claim WHERE organization_id=$1) AS "medicaidClaims",
                 (SELECT count(*)::int FROM remittance_advice WHERE organization_id=$1) AS "remittanceAdvices",
                 (SELECT count(*)::int FROM claimmd_era_posting_event WHERE organization_id=$1) AS "postingEvents",
                 (SELECT count(*)::int FROM outbox_event WHERE organization_id=$1) AS "outboxEvents"`,
                [ORG_A],
              );
              const sourceNavigation = await page.goto(
                `${browserBaseUrl}/remittance/claimmd-era-review`,
              );
              const sourceHeading = await page
                .getByRole("heading", { name: "Billing / Claim.MD ERA Review" })
                .waitFor({ timeout: 8_000 })
                .then(() => true)
                .catch(() => false);
              if (!sourceHeading)
                throw new Error(
                  `synthetic source page did not render (path=${new URL(page.url()).pathname}, navigation=${sourceNavigation?.status() ?? "none"}, api=${browserApiResponses.join(" | ") || "none"}, pageErrors=${browserErrors.join(",") || "none"})`,
                );
              await page
                .getByRole("button", { name: /Review remittance from/ })
                .first()
                .click();
              await page.getByRole("button", { name: "Evaluate for Medicaid" }).waitFor();
              const sourceA11y = await new AxeBuilder({ page })
                .include(".mer-source-action")
                .analyze();
              expect(sourceA11y.violations.map((violation) => violation.id)).toEqual([]);
              await page.screenshot({
                path: join(screenshotDir, "claimmd-source-desktop.png"),
                fullPage: true,
              });
              await page.getByRole("button", { name: "Evaluate for Medicaid" }).click();
              await page.waitForURL(`**/remittance/medicaid-era-reviews/${persisted.reviewId}`);
              await page.getByRole("heading", { name: "Medicaid ERA investigation" }).waitFor();
              await page
                .getByText("This is not current eligibility verification or payment authorization.")
                .waitFor();
              expect(
                await page
                  .getByRole("button", { name: /post payment|approve posting|force match/i })
                  .count(),
              ).toBe(0);
              const detailA11y = await new AxeBuilder({ page })
                .include(".mer-detail-layout")
                .analyze();
              expect(detailA11y.violations.map((violation) => violation.id)).toEqual([]);
              await page.screenshot({
                path: join(screenshotDir, "medicaid-investigation-desktop.png"),
                fullPage: true,
              });
              await page.getByRole("button", { name: "Re-evaluate evidence" }).click();
              await page.getByText("The existing nonposting assessment is current.").waitFor();
              await page.getByLabel("Investigation reason").selectOption("SOURCE_CONTEXT_REVIEWED");
              await page.getByRole("button", { name: "Record investigation reason" }).click();
              await page
                .getByText("Investigation reason recorded. No payment or claim state was changed.")
                .waitFor();
              page.once("dialog", (dialog) => void dialog.accept());
              await page.getByRole("button", { name: "Complete review — no posting" }).click();
              await page.getByText("Complete review — no posting recorded.").waitFor();
              await page.getByRole("button", { name: "Reopen investigation" }).click();
              await page.getByText("Reopen investigation recorded.").waitFor();
              await page
                .getByRole("list", { name: "Assessment and investigation history" })
                .getByText("Investigation reopened")
                .last()
                .waitFor();
              await page.setViewportSize({ width: 375, height: 812 });
              await expect
                .poll(() =>
                  page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
                )
                .toBe(true);
              await page.screenshot({
                path: join(screenshotDir, "medicaid-investigation-mobile.png"),
                fullPage: true,
              });
              expect(browserErrors).toEqual([]);
              const browserDetail = await workflow.detail(actor, persisted.reviewId);
              expect(browserDetail).toMatchObject({
                assessmentTrustStatus: "isolated_evaluator",
                version: 10,
                workflowState: "reopened",
                safeSummary: {
                  claims: [
                    expect.objectContaining({
                      postingAuthorized: false,
                    }),
                  ],
                },
              });
              expect((await workflow.history(actor, persisted.reviewId)).slice(-3)).toMatchObject([
                { version: 8, action: "note", reasonCode: "SOURCE_CONTEXT_REVIEWED" },
                { version: 9, action: "reviewed_not_posted" },
                { version: 10, action: "reopened" },
              ]);
              const sideEffectsAfterBrowser = await db.query(
                `SELECT
                 (SELECT count(*)::int FROM medicaid_claim WHERE organization_id=$1) AS "medicaidClaims",
                 (SELECT count(*)::int FROM remittance_advice WHERE organization_id=$1) AS "remittanceAdvices",
                 (SELECT count(*)::int FROM claimmd_era_posting_event WHERE organization_id=$1) AS "postingEvents",
                 (SELECT count(*)::int FROM outbox_event WHERE organization_id=$1) AS "outboxEvents"`,
                [ORG_A],
              );
              expect(sideEffectsAfterBrowser.rows).toEqual(sideEffectsBeforeBrowser.rows);
            } finally {
              await browser.close();
            }
          }

          // The general platform SQL credential is the same role used by the API and generic workers.
          // Even a fully source-bound row and an evaluator-shaped summary must be rejected at SQL.
          await expect(
            platformSql.query(
              `INSERT INTO medicaid_era_review (organization_id, provider_entity_id, stage_id, vendor,
             account_reference, source_environment, canonical_payer_id, program_id, source_digest,
             assessment_fingerprint, assessment_version, decision_status, reason_codes, claim_match_status,
             duplicate_status, safe_summary)
             SELECT organization_id, provider_entity_id, id, 'claimmd', account_reference, usage,
               gen_random_uuid(), 'forged-program', source_file_digest, repeat('9',64), 'forged',
               'payment_reported', '[]'::jsonb, 'MATCHED', 'none',
               '{"claims":[{"postingAuthorized":true,"amounts":{"claimPaidCents":999999}}]}'::jsonb
             FROM claimmd_era_m25_stage WHERE id=$1`,
              [stageId],
            ),
          ).rejects.toThrow(/permission denied/);
          await expect(
            platformSql.query(
              `UPDATE medicaid_era_review SET decision_status='payment_reported',
               safe_summary='{"claims":[{"postingAuthorized":true}]}'::jsonb,
               version=version+1 WHERE id=$1`,
              [a.medicaidEraReview],
            ),
          ).rejects.toThrow(/permission denied/);
          await expect(
            db.query(
              `UPDATE medicaid_era_review SET safe_summary=
               '{"claims":[{"postingAuthorized":true}]}'::jsonb, version=version+1 WHERE id=$1`,
              [a.medicaidEraReview],
            ),
          ).rejects.toThrow(/medicaid_era_review_nonposting_summary_ck/);
          await expect(
            platformSql.query(
              `INSERT INTO medicaid_era_review_history
               (organization_id,provider_entity_id,review_id,version,action,actor_membership_id)
             VALUES ($1,$2,$3,99,'assessed',gen_random_uuid())`,
              [ORG_A, providerEntityId, a.medicaidEraReview],
            ),
          ).rejects.toThrow(/permission denied/);
          await expect(platformSql.query("SET ROLE chartwarden_m25_evaluator")).rejects.toThrow(
            /permission denied/,
          );
          const platformPrivilege = await db.query<{
            can_insert: boolean;
            can_update: boolean;
            can_read: boolean;
            can_write_history: boolean;
            can_update_summary_column: boolean;
            can_insert_history_actor_column: boolean;
          }>(
            `SELECT has_table_privilege('chartwarden_platform_login','medicaid_era_review','INSERT') AS can_insert,
                  has_table_privilege('chartwarden_platform_login','medicaid_era_review','UPDATE') AS can_update,
                  has_table_privilege('chartwarden_platform_login','medicaid_era_review','SELECT') AS can_read,
                  has_table_privilege('chartwarden_platform_login','medicaid_era_review_history','INSERT') AS can_write_history,
                  has_column_privilege('chartwarden_platform_login','medicaid_era_review','safe_summary','UPDATE') AS can_update_summary_column,
                  has_column_privilege('chartwarden_platform_login','medicaid_era_review_history','actor_membership_id','INSERT') AS can_insert_history_actor_column`,
          );
          expect(platformPrivilege.rows[0]).toEqual({
            can_insert: false,
            can_update: false,
            can_read: false,
            can_write_history: false,
            can_update_summary_column: false,
            can_insert_history_actor_column: false,
          });
          const evaluatorPrivilege = await db.query<{
            superuser: boolean;
            create_role: boolean;
            create_database: boolean;
            bypass_rls: boolean;
            can_assume: boolean;
            platform_can_assume: boolean;
            app_can_assume: boolean;
            can_post_financials: boolean;
          }>(
            `SELECT role.rolsuper AS superuser,
                  role.rolcreaterole AS create_role,
                  role.rolcreatedb AS create_database,
                  role.rolbypassrls AS bypass_rls,
                  pg_has_role('chartwarden_m25_evaluator_login','chartwarden_m25_evaluator','member') AS can_assume,
                  pg_has_role('chartwarden_platform_login','chartwarden_m25_evaluator','member') AS platform_can_assume,
                  pg_has_role('chartwarden_app','chartwarden_m25_evaluator','member') AS app_can_assume,
                  has_table_privilege('chartwarden_m25_evaluator_login','patient_responsibility_ledger','INSERT') AS can_post_financials
             FROM pg_roles role WHERE role.rolname='chartwarden_m25_evaluator_login'`,
          );
          expect(evaluatorPrivilege.rows[0]).toEqual({
            superuser: false,
            create_role: false,
            create_database: false,
            bypass_rls: false,
            can_assume: true,
            platform_can_assume: false,
            app_can_assume: false,
            can_post_financials: false,
          });
          const sourceReaderPrivilege = await db.query<{
            superuser: boolean;
            bypass_rls: boolean;
            platform_member: boolean;
            direct_inbox_read: boolean;
            direct_delivery_read: boolean;
            direct_stage_protected_read: boolean;
            function_execute: boolean;
          }>(
            `SELECT role.rolsuper AS superuser,role.rolbypassrls AS bypass_rls,
                  pg_has_role('chartwarden_m25_era_source_login','chartwarden_platform','member') AS platform_member,
                  has_table_privilege('chartwarden_m25_era_source_login','claimmd_era_inbox','SELECT') AS direct_inbox_read,
                  has_table_privilege('chartwarden_m25_era_source_login','claimmd_era_delivery','SELECT') AS direct_delivery_read,
                  has_column_privilege('chartwarden_m25_era_source_login','claimmd_era_m25_stage','protected_details_cipher','SELECT') AS direct_stage_protected_read,
                  has_function_privilege('chartwarden_m25_era_source_login',
                    'm25_read_staged_claimmd_era(uuid,uuid,uuid)','EXECUTE') AS function_execute
             FROM pg_roles role WHERE role.rolname='chartwarden_m25_era_source_login'`,
          );
          expect(sourceReaderPrivilege.rows[0]).toEqual({
            superuser: false,
            bypass_rls: false,
            platform_member: false,
            direct_inbox_read: false,
            direct_delivery_read: false,
            direct_stage_protected_read: false,
            function_execute: true,
          });
          await expect(
            platformSql.query(
              "ALTER TABLE medicaid_era_review DISABLE TRIGGER medicaid_era_review_identity_immutable",
            ),
          ).rejects.toThrow(/must be owner|permission denied/);
          await expect(
            platformSql.query(
              "UPDATE medicaid_era_review_history SET trust_status='isolated_evaluator' WHERE review_id=$1",
              [persisted.reviewId],
            ),
          ).rejects.toThrow(/permission denied/);
          await expect(
            platformSql.query("DELETE FROM medicaid_era_review_history WHERE review_id=$1", [
              persisted.reviewId,
            ]),
          ).rejects.toThrow(/permission denied/);
          const bypassAuditRows = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_event
             WHERE event_type='platform.bypass_invoked'
               AND context->>'jobId' = $1`,
            ["m25-evaluator-source-reader"],
          );
          expect(bypassAuditRows.rows[0]?.n).toBeGreaterThanOrEqual(2);
        } finally {
          if (webContainerName)
            spawnSync("docker", ["rm", "--force", webContainerName], { stdio: "ignore" });
          if (useRuntimeContainer) {
            spawnSync("docker", ["rm", "--force", apiContainerName], { stdio: "ignore" });
            spawnSync("docker", ["rm", "--force", runtimeContainerName], { stdio: "ignore" });
          }
          if (!useRuntimeContainer && apiProcess && apiProcess.exitCode === null) {
            const apiExited = new Promise<void>((resolve) =>
              apiProcess?.once("exit", () => resolve()),
            );
            apiProcess.kill("SIGTERM");
            const apiKillTimer = setTimeout(() => apiProcess?.kill("SIGKILL"), 3_000);
            await Promise.race([
              apiExited,
              new Promise<void>((resolve) => setTimeout(resolve, 3_500)),
            ]);
            clearTimeout(apiKillTimer);
          }
          if (runtimeProcess && runtimeProcess.exitCode === null) {
            const exited = new Promise<void>((resolve) =>
              runtimeProcess?.once("exit", () => resolve()),
            );
            runtimeProcess.kill("SIGTERM");
            const killTimer = setTimeout(() => runtimeProcess?.kill("SIGKILL"), 3_000);
            await Promise.race([
              exited,
              new Promise<void>((resolve) => setTimeout(resolve, 3_500)),
            ]);
            clearTimeout(killTimer);
          }
          if (useRuntimeContainer && postgresContainerName) {
            spawnSync(
              "docker",
              ["network", "disconnect", "--force", runtimeNetworkName, postgresContainerName],
              { stdio: "ignore" },
            );
            spawnSync("docker", ["network", "rm", runtimeNetworkName], { stdio: "ignore" });
            spawnSync("docker", ["network", "rm", apiEdgeNetworkName], { stdio: "ignore" });
          }
          if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true });
          await evaluatorReaderSql?.end().catch(() => undefined);
          await sourceReaderSql.end().catch(() => undefined);
          await sourceReaderHandle?.close();
          await platformSql.end();
          await appHandle.close();
        }
      },
      process.env.M25_TEST_BROWSER_E2E === "1" ? 300_000 : 120_000,
    );

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
        const [duplicateStage] = await db
          .query<{
            source_inbox_id: string;
            account_reference: string;
            usage: string;
            era_id: string;
            file_index: number;
            source_file_digest: string;
            state: string;
            safe_reason_code: string;
          }>(
            `SELECT source_inbox_id,account_reference,usage,era_id,file_index,source_file_digest,state,safe_reason_code
             FROM claimmd_era_m25_stage WHERE id=$1`,
            [a.eraStage],
          )
          .then((result) => result.rows);
        const duplicateStageReader = buildDrizzleMedicaidEraReviewReaders(handle.db, {
          readStagedEra: async () => ({
            stage: {
              id: a.eraStage,
              sourceInboxId: duplicateStage!.source_inbox_id,
              vendor: "claimmd",
              accountReference: duplicateStage!.account_reference,
              usage: duplicateStage!.usage as "test" | "production",
              eraId: duplicateStage!.era_id,
              fileIndex: duplicateStage!.file_index,
              sourceFileDigest: duplicateStage!.source_file_digest,
              state: duplicateStage!.state,
              safeReasonCode: duplicateStage!.safe_reason_code,
            },
            captured: {
              inboxId: duplicateStage!.source_inbox_id,
              streamId: "synthetic-stream",
              vendor: "claimmd",
              accountReference: duplicateStage!.account_reference,
              usage: duplicateStage!.usage,
              eraId: duplicateStage!.era_id,
              capturedAt: new Date("2026-11-22T00:00:00.000Z"),
              files: [raw],
            },
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
