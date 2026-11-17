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
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveControlNumber,
  generateExternalPatientControlNumber,
  repositories,
} from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
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
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";
import { MIGRATIONS_DIR, applyMigrations } from "../../../scripts/db/migrate";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-4222-8222-2222ca7eb002";
const PE = "22222222-2222-2222-2222-222222222222";
const PE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const U = "00000000-0000-0000-0000-0000000000ff"; // throwaway uuid for the many logical-FK columns
const CLAIM_SUBMISSION_BINDING_FINGERPRINT = "a".repeat(64);

if (process.env.CHARTWARDEN_REQUIRE_LIVE === "1" && !DB_URL) {
  throw new Error("CHARTWARDEN_REQUIRE_LIVE=1 requires a private CHARTWARDEN_TEST_DATABASE_URL");
}

describe.skipIf(!DB_URL)(
  "M23 claim.submit worker — §2.3 guard vs. real transmission — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };

    /** Seed a READY claim + (optionally) a clean validation run, and a queued claim_submission attempt. */
    async function seedReadyClaim(opts: {
      patient: string;
      attemptIndex: number;
      organizationId?: string;
      providerEntityId?: string;
      bindClaimMd?: boolean;
      bindStedi?: boolean;
      legacyWithoutPcn?: boolean;
      externalPcnValue?: string;
      /** When true, the latest validation run carries one un-overridden blocking (error) failure. */
      withBlockingFailure: boolean;
    }): Promise<{ claimId: string; submissionId: string; ccn: string; externalPcn: string }> {
      const organizationId = opts.organizationId ?? ORG;
      const providerEntityId = opts.providerEntityId ?? PE;
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
          [organizationId, providerEntityId, opts.patient, placeholderCcn],
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
            organizationId,
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
          [organizationId, runId],
        );
      }

      const externalPcn = opts.legacyWithoutPcn
        ? ""
        : (opts.externalPcnValue ?? generateExternalPatientControlNumber());
      const submissionId = (
        await admin.query(
          `INSERT INTO claim_submission (organization_id, provider_entity_id, kind, claim_id, claim_control_number,
           external_patient_control_number, clearinghouse_vendor, clearinghouse_account_reference, clearinghouse_mode,
           expected_route_fingerprint, reviewed_source_fingerprint, attempt_index, outcome)
         VALUES ($1,$2,'claim_837i',$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued') RETURNING id`,
          [
            organizationId,
            providerEntityId,
            claimId,
            ccn,
            opts.legacyWithoutPcn ? null : externalPcn,
            opts.bindClaimMd ? "claimmd" : opts.bindStedi ? "stedi" : null,
            opts.bindClaimMd
              ? "synthetic-worker-test-account"
              : opts.bindStedi
                ? "synthetic-stedi-test-account"
                : null,
            opts.bindClaimMd || opts.bindStedi ? "test" : null,
            opts.bindClaimMd || opts.bindStedi ? CLAIM_SUBMISSION_BINDING_FINGERPRINT : null,
            opts.bindClaimMd || opts.bindStedi ? CLAIM_SUBMISSION_BINDING_FINGERPRINT : null,
            opts.attemptIndex,
          ],
        )
      ).rows[0].id as string;

      return { claimId, submissionId, ccn, externalPcn };
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

    const visibleSubmissionCount = (organizationId: string) =>
      withOrgContext(handle.db, { organizationId, userId: "" }, async (tx) => {
        const result = await tx.execute(sql`SELECT count(*)::int AS n FROM claim_submission`);
        return Number((result as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? -1);
      });

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetPublicSchema(admin);
      await dropLiveRoles(admin);
      const migration = await applyMigrations(admin, {
        migrationsDir: MIGRATIONS_DIR,
        strict: true,
        strictOrphans: true,
      });
      expect(migration.ran).toContain("1505_m23_claim_submission_external_identity_binding.sql");
      expect(migration.ran).toContain("1506_m23_claim_submission_clearinghouse_config_org_fk.sql");
      for (const filename of [
        "1505_m23_claim_submission_external_identity_binding.sql",
        "1506_m23_claim_submission_clearinghouse_config_org_fk.sql",
      ]) {
        const migrationText = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
        const migrationLedger = await admin.query<{ checksum: string }>(
          "SELECT checksum FROM _chartwarden_migration WHERE filename=$1",
          [filename],
        );
        expect(migrationLedger.rows[0]?.checksum).toBe(
          createHash("sha256").update(migrationText).digest("hex"),
        );
      }
      expect(
        await applyMigrations(admin, {
          migrationsDir: MIGRATIONS_DIR,
          strict: true,
          strictOrphans: true,
        }),
      ).toMatchObject({ ran: [], drifted: [], orphaned: [] });
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name,status)
         VALUES ($1,'org-a','Synthetic A','Synthetic A','active'),($2,'org-b','Synthetic B','Synthetic B','active')`,
        [ORG, ORG_B],
      );
      const appUrl = await appRoleConnectionString(admin, DB_URL!);
      handle = createDbClient({ connectionString: appUrl, max: 5 });
    }, 300_000);

    afterAll(async () => {
      if (handle) await handle.close();
      if (admin) await admin.end();
    });

    it("a clean claim: the worker uploads to the MAC AND drives READY -> SUBMITTED (the confirm-handshake bug)", async () => {
      const { claimId, submissionId, ccn, externalPcn } = await seedReadyClaim({
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
        externalPatientControlNumber: externalPcn,
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
      const { claimId, submissionId, ccn, externalPcn } = await seedReadyClaim({
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
        externalPatientControlNumber: externalPcn,
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

    it("holds a legacy queued attempt without an external PCN instead of inventing a send identity", async () => {
      const { claimId, submissionId, ccn } = await seedReadyClaim({
        patient: "abababab-abab-abab-abab-abababababab",
        attemptIndex: 0,
        legacyWithoutPcn: true,
        withBlockingFailure: false,
      });
      let uploads = 0;
      const deps: M23WorkerDeps = {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: { publish: async () => {} },
        x12: {
          generate837i: async () => ({ x12: "ISA*00*...", correlationId: "legacy" }),
          generateNoe: async () => ({ x12: "", correlationId: "" }),
          generateNotr: async () => ({ x12: "", correlationId: "" }),
          parse999: async () => [],
          parse277ca: async () => [],
        },
        macPortal: {
          upload: async () => {
            uploads += 1;
            return { accepted: true, generatedFileUri: "synthetic://should-not-upload" };
          },
          pullPending999: async () => [],
          pullPending277ca: async () => [],
          probeHealth: async () => true,
        },
      };
      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        externalPatientControlNumber: "",
        attemptIndex: 0,
      });
      expect(uploads).toBe(0);
      expect(await submissionRow(submissionId)).toMatchObject({
        outcome: "held_stale_source",
        outcome_reason: "EXTERNAL_PCN_REQUIRES_REVIEW",
        dispatch_state: "finished",
      });
      expect(
        (await admin.query("SELECT external_patient_control_number FROM claim_submission WHERE id=$1", [submissionId]))
          .rows[0].external_patient_control_number,
      ).toBeNull();
    });

    it("claim.submit.retry: a clean retry also drives READY -> SUBMITTED", async () => {
      const { claimId, submissionId, ccn, externalPcn } = await seedReadyClaim({
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
      const { claimId, submissionId, ccn, externalPcn } = await seedReadyClaim({
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
        externalPatientControlNumber: externalPcn,
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
            claimMdRouteFingerprint: string;
          }
      >;
      onFailure?: () => void;
    }): M23WorkerDeps {
      const vendor = new InMemoryClearinghouse();
      const claimX12 = readFileSync(
        join(
          process.cwd(),
          "packages/x12-837-client/src/clearinghouse/__fixtures__/stedi-claim.x12",
        ),
        "utf8",
      );
      return {
        connection: {} as never,
        db: handle.db as unknown as repositories.BillingDb,
        outbox: {
          publish: async (_tx: unknown, event: { eventName: string }) => {
            if (event.eventName === "m23.claim.submission_failed") opts.onFailure?.();
          },
        },
        renderClaim: async ({ claimControlNumber }: { claimControlNumber: string }) => ({
          x12: claimX12.replace(/CLM\*[^*]+\*/, `CLM*${claimControlNumber}*`),
          correlationId: "corr-per-org",
          sourceFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
        }),
        transport: {
          binding: {
            vendor: null,
            transport: NOT_WIRED_TRANSPORT,
            forOrg: async () => {
              await opts.onResolve();
              return { vendor: "claimmd", transport: vendor };
            },
          },
          contexts: { contextFor: opts.contextFor, providerEntitiesFor: async () => [PE] },
          claimMdEvidence: {
            accountReference: "synthetic-worker-test-account",
            usage: "test",
            reserve: async () => "synthetic-evidence-id",
            observe: async () => {},
          },
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
      claimMdRouteFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
    });
    const idleInTransaction = async (): Promise<number> =>
      (
        await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`)
      ).rows[0].n;

    it("resolves the org's transport once, before any transaction (never a second pooled connection inside one)", async () => {
      const { claimId, submissionId, ccn, externalPcn } = await seedReadyClaim({
        patient: "f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1",
        attemptIndex: 0,
        bindClaimMd: true,
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
        externalPatientControlNumber: externalPcn,
        reviewedSourceFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
        expectedRouteFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
        attemptIndex: 0,
      };
      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);
      expect(await submissionRow(submissionId)).toMatchObject({
        outcome: "submitted",
        dispatch_state: "finished",
      });
      // once for the job (generate re-used it), and with no worker transaction open at that moment
      expect(openTransactionsAtResolve).toHaveLength(1);
      expect(openTransactionsAtResolve.slice(0, 1)).toEqual([0]);
      expect(openTransactionsAtResolve.every((n) => n === 0)).toBe(true);
    });

    it("an upload that fails before reaching the vendor (no context) is a plain failed attempt, never TRANSPORT_OUTCOME_UNCERTAIN", async () => {
      const { claimId, submissionId, ccn, externalPcn } = await seedReadyClaim({
        patient: "f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2",
        attemptIndex: 0,
        bindClaimMd: true,
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
        externalPatientControlNumber: externalPcn,
        reviewedSourceFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
        expectedRouteFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
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
      const { claimId, submissionId, ccn, externalPcn } = await seedReadyClaim({
        patient: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      let uploads = 0;
      let enterUpload!: () => void;
      let releaseUpload!: () => void;
      const uploadEntered = new Promise<void>((resolve) => {
        enterUpload = resolve;
      });
      const uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
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
            enterUpload();
            await uploadGate;
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
        externalPatientControlNumber: externalPcn,
        attemptIndex: 0,
      };
      const first = runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);
      await uploadEntered;
      await runClaimSubmit(handle.db as unknown as repositories.BillingDb, deps, job);
      releaseUpload();
      await first;
      expect(uploads).toBe(1);
      expect(await submissionRow(submissionId)).toMatchObject({
        outcome: "submitted",
        dispatch_state: "finished",
      });
    });

    it("1505 installs the PCN index and immutable binding trigger while preserving database-enforced RLS", async () => {
      const { rows } = await admin.query<{
        index_exists: boolean;
        trigger_exists: boolean;
        rls: boolean;
        forced: boolean;
        app_insert: boolean;
        app_update: boolean;
      }>(
        `SELECT to_regclass('claim_submission_external_pcn_uq') IS NOT NULL AS index_exists,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_claim_submission_identity_binding_immutable') AS trigger_exists,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('chartwarden_app','claim_submission','INSERT') AS app_insert,
          has_table_privilege('chartwarden_app','claim_submission','UPDATE') AS app_update
         FROM pg_class c WHERE c.oid='claim_submission'::regclass`,
      );
      expect(rows[0]).toEqual({
        index_exists: true,
        trigger_exists: true,
        rls: true,
        forced: true,
        app_insert: true,
        app_update: true,
      });
      const relation = await admin.query<{ valid: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='claim_submission_clearinghouse_config_org_fk' AND contype='f') AS valid`,
      );
      expect(relation.rows[0]?.valid).toBe(true);
    });

    it("rejects a clearinghouse configuration owned by another organization at the database boundary", async () => {
      const configB = randomUUID();
      await admin.query(
        `INSERT INTO tenant_clearinghouse_config (id,organization_id,vendor,mode,status,set_by_membership_id)
         VALUES ($1,$2,'stedi','test','draft',$3)`,
        [configB, ORG_B, U],
      );
      await expect(
        admin.query(
          `INSERT INTO claim_submission (
            organization_id,provider_entity_id,kind,claim_id,claim_control_number,clearinghouse_vendor,
            clearinghouse_account_reference,clearinghouse_mode,clearinghouse_config_id,
            clearinghouse_config_version,clearinghouse_credential_fingerprint,expected_route_fingerprint,
            attempt_index,outcome
          ) VALUES ($1,$2,'claim_837i',$3,'M23-CROSS-ORG-CONFIG','stedi','synthetic-foreign-config',
            'test',$4,1,$5,$6,92,'queued')`,
          [ORG, PE, (await seedReadyClaim({
            patient: "04040404-0404-0404-0404-040404040404",
            attemptIndex: 0,
            withBlockingFailure: false,
          })).claimId, configB, "c".repeat(64), CLAIM_SUBMISSION_BINDING_FINGERPRINT],
        ),
      ).rejects.toMatchObject({ code: "23503", constraint: "claim_submission_clearinghouse_config_org_fk" });
    });

    it("uses provider-scoped PCN uniqueness and rejects invalid PCN shape in PostgreSQL", async () => {
      const { claimId, externalPcn } = await seedReadyClaim({
        patient: "abababab-abab-abab-abab-abababababac",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      await expect(
        admin.query(
          `INSERT INTO claim_submission
            (organization_id,provider_entity_id,kind,claim_id,claim_control_number,external_patient_control_number,attempt_index)
           VALUES ($1,$2,'claim_837i',$3,'M23-DUPLICATE-PCN',$4,1)`,
          [ORG, PE, claimId, externalPcn],
        ),
      ).rejects.toMatchObject({ code: "23505", constraint: "claim_submission_external_pcn_uq" });
      await expect(
        admin.query(
          `INSERT INTO claim_submission
            (organization_id,provider_entity_id,kind,claim_id,claim_control_number,external_patient_control_number,attempt_index)
           VALUES ($1,$2,'claim_837i',$3,'M23-INVALID-PCN','too-short',1)`,
          [ORG, PE, claimId],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "claim_submission_external_pcn_shape_ck" });
      const otherProvider = await seedReadyClaim({
        patient: "bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc",
        organizationId: ORG_B,
        providerEntityId: PE_B,
        externalPcnValue: externalPcn,
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      expect(otherProvider.externalPcn).toBe(externalPcn);
    });

    it("keeps historical null PCNs readable and refuses changes to persisted PCN or routing evidence", async () => {
      const historyClaim = await seedReadyClaim({
        patient: "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      const historical = await admin.query<{ id: string }>(
        `INSERT INTO claim_submission
          (organization_id,provider_entity_id,kind,claim_id,claim_control_number,attempt_index,outcome)
         VALUES ($1,$2,'claim_837i',$3,'M23-HISTORICAL-CONTROL',1,'queued') RETURNING id`,
        [ORG, PE, historyClaim.claimId],
      );
      expect(
        (await admin.query("SELECT external_patient_control_number FROM claim_submission WHERE id=$1", [historical.rows[0]!.id])).rows[0]
          .external_patient_control_number,
      ).toBeNull();
      const bound = await seedReadyClaim({
        patient: "dededede-dede-dede-dede-dededededede",
        attemptIndex: 0,
        bindClaimMd: true,
        withBlockingFailure: false,
      });
      await expect(
        admin.query("UPDATE claim_submission SET clearinghouse_vendor='stedi' WHERE id=$1", [bound.submissionId]),
      ).rejects.toThrow(/identity is immutable/);
    });

    it("keeps Claim.MD and Stedi submission rows tenant-scoped under the verified application role", async () => {
      const a = await seedReadyClaim({
        patient: "efefefef-efef-efef-efef-efefefefefef",
        attemptIndex: 0,
        bindClaimMd: true,
        withBlockingFailure: false,
      });
      const b = await seedReadyClaim({
        patient: "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
        organizationId: ORG_B,
        providerEntityId: PE_B,
        attemptIndex: 0,
        bindStedi: true,
        withBlockingFailure: false,
      });
      expect(await visibleSubmissionCount(ORG)).toBeGreaterThan(0);
      expect(await visibleSubmissionCount(ORG_B)).toBeGreaterThan(0);
      const crossRead = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, async (tx) => {
        const result = await tx.execute(sql`SELECT id FROM claim_submission WHERE id=${b.submissionId}`);
        return (result as unknown as { rows: unknown[] }).rows.length;
      });
      expect(crossRead).toBe(0);
      const crossUpdate = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, async (tx) => {
        const result = await tx.execute(
          sql`UPDATE claim_submission SET outcome='failed_worker' WHERE id=${b.submissionId} RETURNING id`,
        );
        return (result as unknown as { rows: unknown[] }).rows.length;
      });
      expect(crossUpdate).toBe(0);
      await expect(
        withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
          tx.execute(sql`INSERT INTO claim_submission
            (organization_id,provider_entity_id,kind,claim_id,claim_control_number,attempt_index)
            VALUES (${ORG_B},${PE_B},'claim_837i',${b.claimId},'M23-CROSS-ORG-INSERT',91)`),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      expect(a.claimId).not.toBe(b.claimId);
    });

    it("does not leak tenant context across pooled transactions and keeps an unscoped read empty", async () => {
      const a = await seedReadyClaim({
        patient: "01010101-0101-0101-0101-010101010101",
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      const b = await seedReadyClaim({
        patient: "02020202-0202-0202-0202-020202020202",
        organizationId: ORG_B,
        providerEntityId: PE_B,
        attemptIndex: 0,
        withBlockingFailure: false,
      });
      expect(await visibleSubmissionCount(ORG)).toBeGreaterThan(0);
      expect(await visibleSubmissionCount(ORG_B)).toBeGreaterThan(0);
      const unscoped = await handle.db.execute(sql`SELECT count(*)::int AS n FROM claim_submission`);
      expect(Number((unscoped as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? -1)).toBe(0);
      expect(await visibleSubmissionCount(ORG)).toBeGreaterThan(0);
      expect(await visibleSubmissionCount(ORG_B)).toBeGreaterThan(0);
      expect(a.submissionId).not.toBe(b.submissionId);
    });

    it("uses the production repository for idempotent appends, PCN collision reporting, and restart recovery", async () => {
      const fixture = await seedReadyClaim({
        patient: "03030303-0303-0303-0303-030303030303",
        attemptIndex: 0,
        bindClaimMd: true,
        withBlockingFailure: false,
      });
      const row = (await admin.query("SELECT * FROM claim_submission WHERE id=$1", [fixture.submissionId])).rows[0];
      const input = {
        organizationId: ORG,
        providerEntityId: PE,
        kind: "claim_837i" as const,
        claimId: fixture.claimId,
        claimControlNumber: fixture.ccn,
        externalPatientControlNumber: fixture.externalPcn,
        clearinghouseVendor: "claimmd",
        clearinghouseAccountReference: "synthetic-worker-test-account",
        clearinghouseMode: "test",
        clearinghouseConfigId: null,
        clearinghouseConfigVersion: null,
        clearinghouseCredentialFingerprint: null,
        expectedRouteFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
        attemptIndex: 0,
        outcome: "queued" as const,
        reviewedSourceFingerprint: CLAIM_SUBMISSION_BINDING_FINGERPRINT,
      };
      const replay = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        new repositories.ClaimSubmissionRepository(tx as never).append(input),
      );
      expect(replay.id).toBe(fixture.submissionId);
      expect(replay.externalPatientControlNumber).toBe(fixture.externalPcn);
      await expect(
        withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
          new repositories.ClaimSubmissionRepository(tx as never).append({
            ...input,
            claimControlNumber: `${fixture.ccn}-DIFFERENT`,
            attemptIndex: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: "EXTERNAL_PCN_COLLISION" });
      const rollbackControl = `${fixture.ccn}-ROLLBACK`;
      await expect(
        withOrgContext(handle.db, { organizationId: ORG, userId: "" }, async (tx) => {
          await new repositories.ClaimSubmissionRepository(tx as never).append({
            ...input,
            claimControlNumber: rollbackControl,
            externalPatientControlNumber: generateExternalPatientControlNumber(),
            attemptIndex: 2,
          });
          throw new Error("synthetic transaction abort");
        }),
      ).rejects.toThrow("synthetic transaction abort");
      const rolledBack = await admin.query(
        "SELECT count(*)::int AS n FROM claim_submission WHERE provider_entity_id=$1 AND claim_control_number=$2",
        [PE, rollbackControl],
      );
      expect(rolledBack.rows[0]?.n).toBe(0);
      await handle.close();
      const appUrl = await appRoleConnectionString(admin, DB_URL!);
      handle = createDbClient({ connectionString: appUrl, max: 5 });
      const recovered = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        new repositories.ClaimSubmissionRepository(tx as never).findById(fixture.submissionId),
      );
      expect(recovered).toMatchObject({
        externalPatientControlNumber: fixture.externalPcn,
        clearinghouseVendor: row.clearinghouse_vendor,
        clearinghouseAccountReference: row.clearinghouse_account_reference,
      });
    });
  },
);
