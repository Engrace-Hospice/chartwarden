/**
 * WX-PR-013 — "Complete one cost-report workflow slice", LIVE Postgres + Redis proof.
 *
 * Proves the launch-defined M27 slice end-to-end for real: manual trial-balance/wage-data import (the
 * already-live "approved input adapter" path — Xero/Gusto OAuth pull stays out of scope, see wiring.ts) →
 * the real BullMQ `RecomputeEnqueuePort` producer (`buildM27RecomputeEnqueue`, this task's core fix) →
 * the §4320/§4330 step-down/per-diem allocation → the §11.B validation rule engine → a real content-hashed
 * snapshot on submit → ECR/PI artifact generation — with a genuine regulatory-blocking failure, a real
 * correction, and the M4 write-audit trail proven along the way. No BullMQ Worker/consumer precedent exists
 * in this codebase's test suite (only a raw ioredis rate-limit-store live test) — this file calls the §4.8
 * processor functions (`runCostAllocationRecompute` / `runValidationRun` / `runEcrGeneration` /
 * `runTrialBalancePull`, exported from jobs/m27-jobs.ts for exactly this purpose) directly against a real
 * `withOrgContext` tx, which exercises the SAME logic `registerM27Workers` wraps in a `Worker` — just
 * without standing up an actual BullMQ consumer loop. The producer→queue WIRING itself (the actual gap this
 * task closes — `refreshInputs`/`allocate`/`triggerTrialBalancePull` previously enqueued nothing) is proven
 * separately, against a real throwaway Redis, via `buildM27RecomputeEnqueue`.
 *
 * Gated on a live DB + Redis so the default `bun run test` stays green:
 *   WARDENX_TEST_DATABASE_URL=postgres://… WARDENX_TEST_REDIS_URL=redis://localhost:6399 \
 *     bunx vitest run apps/backend/__tests__/m27-cost-report-workflow-slice.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDrizzleM27WriteService,
  buildM27AllocationInputs,
  buildM27RecomputeEnqueue,
  buildM27ValidationContext,
  buildM27WorkerDeps,
  runCostAllocationRecompute,
  runEcrGeneration,
  runTrialBalancePull,
  runValidationRun,
} from "../src/modules/27-cost-report/index";
import type { M27WriteActor } from "../src/modules/27-cost-report/routes/actor";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG = "11111111-1111-1111-1111-111111111111";
const PROVIDER_ENTITY = "00000000-0000-0000-0000-0000000000a1";
const USER_ID = "00000000-0000-0000-0000-0000000dea01";
const APPROVER_USER_ID = "00000000-0000-0000-0000-0000000dea02";
const MEMBERSHIP = "00000000-0000-0000-0000-0000000ba0c1";
const APPROVER_MEMBERSHIP = "00000000-0000-0000-0000-0000000ba0c2";

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

/** A minimal in-memory outbox fake — same shape both `WriteOutboxPort` and `WorkerOutboxPort` share
 *  (`bindCallerModule`'s real return type in production). Records every emission for assertion; the
 *  audit_event proof (M4's write-audit trigger) is independent of this — it fires on the underlying
 *  Postgres INSERT/UPDATE regardless of which outbox port is injected. */
function fakeOutbox() {
  const emissions: { eventName: string; payload: Record<string, unknown> }[] = [];
  return {
    emissions,
    port: {
      async publish(
        _tx: unknown,
        input: { eventName: string; payload: Record<string, unknown> },
      ): Promise<void> {
        emissions.push({ eventName: input.eventName, payload: input.payload });
      },
    },
  };
}

/** Every M23/M25/M12/M40 resolver throws — the deny-stub posture every one of these seams actually has in
 *  this environment (none are bound at boot for a bare test harness). The validation rules that read them
 *  must SKIP, never fabricate a pass/fail. */
function unboundValidationContext() {
  return buildM27ValidationContext({
    capResolver: () => {
      throw new Error("M26 CapAccrualReader unbound in test");
    },
    providerEntity: () => {
      throw new Error("M40 MdmEntityProvider unbound in test");
    },
    patientDays: () => {
      throw new Error("M23 PatientDaysProvider unbound in test");
    },
    settlement: () => {
      throw new Error("M25 ClaimSettlementProvider unbound in test");
    },
    drugCost: () => {
      throw new Error("M12 DrugCostBillingReader unbound in test");
    },
  });
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "WX-PR-013 M27 cost-report workflow slice — LIVE Postgres + Redis",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    let connection: ConnectionOptions;
    let recompute: ReturnType<typeof buildM27RecomputeEnqueue>;
    let outbox: ReturnType<typeof fakeOutbox>;

    const actor: M27WriteActor = {
      organizationId: ORG,
      userId: USER_ID,
      roles: ["provider_admin"],
      membershipId: MEMBERSHIP,
      stepUpRecent: true,
    };

    async function applyMigrations(): Promise<void> {
      const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector)
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
        await admin.query(sql);
      }
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
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-wx-pr-013','A','A')",
        [ORG],
      );
      // `M27WriteActor.userId` (the SESSION user id, `withOrgContext`'s app.user_id — the M4 audit trigger's
      // actor_user_id, FK'd to "user") is distinct from `membershipId` (the org-scoped membership row the
      // M27 tables actually author against). Seed both real rows for the acting user and the two-person-
      // control approver.
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'wx-pr-013-actor@x.test')`, [
        USER_ID,
      ]);
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'wx-pr-013-approver@x.test')`, [
        APPROVER_USER_ID,
      ]);
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
        [MEMBERSHIP, USER_ID, ORG],
      );
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
        [APPROVER_MEMBERSHIP, APPROVER_USER_ID, ORG],
      );
      handle = createDbClient({ connectionString: DB_URL! });
      connection = parseRedisUrl(REDIS_URL!);
      recompute = buildM27RecomputeEnqueue(connection);
      outbox = fakeOutbox();
    }, 120_000);

    afterAll(async () => {
      await Promise.all(recompute.queues.map((q) => q.close()));
      if (handle) await handle.close();
      if (admin) await admin.end();
    });

    const writeService = () =>
      buildDrizzleM27WriteService(handle.db, { outbox: outbox.port, recompute: recompute.enqueue });
    const workerDeps = () =>
      buildM27WorkerDeps({
        connection,
        db: handle.db,
        outbox: outbox.port,
        allocationInputs: buildM27AllocationInputs(),
        validationContext: unboundValidationContext(),
      });

    let costReportId: string;
    let badDebtRecordId: string;
    let firstValidationId: string;
    let secondValidationId: string;

    it("manual trial-balance import (the live 'approved input adapter' path) + worksheet fixtures materialize a reproducible allocation via the real BullMQ-enqueued allocation-recompute job", async () => {
      const created = await writeService().createCostReport(actor, {
        providerEntityId: PROVIDER_ENTITY,
        fiscalYearStartDate: "2027-01-01",
        fiscalYearEndDate: "2027-12-31",
      });
      costReportId = created.costReportId;
      expect(created.state).toBe("draft");

      // draft → populating. Enqueues trial-balance-pull + statistics-refresh for REAL onto Redis (no worker
      // consumes them in this test — they simply sit `waiting`, proving the producer wiring without needing
      // a live Xero/Gusto pull, which stays out of this slice's scope).
      const refreshed = await writeService().refreshInputs(actor, costReportId);
      expect(refreshed.trialBalanceJobId).toBeTruthy();
      expect(refreshed.statisticsJobId).toBeTruthy();

      // The manual CSV import — already fully live before this task, unaffected by it. Balanced (debits ==
      // credits) so `tb.debits_equal_credits` passes cleanly in the validation pass below.
      await writeService().manualTrialBalance(actor, costReportId, {
        normalizedAccounts: [
          { glCode: "6000", glName: "RHC direct care", debitCents: 600_000, creditCents: 0 },
          { glCode: "1000", glName: "Cash", debitCents: 0, creditCents: 600_000 },
        ],
      });

      // Worksheet S (cover/certification — the CCN presence check).
      await writeService().putWorksheet(actor, costReportId, "S", {
        expectedVersion: 1,
        data: {
          providerCcn: "990001",
          providerName: "WX-PR-013 Test Hospice",
          fiscalYearBeginDate: "2027-01-01",
          fiscalYearEndDate: "2027-12-31",
          reportType: "as_filed",
          certification: {
            certifyingOfficerName: "",
            certifyingOfficerTitle: "",
            attestationStatement: "",
          },
          electronicallyPrepared: true,
          medicareBalanceDueProviderCents: 0,
          medicaidBalanceDueProviderCents: 0,
          totalCostReportCostsCents: 600_000,
          tiesToWorksheetAGrandTotal: true,
        },
      });
      // Worksheet A — one zero-cost overhead center ("AG") so Worksheet B-1 has a real allocating center to
      // reference (contributes $0 to the pool — the RHC direct cost below is the only real money in the chain).
      await writeService().putWorksheet(actor, costReportId, "A", {
        expectedVersion: 1,
        data: {
          costCenters: [
            {
              code: "AG",
              name: "A&G",
              salariesAndWagesCents: 0,
              employeeBenefitsCents: 0,
              contractedServicesCents: 0,
              suppliesCents: 0,
              otherCostsCents: 0,
              totalCostsCents: 0,
            },
          ],
          totalSalariesAndWagesCents: 0,
          totalEmployeeBenefitsCents: 0,
          totalContractedServicesCents: 0,
          totalSuppliesCents: 0,
          totalOtherCostsCents: 600_000,
          grandTotalCostsCents: 600_000,
          tiesToTrialBalanceWithinDollar: true,
        },
      });
      // Worksheet A-2 — Routine Home Care direct cost (the ONLY real direct cost in this fixture; matches
      // the proven @wardenx/cost-report pure "end-to-end A → B → C ties" unit fixture exactly).
      await writeService().putWorksheet(actor, costReportId, "A-2", {
        expectedVersion: 1,
        data: { entries: [], netDirectCostCents: 600_000 },
      });
      // Worksheet B-1 — the statistical basis for the (zero-cost) A&G step-down.
      await writeService().putWorksheet(actor, costReportId, "B-1", {
        expectedVersion: 1,
        data: {
          columns: [
            {
              generalServiceCostCenterCode: "AG",
              allocationBasis: "accumulated_cost",
              totalStatisticBase: 1,
              unitCostMultiplier: "0",
              statisticalPortions: [{ receivingCenterCode: "RHC", statisticValue: 1 }],
            },
          ],
          andGAllocatedOnAccumulatedCost: true,
          portionsTieToTotalBase: true,
        },
      });

      // The statistics-refresh worker port (M6/M8 seams) is genuinely unbound (see wiring.ts / m27-jobs.ts
      // TODO) — `buildM27AllocationInputs` tolerates a null `statistic_data` row, but Worksheet C's per-diem
      // split needs REAL census days, so this seeds the `statistic_data` row directly via the repository
      // (the exact shape `statistics-refresh` would itself persist) — a real DB write, not a fabricated
      // in-memory number.
      await withOrgContext(handle.db, { organizationId: ORG, userId: USER_ID }, async (tx) => {
        const { StatisticDataRepository } = await import("@wardenx/cost-report");
        await new StatisticDataRepository(tx as unknown as DbClient).create({
          organizationId: ORG,
          costReportId,
          monthlyBreakdown: {
            "2027-01": { rhc: { medicare: { patientDays: 60 }, medicaid: { patientDays: 40 } } },
          },
          visitCountsByDiscipline: {},
          fteCalculations: {},
          bereavementCensus: { contactsCount: 0, visitsCount: 0 },
        });
      });

      // The real §4.8 producer — the actual fix this task delivers. Previously this returned a fake
      // synthetic jobId and enqueued NOTHING; now it's a real `Queue.add` onto Redis.
      const allocated = await writeService().allocate(actor, costReportId);
      expect(allocated.jobId).toBeTruthy();
      expect(allocated.worksheetsToRecompute).toEqual(["B", "C"]);

      // Run the REAL processor directly (no BullMQ consumer precedent in this codebase — see file banner).
      await withOrgContext(handle.db, { organizationId: ORG, userId: USER_ID }, (tx) =>
        runCostAllocationRecompute(tx as unknown as DbClient, workerDeps(), {
          organizationId: ORG,
          costReportId,
        }),
      );

      const rows = await admin.query(
        "SELECT worksheet_code, data FROM cost_report_worksheet WHERE cost_report_id=$1 AND worksheet_code IN ('B','C')",
        [costReportId],
      );
      const b = rows.rows.find((r) => r.worksheet_code === "B")!.data;
      const c = rows.rows.find((r) => r.worksheet_code === "C")!.data;
      // Hand-derived, reproducible: $600,000 RHC direct cost, $0 overhead → B total $600,000, ties to A.
      expect(b.totalFullyAllocatedCostCents).toBe(600_000);
      expect(b.tiesToWorksheetAGrandTotal).toBe(true);
      // 600,000 / 100 days (60 Medicare + 40 Medicaid) = $6,000/day → Medicare $360,000, Medicaid $240,000.
      expect(c.routineHomeCare.medicareCostCents).toBe(360_000);
      expect(c.routineHomeCare.medicaidCostCents).toBe(240_000);
      expect(c.totalHospiceCostCents).toBe(600_000);
      expect(c.tiesToWorksheetBTotal).toBe(true);

      expect(outbox.emissions.some((e) => e.eventName === "m27.allocation.recomputed")).toBe(true);
    });

    it("validation-run fails closed on a real regulatory-blocking defect (an undocumented bad-debt entry) while every M23/M25/M12/M40/M26-gated rule SKIPS rather than fabricating a result", async () => {
      const patched = await writeService().patchCostReport(actor, costReportId, {
        expectedVersion: 2, // draft(1) -> populating(2) from refreshInputs
        badDebtClaimed: true,
      });
      expect(patched.badDebtClaimed).toBe(true);

      const badDebt = await writeService().addBadDebt(actor, costReportId, {
        periodLabel: "2027-Q1",
        debtKind: "deductible",
        amountCents: 5_000,
        collectionEffortsDocumented: false, // deliberately undocumented — the regulatory-blocking defect
      });
      badDebtRecordId = badDebt.recordId;

      const enqueued = await writeService().enqueueValidation(actor, costReportId);
      firstValidationId = enqueued.validationId;
      expect(enqueued.jobId).toBeTruthy();

      await withOrgContext(handle.db, { organizationId: ORG, userId: USER_ID }, (tx) =>
        runValidationRun(tx as unknown as DbClient, workerDeps(), {
          organizationId: ORG,
          costReportId,
          validationId: firstValidationId,
          ruleSetVersion: 1,
        }),
      );

      const results = await admin.query(
        `SELECT r.rule_code, res.outcome FROM cost_report_validation_result res
         JOIN cost_report_validation_rule r ON r.id = res.rule_id
         WHERE res.validation_id=$1`,
        [firstValidationId],
      );
      const outcomeOf = (code: string) => results.rows.find((r) => r.rule_code === code)?.outcome;
      expect(outcomeOf("bad_debt.entry_collection_efforts_documented")).toBe("fail");
      // The M23/M25/M12/M40/M26 seams are genuinely unbound in this harness — these rules must SKIP, never
      // fabricate a pass or fail.
      expect(outcomeOf("cap.aggregate_beneficiary_cap")).toBe("skip");
      expect(outcomeOf("cap.aggregate_payments_within_cap")).toBe("skip");
      expect(outcomeOf("cap.inpatient_20_pct")).toBe("skip");
      expect(outcomeOf("drug_cost.billed_reconciles")).toBe("skip");
      expect(outcomeOf("stats.patient_days_reconcile")).toBe("skip");
      // Everything else in the fixture is deliberately clean.
      expect(outcomeOf("tb.debits_equal_credits")).toBe("pass");
      expect(outcomeOf("alloc.b_ties_to_a")).toBe("pass");
      expect(outcomeOf("perdiem.c_ties_to_b")).toBe("pass");
      expect(outcomeOf("cross.a_grandtotal_ties_b")).toBe("pass");

      const run = await admin.query(
        "SELECT status, failed_count, passed_count, skipped_count FROM cost_report_validation WHERE id=$1",
        [firstValidationId],
      );
      expect(run.rows[0].status).toBe("complete");
      expect(Number(run.rows[0].failed_count)).toBeGreaterThanOrEqual(1);

      const report = await admin.query("SELECT state FROM cost_report WHERE id=$1", [costReportId]);
      expect(report.rows[0].state).toBe("populating"); // validation_complete_fail — a real regulatory block

      expect(
        outbox.emissions.some((e) => e.eventName === "m27.cost_report.validation_completed"),
      ).toBe(true);
      expect(
        outbox.emissions.filter((e) => e.eventName === "m27.cost_report.ready_for_review").length,
      ).toBe(0);
    });

    it("correction — documenting the collection effort and re-running validation passes cleanly, advancing to ready_for_review", async () => {
      await writeService().updateBadDebt(actor, costReportId, badDebtRecordId, {
        collectionEffortsDocumented: true,
      });

      const enqueued = await writeService().enqueueValidation(actor, costReportId);
      secondValidationId = enqueued.validationId;
      expect(secondValidationId).not.toBe(firstValidationId);

      await withOrgContext(handle.db, { organizationId: ORG, userId: USER_ID }, (tx) =>
        runValidationRun(tx as unknown as DbClient, workerDeps(), {
          organizationId: ORG,
          costReportId,
          validationId: secondValidationId,
          ruleSetVersion: 1,
        }),
      );

      const results = await admin.query(
        `SELECT r.rule_code, res.outcome FROM cost_report_validation_result res
         JOIN cost_report_validation_rule r ON r.id = res.rule_id
         WHERE res.validation_id=$1 AND r.rule_code=$2`,
        [secondValidationId, "bad_debt.entry_collection_efforts_documented"],
      );
      expect(results.rows[0].outcome).toBe("pass");

      const run = await admin.query(
        "SELECT status, failed_count, overridden_count FROM cost_report_validation WHERE id=$1",
        [secondValidationId],
      );
      expect(run.rows[0].status).toBe("complete");
      expect(Number(run.rows[0].failed_count) - Number(run.rows[0].overridden_count)).toBe(0);

      const report = await admin.query("SELECT state FROM cost_report WHERE id=$1", [costReportId]);
      expect(report.rows[0].state).toBe("ready_for_review");

      expect(outbox.emissions.some((e) => e.eventName === "m27.cost_report.ready_for_review")).toBe(
        true,
      );
    });

    it("approve + submit produce a real content-hashed snapshot and enqueue ECR generation for real; running the job renders real artifacts, and the M4 write-audit trail carries the real actor", async () => {
      const approved = await writeService().approveForSubmit(actor, costReportId, {
        validationId: secondValidationId,
      });
      expect(approved.state).toBe("approved_for_submit");

      const submitted = await writeService().submit(actor, costReportId, {
        attestedByMembershipId: MEMBERSHIP,
        attestedAt: new Date().toISOString(),
        approvedByMembershipId: APPROVER_MEMBERSHIP, // two-person control: approver != submitter
      });
      expect(submitted.state).toBe("submitted");
      expect(submitted.latestSnapshotId).toBeTruthy();

      const snapshotRow = await admin.query(
        "SELECT id, content_hash_sha256 FROM cost_report_snapshot WHERE id=$1",
        [submitted.latestSnapshotId],
      );
      expect(snapshotRow.rows).toHaveLength(1);
      expect(snapshotRow.rows[0].content_hash_sha256).toMatch(/^[0-9a-f]{64}$/);

      const submissionRow = await admin.query(
        "SELECT id, status, snapshot_id FROM ecr_submission WHERE cost_report_id=$1",
        [costReportId],
      );
      expect(submissionRow.rows).toHaveLength(1);
      expect(submissionRow.rows[0].status).toBe("generating");
      const submissionId = submissionRow.rows[0].id as string;
      const snapshotId = submissionRow.rows[0].snapshot_id as string;

      const emissionsBefore = outbox.emissions.length;
      await withOrgContext(handle.db, { organizationId: ORG, userId: USER_ID }, (tx) =>
        runEcrGeneration(tx as unknown as DbClient, workerDeps(), {
          organizationId: ORG,
          costReportId,
          submissionId,
          snapshotId,
        }),
      );
      const generatedRow = await admin.query("SELECT status FROM ecr_submission WHERE id=$1", [
        submissionId,
      ]);
      expect(generatedRow.rows[0].status).toBe("generated");

      const renderEvents = outbox.emissions.slice(emissionsBefore);
      expect(
        renderEvents.filter((e) => e.eventName === "m27.artifact.render_requested"),
      ).toHaveLength(2);
      const ecrEvent = renderEvents.find(
        (e) => e.eventName === "m27.artifact.render_requested" && e.payload.artifactKind === "ecr",
      );
      const piEvent = renderEvents.find(
        (e) => e.eventName === "m27.artifact.render_requested" && e.payload.artifactKind === "pi",
      );
      expect(typeof ecrEvent?.payload.payloadRef).toBe("string");
      expect((ecrEvent!.payload.payloadRef as string).length).toBeGreaterThan(0);
      expect(typeof piEvent?.payload.payloadRef).toBe("string");

      // The M4 write-audit trigger (independent of the outbox port injected above) — proves the real
      // actor (`actor.userId`, set via withOrgContext's app.user_id) was captured on the submit mutation.
      const audit = await admin.query(
        `SELECT actor_user_id FROM audit_event
         WHERE resource_kind='cost_report' AND resource_id=$1 AND event_type='cost_report.update'
         ORDER BY created_at DESC LIMIT 1`,
        [costReportId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_user_id).toBe(USER_ID);
    });

    it("missing seam — trial-balance-pull (Xero + DEK genuinely unbound) fails closed, marking the import failed and emitting pull_failed rather than fabricating a pull", async () => {
      const report = await writeService().createCostReport(actor, {
        providerEntityId: PROVIDER_ENTITY,
        fiscalYearStartDate: "2028-01-01",
        fiscalYearEndDate: "2028-12-31",
      });
      const missingSeamOutbox = fakeOutbox();
      const deps = buildM27WorkerDeps({
        connection,
        db: handle.db,
        outbox: missingSeamOutbox.port,
        // trialBalanceSeam / dek deliberately left unbound — the real production posture today.
      });

      // Deliberately does NOT throw (WX-PR-013 fixed a real bug here — see runTrialBalancePull's doc
      // comment: it used to re-throw after marking the row failed, which rolled back that very bookkeeping
      // since the whole call runs inside one withOrgContext transaction). The failure is durable and
      // discoverable instead: a completed job, a `status='failed'` row, and a `pull_failed` event.
      await withOrgContext(handle.db, { organizationId: ORG, userId: USER_ID }, (tx) =>
        runTrialBalancePull(tx as unknown as DbClient, deps, {
          organizationId: ORG,
          costReportId: report.costReportId,
          source: "xero",
        }),
      );

      const importRow = await admin.query(
        "SELECT status, failure_reason FROM trial_balance_import WHERE cost_report_id=$1",
        [report.costReportId],
      );
      expect(importRow.rows).toHaveLength(1);
      expect(importRow.rows[0].status).toBe("failed");
      expect(importRow.rows[0].failure_reason).toMatch(/M27WorkerPortUnbound/);
      expect(
        missingSeamOutbox.emissions.some((e) => e.eventName === "m27.trial_balance.pull_failed"),
      ).toBe(true);
    });

    it("duplicate trigger — the real BullMQ producer dedupes identical jobIds instead of enqueuing twice", async () => {
      const report = await writeService().createCostReport(actor, {
        providerEntityId: PROVIDER_ENTITY,
        fiscalYearStartDate: "2029-01-01",
        fiscalYearEndDate: "2029-12-31",
      });
      const first = await writeService().triggerTrialBalancePull(actor, report.costReportId);
      const second = await writeService().triggerTrialBalancePull(actor, report.costReportId);
      expect(second.jobId).toBe(first.jobId);

      const inspectQueue = new Queue("trial-balance-pull", { connection });
      try {
        const job = await inspectQueue.getJob(first.jobId);
        expect(job).not.toBeNull();
        expect(job?.data.costReportId).toBe(report.costReportId);
      } finally {
        await inspectQueue.close();
      }
    });
  },
);
