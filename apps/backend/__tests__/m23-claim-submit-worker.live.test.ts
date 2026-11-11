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
import { CH, NOT_WIRED_TRANSPORT } from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ClaimSubmitJob,
  type ClaimSubmitRetryJob,
  type M23WorkerDeps,
  runClaimSubmit,
  runClaimSubmitRetry,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { LIVE_DROP_ROLES } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = LIVE_DROP_ROLES;
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
    ): Promise<{ outcome: string; outcome_reason: string | null; dispatch_state: string }> {
      const { rows } = await admin.query(
        "SELECT outcome, outcome_reason, dispatch_state FROM claim_submission WHERE id = $1",
        [submissionId],
      );
      return rows[0];
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

      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);

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

      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);

      expect(uploaded).toBe(false);
      const claim = await claimRow(claimId);
      expect(claim.state).toBe("READY");
      const sub = await submissionRow(submissionId);
      expect(sub.outcome).toBe("failed_worker");
      expect(sub.outcome_reason).toBe("CLAIM_NO_LONGER_ELIGIBLE");
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

      await runClaimSubmitRetry(handle.db as unknown as repositories.BillingDb, deps, job);

      const claim = await claimRow(claimId);
      expect(claim.state).toBe("SUBMITTED");
    });

    it("commits the send reservation before transport and never re-sends an uncertain outcome", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      let uploads = 0;
      let publishedFailure = false;
      const deps: M23WorkerDeps = {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: {
          publish: async (_tx, event) => {
            if (event.eventName === "m23.claim.submission_failed") publishedFailure = true;
          },
        },
        x12: {
          generate837i: async () => ({ x12: "ISA*00*...", correlationId: "corr-uncertain" }),
          generateNoe: async () => ({ x12: "", correlationId: "" }),
          generateNotr: async () => ({ x12: "", correlationId: "" }),
          parse999: async () => [],
          parse277ca: async () => [],
        },
        macPortal: {
          upload: async () => {
            uploads += 1;
            const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`);
            expect(rows[0].n).toBe(0);
            throw new Error("connection closed after remote receipt may have been accepted");
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
      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);
      expect(await submissionRow(submissionId)).toMatchObject({
        outcome: "queued",
        dispatch_state: "in_doubt",
      });
      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);
      expect(uploads).toBe(1);
      expect(publishedFailure).toBe(false);
    });

    // ── tenant clearinghouses: the org's transport is resolved per organization, never inside a worker transaction ──
    /** Per-org deps over an in-memory vendor; `onResolve` runs at every `forOrg`, `contextFor` is the injected context port. */
    function perOrgDeps(opts: {
      onResolve: () => Promise<void>;
      contextFor: () => Promise<
        | never
        | {
            organizationId: string;
            providerEntityId: string;
            payerId: string;
            correlationId: string;
            usage: "test";
            jurisdiction: string;
          }
      >;
      onFailure?: () => void;
    }): M23WorkerDeps {
      const vendor = new InMemoryClearinghouse();
      return {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: {
          publish: async (_tx: unknown, event: { eventName: string }) => {
            if (event.eventName === "m23.claim.submission_failed") opts.onFailure?.();
          },
        },
        renderClaim: async () => ({
          x12: "ISA*00*...",
          correlationId: "corr-per-org",
          sourceFingerprint: null,
        }),
        transport: {
          binding: {
            vendor: null,
            transport: NOT_WIRED_TRANSPORT,
            forOrg: async () => {
              await opts.onResolve();
              return { vendor: "in_memory", transport: vendor };
            },
          },
          contexts: { contextFor: opts.contextFor, providerEntitiesFor: async () => [PE] },
        },
      } as unknown as M23WorkerDeps;
    }
    const goodContext = async () => ({
      organizationId: ORG,
      providerEntityId: PE,
      payerId: "ngs_j6",
      correlationId: "corr",
      usage: "test" as const,
      jurisdiction: "ngs_j6",
    });
    const idleInTransaction = async (): Promise<number> =>
      (
        await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`)
      ).rows[0].n;

    it("resolves the org's transport once, before any transaction (never a second pooled connection inside one)", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      const openTransactionsAtResolve: number[] = [];
      const deps = perOrgDeps({
        onResolve: async () => {
          openTransactionsAtResolve.push(await idleInTransaction());
        },
        contextFor: goodContext,
      });
      const job: ClaimSubmitJob = {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      };
      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);
      expect(await submissionRow(submissionId)).toMatchObject({
        outcome: "submitted",
        dispatch_state: "finished",
      });
      // once for the job (generate re-used it), and with no worker transaction open at that moment
      expect(openTransactionsAtResolve.slice(0, 1)).toEqual([0]);
      expect(openTransactionsAtResolve.every((n) => n === 0)).toBe(true);
    });

    it("an upload that fails before reaching the vendor (no context) is a plain failed attempt, never TRANSPORT_OUTCOME_UNCERTAIN", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      let publishedFailure = false;
      const deps = perOrgDeps({
        onResolve: async () => {},
        contextFor: async () => {
          throw new Error("postgres://app:hunter2@10.0.0.9/chartwarden refused");
        },
        onFailure: () => {
          publishedFailure = true;
        },
      });
      const job: ClaimSubmitJob = {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      };
      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);
      expect(await submissionRow(submissionId)).toMatchObject({
        outcome: "failed_portal",
        outcome_reason: CH.UNAVAILABLE,
        dispatch_state: "finished",
      });
      expect(publishedFailure).toBe(true);
      expect(await claimRow(claimId)).toMatchObject({ state: "READY" });
    });

    it("allows only one concurrent worker delivery to acquire the durable send reservation", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      let uploads = 0;
      const deps: M23WorkerDeps = {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: { publish: async () => {} },
        x12: {
          generate837i: async () => ({ x12: "ISA*00*...", correlationId: "corr-concurrent" }),
          generateNoe: async () => ({ x12: "", correlationId: "" }),
          generateNotr: async () => ({ x12: "", correlationId: "" }),
          parse999: async () => [],
          parse277ca: async () => [],
        },
        macPortal: {
          upload: async () => {
            uploads += 1;
            return { accepted: true, generatedFileUri: "s3://claims/concurrent.837" };
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
      await Promise.all([
        runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job),
        runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job),
      ]);
      expect(uploads).toBe(1);
      expect(await submissionRow(submissionId)).toMatchObject({
        outcome: "submitted",
        dispatch_state: "finished",
      });
    });
  },
);
