/**
 * M23 `claim.submit` worker — the §2.3 submit guard vs. the physical MAC upload — LIVE Postgres.
 *
 * WHY THIS SUITE EXISTS. `routes/write-service-drizzle.ts`'s `submitClaim` deliberately defers the
 * READY → SUBMITTED transition to the worker (only the worker knows whether the 837I physically reached
 * the MAC): it checks the §2.3 zero-unresolved-blocking-failures guard, enqueues `claim.submit`, and
 * emits `m23.claim.submit_requested`. The worker (`runClaimSubmit` / `runClaimSubmitRetry` in
 * `jobs/m23-jobs.ts`) is supposed to generate the 837I, upload it, THEN drive the same pure `submit`
 * guard. Until this fix, the worker called the guard with NO context, and the pure reducer
 * (`packages/billing/src/machines/claim.ts`) fails a `BLOCKING_GUARDED_EVENTS` event CLOSED when its
 * context is omitted — so `nextClaimState(claim.state, "submit")` threw `GUARD_FAILED` on literally every
 * real submission, AFTER the fake/real MAC upload had already happened, rolling back the `terminalize`
 * write inside the same tx. The claim stayed stuck in `ready` forever, `claim.submit` has `attempts: 1`
 * (no BullMQ retry), and no `m23.claim.submission_failed` ever fired (the retry-queue pickup signal) —
 * so a physically-transmitted claim vanished with no visible trace. The 13-test
 * `m23-rls-isolation.live.test.ts` suite never caught this: it manipulates `claim_submission` via raw SQL
 * and never drives the reducer or the worker function at all.
 *
 * This suite calls the worker's processor functions DIRECTLY (bypassing the BullMQ harness — same
 * posture the composition root's `orgScoped` wrapper uses: `withOrgContext(db, {org, user}, tx =>
 * runClaimSubmit(tx, deps, job))`), with FAKE x12/macPortal ports so no real MAC/x12 sidecar is needed.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-claim-submit-worker.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveControlNumber, type repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ClaimSubmitJob,
  type ClaimSubmitRetryJob,
  type M23WorkerDeps,
  runClaimSubmit,
  runClaimSubmitRetry,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const PE = "22222222-2222-2222-2222-222222222222";
const U = "00000000-0000-0000-0000-0000000000ff"; // throwaway uuid for the many logical-FK columns

describe.skipIf(!DB_URL)(
  "M23 claim.submit worker — §2.3 guard vs. real transmission — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };

    async function applyMigrations() {
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector)
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        await admin.query(sql);
      }
    }

    /** Seed a READY claim + (optionally) a clean validation run, and a queued claim_submission attempt. */
    async function seedReadyClaim(opts: {
      patient: string;
      attemptIndex: number;
      /** When true, the latest validation run carries one un-overridden blocking (error) failure. */
      withBlockingFailure: boolean;
    }): Promise<{ claimId: string; submissionId: string; ccn: string }> {
      const placeholderCcn = `pending-${opts.patient}`;
      // `patient_status_code` (migration 0371): a validated claim always carries its derived discharge
      // status, and the 837I claim document refuses to send one without it.
      const claimId = (
        await admin.query(
          `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id,
           election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
           state, claim_control_number, mac_jurisdiction, total_expected_payment_cents,
           sequestration_applied_pct, sequestration_policy_id, created_by_membership_id,
           patient_status_code)
         VALUES ($1,$2,$3,$2,$2,$2,$2,'811','2026-01-01','2026-01-31','READY',$4,'ngs_j6',100000,'2.00',$2,$2,
           '01')
         RETURNING id`,
          [ORG, PE, opts.patient, placeholderCcn],
        )
      ).rows[0].id as string;
      // The real D4 deterministic control number needs the claim's OWN id (its uuid seeds the opaque
      // base36 segment) — so it can only be derived AFTER the insert above, then backfilled.
      const ccn = deriveControlNumber({
        ccn: "ABC123",
        serviceFrom: "2026-01-01",
        claimId: claimId as never,
        attemptIndex: opts.attemptIndex,
      });
      await admin.query("UPDATE claim SET claim_control_number = $1 WHERE id = $2", [ccn, claimId]);

      const runId = (
        await admin.query(
          `INSERT INTO validation_run (organization_id, claim_id, trigger, outcome, run_input_hash,
           rules_executed, rules_passed, rules_failed, rules_warn, rules_info, started_at, completed_at,
           duration_ms)
         VALUES ($1,$2,'initial_assembly',$3,$4,1,$5,$6,0,0, now(), now(), 0) RETURNING id`,
          [
            ORG,
            claimId,
            opts.withBlockingFailure ? "failures_present" : "all_pass",
            `hash-${opts.patient}`,
            opts.withBlockingFailure ? 0 : 1,
            opts.withBlockingFailure ? 1 : 0,
          ],
        )
      ).rows[0].id as string;

      if (opts.withBlockingFailure) {
        await admin.query(
          `INSERT INTO validation_result (organization_id, validation_run_id, rule_key, rule_version, severity,
           outcome)
         VALUES ($1,$2,'RC-001',1,'error','fail')`,
          [ORG, runId],
        );
      }

      const submissionId = (
        await admin.query(
          `INSERT INTO claim_submission (organization_id, provider_entity_id, kind, claim_id, claim_control_number,
           attempt_index, outcome)
         VALUES ($1,$2,'claim_837i',$3,$4,$5,'queued') RETURNING id`,
          [ORG, PE, claimId, ccn, opts.attemptIndex],
        )
      ).rows[0].id as string;

      return { claimId, submissionId, ccn };
    }

    async function claimRow(claimId: string): Promise<{ state: string; version: number }> {
      const { rows } = await admin.query("SELECT state, version FROM claim WHERE id = $1", [
        claimId,
      ]);
      return rows[0];
    }

    async function submissionRow(
      submissionId: string,
    ): Promise<{ outcome: string; outcome_reason: string | null }> {
      const { rows } = await admin.query(
        "SELECT outcome, outcome_reason FROM claim_submission WHERE id = $1",
        [submissionId],
      );
      return rows[0];
    }

    /** Run the worker function inside the same `withOrgContext` envelope the composition root uses. */
    function runInOrg<T>(fn: (tx: repositories.BillingDb) => Promise<T>): Promise<T> {
      return withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        fn(tx as unknown as repositories.BillingDb),
      );
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
        [ORG],
      );
      handle = createDbClient({ connectionString: DB_URL! });
    }, 120_000);

    afterAll(async () => {
      if (handle) await handle.close();
      if (admin) await admin.end();
    });

    it("a clean claim: the worker uploads to the MAC AND drives READY -> SUBMITTED (the confirm-handshake bug)", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      // A late NOE's provider-liable days (OSC 77, ch. 11 §20.1.1), as the validation run derives them.
      await admin.query(
        `UPDATE claim SET occurrence_spans = '[{"code":"77","from":"2026-01-01","through":"2026-01-06"}]'::jsonb
          WHERE id = $1`,
        [claimId],
      );
      let uploaded = false;
      const documents: unknown[] = [];
      const deps: M23WorkerDeps = {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: { publish: async () => {} },
        x12: {
          generate837i: async (input) => {
            documents.push(input.claimDocument);
            return { x12: "ISA*00*...", correlationId: "corr-1" };
          },
          generateNoe: async () => ({ x12: "", correlationId: "" }),
          generateNotr: async () => ({ x12: "", correlationId: "" }),
          parse999: async () => [],
          parse277ca: async () => [],
        },
        macPortal: {
          upload: async () => {
            uploaded = true;
            return { accepted: true, generatedFileUri: "s3://claims/x.837" };
          },
          pullPending999: async () => [],
          pullPending277ca: async () => [],
          probeHealth: async () => true,
        },
      };
      const job: ClaimSubmitJob = {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      };

      await runInOrg((tx) => runClaimSubmit(tx, deps, job));

      expect(uploaded).toBe(true);
      const claim = await claimRow(claimId);
      expect(claim.state).toBe("SUBMITTED");
      // The stored occurrence span reaches the X12 gateway's claim document (837I HI*BI:77:RD8).
      expect(documents).toEqual([
        expect.objectContaining({
          occurrenceSpans: [{ code: "77", from: "2026-01-01", through: "2026-01-06" }],
        }),
      ]);
      const sub = await submissionRow(submissionId);
      expect(sub.outcome).toBe("submitted");
    });

    it("a claim with an unresolved blocking failure: the worker NEVER uploads, and the claim stays READY", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        attemptIndex: 0,
        withBlockingFailure: true,
      });
      let uploaded = false;
      const deps: M23WorkerDeps = {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: { publish: async () => {} },
        x12: {
          generate837i: async () => {
            uploaded = true; // would-be transmission — must never be reached
            return { x12: "ISA*00*...", correlationId: "corr-2" };
          },
          generateNoe: async () => ({ x12: "", correlationId: "" }),
          generateNotr: async () => ({ x12: "", correlationId: "" }),
          parse999: async () => [],
          parse277ca: async () => [],
        },
        macPortal: {
          upload: async () => {
            uploaded = true;
            return { accepted: true, generatedFileUri: "s3://claims/x.837" };
          },
          pullPending999: async () => [],
          pullPending277ca: async () => [],
          probeHealth: async () => true,
        },
      };
      const job: ClaimSubmitJob = {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      };

      await runInOrg((tx) => runClaimSubmit(tx, deps, job));

      expect(uploaded).toBe(false);
      const claim = await claimRow(claimId);
      expect(claim.state).toBe("READY");
      const sub = await submissionRow(submissionId);
      expect(sub.outcome).toBe("failed_worker");
      expect(sub.outcome_reason).toMatch(/no longer submit-eligible/);
    });

    it("claim.submit.retry: a clean retry also drives READY -> SUBMITTED", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      const deps: M23WorkerDeps = {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: { publish: async () => {} },
        alerts: { dispatch: async () => {} },
        x12: {
          generate837i: async () => ({ x12: "ISA*00*...", correlationId: "corr-3" }),
          generateNoe: async () => ({ x12: "", correlationId: "" }),
          generateNotr: async () => ({ x12: "", correlationId: "" }),
          parse999: async () => [],
          parse277ca: async () => [],
        },
        macPortal: {
          upload: async () => ({ accepted: true, generatedFileUri: "s3://claims/retry.837" }),
          pullPending999: async () => [],
          pullPending277ca: async () => [],
          probeHealth: async () => true,
        },
      };
      const job: ClaimSubmitRetryJob = {
        organizationId: ORG,
        claimId,
        submissionId,
        attemptIndex: 0,
      };

      await runInOrg((tx) => runClaimSubmitRetry(tx, deps, job));

      const claim = await claimRow(claimId);
      expect(claim.state).toBe("SUBMITTED");
    });
  },
);
