/**
 * M23 workers over the bound clearinghouse transport (#707) - LIVE Postgres.
 *
 * With `CLEARINGHOUSE_VENDOR` configured the claim submit/retry workers and the 999/277CA ack crons must use the
 * transport and never the legacy MAC portal. This suite drives the real worker functions against the in-memory
 * clearinghouse (the executable specification of the port), with a legacy portal that fails the test if touched, and the
 * real catalog-validating outbox publisher (a payload that drifts from the `m23.*` catalog rolls the worker back).
 *
 * Also: S01 (#708, #754: starts at a real assemble + validate, not a seeded READY claim) the whole Medicare claim cycle (submit -> two-stage ack -> 835 matched by CLP01 -> posted once ->
 * claim state and ledger agree) and S05 (#709) worker kills against the durable attempt store (no blind resend, an
 * operator settles the in-doubt attempt, the audit trail names them).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:clearinghouse-submit:live
 * Local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BillingRuleRegistry,
  claimTotalMatchesLines,
  deriveControlNumber,
  levelOfCareCoherence,
  placeOfServiceConsistency,
  type repositories,
  visitLinesReportable,
} from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { createX12835Client } from "@chartwarden/x12-835-client";
import {
  type AckEvent,
  CONTRACT_OPERATOR_ID,
  type ClearinghouseContext,
  type ClearinghouseTransport,
  type DirectMacGateway,
  DirectMacTransport,
  type SubmissionAttemptStore,
} from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { fixedValidationSeams } from "../src/modules/23-billing-medicare/__tests__/_validation-seams-fixture";
import { createDrizzleAttemptStore } from "../src/modules/23-billing-medicare/clearinghouse-attempt-store";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import {
  M23_OUTBOX_EVENTS,
  buildClaimStateService,
  buildClaimValidationContextPort,
  buildClaimValidationService,
  buildDrizzleM23WriteService,
  buildM23RemittanceConsumer,
} from "../src/modules/23-billing-medicare/index";
import {
  type ClaimSubmitJob,
  type ClaimSubmitRetryJob,
  type M23WorkerDeps,
  runAckPull277ca,
  runAckPull999,
  runClaimSubmit,
  runClaimSubmitRetry,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { buildClaimValidationRunner } from "../src/modules/23-billing-medicare/jobs/m23-worker-ports";
import { buildClaimAssemblyService } from "../src/modules/23-billing-medicare/services/claim-assembly";
import { buildClearinghouseAttemptResolutionService } from "../src/modules/23-billing-medicare/services/clearinghouse-attempt-resolution-service";
import {
  M25_OUTBOX_EVENTS,
  buildM23BackedClaimMatchCandidateProvider,
} from "../src/modules/25-remittance/index";
import {
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
} from "../src/modules/25-remittance/ingest/service-drizzle";
import { buildFullEdi, sha256Hex } from "./_edi835-fixture";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG = "11111111-1111-1111-1111-111111111111";
const PE = "22222222-2222-2222-2222-222222222222";
const CTX: ClearinghouseContext = {
  organizationId: ORG,
  providerEntityId: PE,
  payerId: "ngs_j6",
  correlationId: "corr",
  usage: "test",
  jurisdiction: "ngs_j6",
};
const SCOPE = { organizationId: ORG, providerEntityId: PE, usage: "test" as const };

describe.skipIf(!DB_URL)("M23 workers over the clearinghouse transport - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
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

  async function submissionRow(submissionId: string): Promise<{
    outcome: string;
    outcome_reason: string | null;
    generated_file_uri: string | null;
  }> {
    const { rows } = await admin.query(
      "SELECT outcome, outcome_reason, generated_file_uri FROM claim_submission WHERE id = $1",
      [submissionId],
    );
    return rows[0];
  }

  function runInOrg<T>(fn: (tx: repositories.BillingDb) => Promise<T>): Promise<T> {
    return withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      fn(tx as unknown as repositories.BillingDb),
    );
  }

  const legacyMustNotRun = () => {
    throw new Error("the legacy MAC portal must not be reached when a vendor is bound");
  };

  function depsFor(
    clearinghouse: ClearinghouseTransport,
    vendor: "in_memory" | "direct_mac" = "in_memory",
    x12Text?: string,
    attempts?: SubmissionAttemptStore,
  ): M23WorkerDeps {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
    return {
      connection: {} as never,
      db: handle.db as unknown as repositories.BillingDb,
      outbox: {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m23" } as never),
      },
      alerts: { dispatch: async () => {} },
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      x12: {
        generate837i: async () => ({ x12: x12Text ?? "ISA*00*...~", correlationId: "corr-1" }),
        generateNoe: async () => ({ x12: "", correlationId: "" }),
        generateNotr: async () => ({ x12: "", correlationId: "" }),
        parse999: legacyMustNotRun as never,
        parse277ca: legacyMustNotRun as never,
      },
      macPortal: {
        upload: legacyMustNotRun as never,
        pullPending999: legacyMustNotRun as never,
        pullPending277ca: legacyMustNotRun as never,
        probeHealth: async () => true,
      },
      // These cases exercise the transport, not the rendering (the loader has its own suites and the gap cases below).
      renderClaim: async () => x12Text ?? "ISA*00*...~",
      transport: {
        binding: { vendor, transport: clearinghouse },
        contexts: { contextFor: async () => CTX, providerEntitiesFor: async () => [PE] },
        ...(attempts ? { attempts } : {}),
      },
    };
  }

  async function claimState(claimId: string): Promise<string> {
    return (await admin.query("SELECT state FROM claim WHERE id = $1", [claimId])).rows[0].state;
  }

  /**
   * S01 (#754): a claim that gets to READY the way production does - the real assembly service (claim + lines +
   * initial validation run), the write service's validate (DRAFT -> VALIDATING), the validation-run executor over the
   * production context port (VALIDATING -> READY) and the write service's submit (the queued attempt). Only the M5/M6/M8
   * reader seams are fakes (the seam bindings are proven in m23-claim-assembly-seams.live) and the rule set is the
   * assembly-line rules, so the fake clinical chain is not asked to satisfy CTI/F2F rules.
   */
  async function assembleReadyClaim(): Promise<{
    claimId: string;
    submissionId: string;
    ccn: string;
  }> {
    const now = new Date("2025-11-10T00:00:00.000Z");
    const registry = new BillingRuleRegistry();
    for (const rule of [
      claimTotalMatchesLines,
      levelOfCareCoherence,
      placeOfServiceConsistency,
      visitLinesReportable,
    ])
      registry.registerRule(rule);
    registry.freeze();
    const fixed = fixedValidationSeams(
      { admissionId: randomUUID(), hospiceAdmissionDate: "2025-11-01" },
      now,
    );
    // The fixture's ids are labels; the claim columns are uuids.
    const seams = {
      ...fixed,
      patientPayer: {
        medicarePrimaryForRange: async () => ({
          patientPayerId: randomUUID(),
          medicarePrimary: true,
        }),
      },
      electionPeriods: {
        coveringRange: async (...a: Parameters<typeof fixed.electionPeriods.coveringRange>) =>
          (await fixed.electionPeriods.coveringRange(...a)).map((e) => ({
            ...e,
            electionPeriodId: randomUUID(),
          })),
      },
      levelOfCare: {
        periodsInRange: async (...a: Parameters<typeof fixed.levelOfCare.periodsInRange>) =>
          (await fixed.levelOfCare.periodsInRange(...a)).map((p) => ({
            ...p,
            levelOfCarePeriodId: randomUUID(),
          })),
      },
      referenceData: {
        ...fixed.referenceData,
        activeSequestrationPolicy: async () => ({
          sequestrationPolicyId: randomUUID(),
          percentage: "2.00",
          effectiveFrom: "2025-01-01",
          effectiveTo: null,
        }),
      },
      ruleRegistry: registry,
    };
    const membershipId = (
      await admin.query(`SELECT id FROM membership WHERE user_id = $1 AND organization_id = $2`, [
        CONTRACT_OPERATOR_ID,
        ORG,
      ])
    ).rows[0].id as string;
    const actor = {
      organizationId: ORG,
      userId: CONTRACT_OPERATOR_ID,
      membershipId,
      actorKind: "user" as const,
    };
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: never, e: never) =>
        publisher.publish(tx, { ...(e as object), callerModule: "m23" } as never),
    };
    const write = buildDrizzleM23WriteService(handle.db as never, {
      outbox: outbox as never,
      jobs: { enqueue: async () => ({ jobId: randomUUID() }) },
      providerCcn: { ccnForProviderEntity: async () => "123456" },
    });

    const assembled = await buildClaimAssemblyService(handle.db as never, {
      ...seams,
      outbox: outbox as never,
    }).assemble(actor, {
      providerEntityId: PE,
      patientId: randomUUID(),
      serviceFrom: "2025-11-01",
      serviceTo: "2025-11-07",
      tob: "812",
    });
    expect(assembled).toMatchObject({ state: "DRAFT", initialValidationOutcome: "all_pass" });

    const writeActor = { ...actor, roles: ["org_admin"], stepUpRecent: true };
    const { validationRunId } = await write.validateClaim(writeActor, assembled.claimId);
    const validation = buildClaimValidationService(
      handle.db as never,
      registry,
      buildClaimStateService(handle.db as never, { outbox: outbox as never }),
      {
        contextPort: buildClaimValidationContextPort({
          seams,
          eligibilityBound: false,
          now: () => now,
        }),
      },
    );
    await runInOrg((tx) =>
      buildClaimValidationRunner({ validation }).run({
        tx: tx as never,
        organizationId: ORG,
        claimId: assembled.claimId,
        validationRunId,
        trigger: "initial_assembly",
      }),
    );
    expect(await claimState(assembled.claimId)).toBe("READY");

    const accepted = await write.submitClaim(writeActor, assembled.claimId);
    return {
      claimId: assembled.claimId,
      submissionId: accepted.submissionId,
      ccn: accepted.claimControlNumber,
    };
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
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'op@m23-ch.test')`, [
      CONTRACT_OPERATOR_ID,
    ]);
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [CONTRACT_OPERATOR_ID, ORG],
    );
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // The registration production boot makes, so M25's CLP01 matcher reaches the real `claim` table.
    registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(handle.db));
  }, 240_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("a clean claim goes READY -> SUBMITTED through the clearinghouse, never the legacy portal", async () => {
    const clearinghouse = new InMemoryClearinghouse();
    const { claimId, submissionId, ccn } = await seedReadyClaim({
      patient: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      attemptIndex: 0,
      withBlockingFailure: false,
    });
    const job: ClaimSubmitJob = {
      organizationId: ORG,
      claimId,
      submissionId,
      claimControlNumber: ccn,
      attemptIndex: 0,
    };

    await runInOrg((tx) => runClaimSubmit(tx, depsFor(clearinghouse), job));

    expect(await claimState(claimId)).toBe("SUBMITTED");
    const sub = await submissionRow(submissionId);
    expect(sub.outcome).toBe("submitted");
    expect(sub.generated_file_uri).toMatch(/^clearinghouse:in_memory:/);
    const status = await clearinghouse.fetchClaimStatus(CTX, ccn);
    expect(status).toMatchObject({ ok: true, data: { state: "received" } });
  });

  /** The REAL loader over a claim row with no lines, no admission and no parties: every gap, no beneficiary read. */
  function gappedLoaderDeps(clearinghouse: ClearinghouseTransport) {
    const unreachable = (what: string) => () => {
      throw new Error(`${what} must not be read for a claim that cannot be sent`);
    };
    const { renderClaim: _stub, ...deps } = depsFor(clearinghouse);
    return {
      ...deps,
      claim837i: {
        admission: { resolveForRange: async () => null },
        mbiUnlock: unreachable("the MBI"),
        patients: { findById: unreachable("the patient") } as never,
        addresses: { primaryAddress: unreachable("the address") } as never,
        parties: () => ({
          partiesFor: async () => ({
            submitter: null,
            receiver: null,
            billingProvider: null,
            payer: null,
          }),
        }),
      },
    } satisfies M23WorkerDeps;
  }

  it("a loader gap fails the attempt as failed_worker naming the gaps, and nothing is sent", async () => {
    const clearinghouse = new InMemoryClearinghouse();
    const { claimId, submissionId, ccn } = await seedReadyClaim({
      patient: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
      attemptIndex: 0,
      withBlockingFailure: false,
    });
    const job: ClaimSubmitJob = {
      organizationId: ORG,
      claimId,
      submissionId,
      claimControlNumber: ccn,
      attemptIndex: 0,
    };

    await runInOrg((tx) => runClaimSubmit(tx, gappedLoaderDeps(clearinghouse), job));

    expect(await claimState(claimId)).toBe("READY");
    const sub = await submissionRow(submissionId);
    expect(sub.outcome).toBe("failed_worker");
    expect(sub.outcome_reason).toContain("837I is not sendable");
    expect(sub.outcome_reason).toContain("submitter (missing)");
    expect(sub.outcome_reason).toContain("billingProvider (missing)");
    expect(await clearinghouse.fetchClaimStatus(CTX, ccn)).not.toMatchObject({
      data: { state: "received" },
    });
  });

  it("a loader gap on the retry worker records a failed_worker attempt and keeps the claim READY", async () => {
    const clearinghouse = new InMemoryClearinghouse();
    const { claimId, submissionId } = await seedReadyClaim({
      patient: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
      attemptIndex: 0,
      withBlockingFailure: false,
    });
    const job: ClaimSubmitRetryJob = {
      organizationId: ORG,
      claimId,
      submissionId,
      attemptIndex: 0,
    };

    await runInOrg((tx) => runClaimSubmitRetry(tx, gappedLoaderDeps(clearinghouse), job));

    expect(await claimState(claimId)).toBe("READY");
    const { rows } = await admin.query(
      "SELECT outcome, outcome_reason FROM claim_submission WHERE claim_id = $1 AND attempt_index = 1",
      [claimId],
    );
    expect(rows[0]?.outcome).toBe("failed_worker");
    expect(rows[0]?.outcome_reason).toContain("submitter (missing)");
  });

  it("the retry worker files through the vendor; an outage leaves the claim READY with a failed_portal attempt", async () => {
    const clearinghouse = new InMemoryClearinghouse();
    const { claimId, submissionId } = await seedReadyClaim({
      patient: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      attemptIndex: 0,
      withBlockingFailure: false,
    });
    await clearinghouse.control.setOutage(true);
    const job: ClaimSubmitRetryJob = {
      organizationId: ORG,
      claimId,
      submissionId,
      attemptIndex: 0,
    };
    await runInOrg((tx) => runClaimSubmitRetry(tx, depsFor(clearinghouse), job));
    expect(await claimState(claimId)).toBe("READY");
    const failed = await admin.query(
      "SELECT outcome, outcome_reason FROM claim_submission WHERE claim_id = $1 ORDER BY attempt_index DESC LIMIT 1",
      [claimId],
    );
    expect(failed.rows[0].outcome).toBe("failed_portal");
    expect(failed.rows[0].outcome_reason).toMatch(/CH_UNAVAILABLE/);

    await clearinghouse.control.setOutage(false);
    await runInOrg((tx) => runClaimSubmitRetry(tx, depsFor(clearinghouse), job));
    expect(await claimState(claimId)).toBe("SUBMITTED");
  });

  it("an upload left in doubt is not re-sent by the retry worker under a fresh control number", async () => {
    const inMemory = new InMemoryClearinghouse();
    const inDoubt = Object.create(inMemory) as InMemoryClearinghouse;
    inDoubt.submitClaim = async () => ({
      ok: false,
      degraded: { code: "CH_IN_DOUBT", reason: "the MAC portal upload may have landed" },
    });
    const deps = depsFor(inMemory);
    const doubtful: M23WorkerDeps = {
      ...deps,
      transport: {
        ...(deps.transport as NonNullable<M23WorkerDeps["transport"]>),
        binding: { vendor: "in_memory", transport: inDoubt },
      },
    };
    const { claimId, submissionId, ccn } = await seedReadyClaim({
      patient: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      attemptIndex: 0,
      withBlockingFailure: false,
    });
    await runInOrg((tx) =>
      runClaimSubmit(tx, doubtful, {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      }),
    );
    expect(await claimState(claimId)).toBe("READY");
    expect((await submissionRow(submissionId)).outcome_reason).toMatch(/CH_IN_DOUBT/);

    // The healthy transport must not be asked to file it again until the attempt is reconciled.
    const retry: ClaimSubmitRetryJob = {
      organizationId: ORG,
      claimId,
      submissionId,
      attemptIndex: 0,
    };
    await expect(runInOrg((tx) => runClaimSubmitRetry(tx, deps, retry))).rejects.toThrow(
      /in doubt/,
    );
    expect(await claimState(claimId)).toBe("READY");
  });

  it("the ack crons pull both stages from the vendor: clearinghouse accept -> ACK_PENDING, payer accept -> ACK_ACCEPTED", async () => {
    const clearinghouse = new InMemoryClearinghouse();
    const deps = depsFor(clearinghouse);
    const { claimId, submissionId, ccn } = await seedReadyClaim({
      patient: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      attemptIndex: 0,
      withBlockingFailure: false,
    });
    await runInOrg((tx) =>
      runClaimSubmit(tx, deps, {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      }),
    );

    await clearinghouse.control.clearinghouseAccepts(ccn, SCOPE);
    await runAckPull999(deps);
    expect(await claimState(claimId)).toBe("ACK_PENDING");

    // The clearinghouse-stage answer alone never reaches ACK_ACCEPTED (ADR-0053 D2).
    await runAckPull277ca(deps);
    expect(await claimState(claimId)).toBe("ACK_PENDING");

    await clearinghouse.control.payerAccepts(ccn, "ICN-LIVE-1", SCOPE);
    await runAckPull277ca(deps);
    expect(await claimState(claimId)).toBe("ACK_ACCEPTED");
    // Re-pulling from the start is a no-op (the ack row is unique per event).
    await runAckPull999(deps);
    await runAckPull277ca(deps);
    expect(await claimState(claimId)).toBe("ACK_ACCEPTED");
    const rows = await admin.query(
      "SELECT kind::text AS kind, stage::text AS stage FROM claim_acknowledgment WHERE claim_id = $1 ORDER BY kind::text",
      [claimId],
    );
    expect(rows.rows).toEqual([
      { kind: "ack_277ca", stage: "payer" },
      { kind: "ack_999", stage: "clearinghouse" },
    ]);
  });

  it("S01 (#708): submit -> clearinghouse ack -> payer ack -> 835 matched by CLP01 -> posted exactly once; claim state and ledger agree", async () => {
    const clearinghouse = new InMemoryClearinghouse();
    const deps = depsFor(clearinghouse);
    const { claimId, submissionId, ccn } = await assembleReadyClaim();
    await runInOrg((tx) =>
      runClaimSubmit(tx, deps, {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      }),
    );
    await clearinghouse.control.clearinghouseAccepts(ccn, SCOPE);
    await runAckPull999(deps);
    await clearinghouse.control.payerAccepts(ccn, "ICN-CYCLE-1", SCOPE);
    await runAckPull277ca(deps);
    expect(await claimState(claimId)).toBe("ACK_ACCEPTED");

    // The payer pays: the clearinghouse delivers an 835 whose CLP01 is our claim control number.
    const raw = buildFullEdi("000000811", "0811", "1000.00", {
      clp01: ccn,
      icn: "ICN-CYCLE-1",
      charge: "1000.50",
      paid: "1000.00",
      patientResponsibility: "0.50",
    });
    await clearinghouse.control.deliverRemittance("rem-cycle-1", raw, SCOPE);
    const delivered = await clearinghouse.fetchRemittances(CTX, null);
    if (!delivered.ok) throw new Error("the in-memory clearinghouse must deliver the 835");
    const file = delivered.data.items.find((r) => r.remittanceId === "rem-cycle-1");
    expect(file?.rawX12).toBe(raw);

    const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS, M25_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const staged = new Map<string, string>();
    const m25 = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: createX12835Client(),
      rawStore: {
        put: async (_org, id, text) => void staged.set(id, text),
        get: async (_org, id) => staged.get(id) ?? null,
        delete: async (_org, id) => void staged.delete(id),
      },
      // CARC 1 (deductible, PR) is informational: it seeds the patient-responsibility ledger, not a denial.
      terminology: {
        lookup: async () => ({
          category: "informational",
          plainLanguage: "patient responsibility",
        }),
      },
      claims: { medicare: buildM23BackedClaimMatchCandidateProvider() },
      outbox: {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m25" } as never),
      },
    });
    const ingest = {
      providerEntityId: PE,
      payerId: PE,
      payerKind: "medicare" as const,
      minioObjectKey: "minio/cycle.835",
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    };
    const received = await m25.receiveAdvice({ organizationId: ORG }, ingest);
    expect(received).toEqual({ outcome: "queued", adviceId: expect.any(String) });
    if (received.outcome !== "queued") throw new Error("unreachable");
    expect(await m25.postAdvice({ organizationId: ORG }, received.adviceId)).toMatchObject({
      outcome: "posted",
      postedLineCount: 1,
      unmatchedLineCount: 0,
    });

    const dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      eventCatalog: catalog,
      consumers: [
        buildM23RemittanceConsumer({
          db: handle.db,
          outbox: {
            publish: (tx, input) =>
              publisher.publish(tx as never, { ...input, callerModule: "m23" } as never),
          },
        }),
      ],
    });
    await dispatcher.tick();
    expect(await claimState(claimId)).toBe("PAID");

    // Redelivery of the file, a second post and a second drain change nothing.
    expect(await m25.receiveAdvice({ organizationId: ORG }, ingest)).toMatchObject({
      outcome: "duplicate",
    });
    expect(await m25.postAdvice({ organizationId: ORG }, received.adviceId)).toMatchObject({
      outcome: "already_posted",
    });
    await dispatcher.tick();

    const lines = await admin.query(
      `SELECT match_state, claim_id, clp04_total_payment_amount::text AS paid
         FROM remittance_line WHERE remittance_advice_id = $1`,
      [received.adviceId],
    );
    expect(lines.rows).toEqual([{ match_state: "posted", claim_id: claimId, paid: "1000.00" }]);
    const ledger = await admin.query(
      `SELECT count(*)::int AS n FROM patient_responsibility_ledger pl
         JOIN remittance_line rl ON pl.remittance_line_id = rl.id WHERE rl.remittance_advice_id = $1`,
      [received.adviceId],
    );
    expect(ledger.rows[0].n).toBe(1);
    // The claim moved to PAID once, from ACK_ACCEPTED, on this very advice (the state service's history row).
    const paidHistory = await admin.query(
      `SELECT from_state::text AS from_state, remittance_advice_id
         FROM claim_state_history WHERE claim_id = $1 AND to_state = 'PAID'`,
      [claimId],
    );
    expect(paidHistory.rows).toEqual([
      { from_state: "ACK_ACCEPTED", remittance_advice_id: received.adviceId },
    ]);
    const paidEvents = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'm25.remittance.claim_paid' AND organization_id = $1 AND payload->>'claimId' = $2",
      [ORG, claimId],
    );
    expect(paidEvents.rows[0].n).toBe(1);
  });

  describe("S05 (#709): a killed worker never causes a blind resend", () => {
    const X12_CLAIM = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "x12-837-client",
        "src",
        "clearinghouse",
        "__fixtures__",
        "stedi-claim.x12",
      ),
      "utf8",
    );
    const KILLED = "worker killed";

    function rig(opts?: { dropAfterLanding?: boolean }) {
      const uploads: string[] = [];
      const anomalies: unknown[] = [];
      const acks: AckEvent[] = [];
      const gateway: DirectMacGateway = {
        generate: async () => ({ x12: X12_CLAIM }),
        upload: async ({ controlNumber }) => {
          uploads.push(controlNumber);
          // The file is at the MAC portal, but the answer never reaches the worker.
          if (opts?.dropAfterLanding) throw new Error("connection reset after the upload landed");
          return { accepted: true, fileId: `file-${uploads.length}` };
        },
        pullAcknowledgments: async () => [...acks],
      };
      const store = createDrizzleAttemptStore(handle.db);
      return {
        uploads,
        anomalies,
        acks,
        store,
        deps: (attempts: SubmissionAttemptStore = store) =>
          depsFor(
            new DirectMacTransport({ attempts, gateway, onAnomaly: (a) => anomalies.push(a) }),
            "direct_mac",
            X12_CLAIM,
            store,
          ),
      };
    }

    async function seed(patient: string) {
      const seeded = await seedReadyClaim({ patient, attemptIndex: 0, withBlockingFailure: false });
      const job: ClaimSubmitJob = {
        organizationId: ORG,
        claimId: seeded.claimId,
        submissionId: seeded.submissionId,
        claimControlNumber: seeded.ccn,
        attemptIndex: 0,
      };
      const retry: ClaimSubmitRetryJob = {
        organizationId: ORG,
        claimId: seeded.claimId,
        submissionId: seeded.submissionId,
        attemptIndex: 0,
      };
      return { ...seeded, job, retry };
    }

    /** Run the worker and then "kill" it: its database transaction never commits. */
    const runThenKill = (deps: M23WorkerDeps, job: ClaimSubmitJob) =>
      runInOrg(async (tx) => {
        await runClaimSubmit(tx, deps, job);
        throw new Error(KILLED);
      });

    const attemptStatus = async (ccn: string) =>
      (
        await admin.query(
          "SELECT status::text AS status FROM clearinghouse_submission_attempt WHERE idempotency_key = $1",
          [`m23.claim.${ccn}`],
        )
      ).rows.map((r) => r.status);

    const operator = (store: SubmissionAttemptStore) =>
      buildClearinghouseAttemptResolutionService(
        store,
        () => new Date(Date.now() + 48 * 60 * 60_000),
      );

    const resolveInput = (ccn: string) =>
      ({ providerEntityId: PE, usage: "test", idempotencyKey: `m23.claim.${ccn}` }) as const;

    /** After the kill, the redelivered job surfaces the in-doubt attempt and sends nothing. */
    async function expectSurfacedNotResent(
      r: ReturnType<typeof rig>,
      c: Awaited<ReturnType<typeof seed>>,
      sentBefore: number,
    ) {
      expect(await attemptStatus(c.ccn)).toEqual(["reserved"]);
      expect(await claimState(c.claimId)).toBe("READY");
      expect((await submissionRow(c.submissionId)).outcome).toBe("queued");

      await runInOrg((tx) => runClaimSubmit(tx, r.deps(), c.job));
      const sub = await submissionRow(c.submissionId);
      expect(sub.outcome).toBe("failed_portal");
      expect(sub.outcome_reason).toMatch(/CH_IN_DOUBT/);
      expect(await claimState(c.claimId)).toBe("READY");
      await expect(runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry))).rejects.toThrow(
        /in doubt/,
      );
      expect(r.uploads).toHaveLength(sentBefore);
      expect(await attemptStatus(c.ccn)).toEqual(["reserved"]);
    }

    it("killed after the reservation, before the send: surfaced, not resent; 'not filed' lets the retry send once under a new number", async () => {
      const r = rig();
      const c = await seed("f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1");
      // The worker dies right after the reservation commits: the store write is the last thing that happened.
      const dyingStore: SubmissionAttemptStore = {
        ...r.store,
        reserve: async (a) => {
          const held = await r.store.reserve(a);
          throw new Error(`${KILLED} after ${held.attempt.status}`);
        },
      };
      await expect(runThenKill(r.deps(dyingStore), c.job)).rejects.toThrow(KILLED);
      expect(r.uploads).toHaveLength(0);
      await expectSurfacedNotResent(r, c, 0);

      const settled = await operator(r.store).resolveStale(
        { organizationId: ORG, userId: CONTRACT_OPERATOR_ID },
        { ...resolveInput(c.ccn), outcome: "not_filed" },
      );
      expect(settled.status).toBe("voided");
      const audit = await admin.query(
        "SELECT actor_user_id FROM audit_event WHERE resource_kind='clearinghouse_submission_attempt' AND event_type='clearinghouse_submission_attempt.update' ORDER BY created_at DESC LIMIT 1",
      );
      expect(audit.rows[0]?.actor_user_id).toBe(CONTRACT_OPERATOR_ID);

      await runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry));
      expect(await claimState(c.claimId)).toBe("SUBMITTED");
      expect(r.uploads).toHaveLength(1);
      expect(r.uploads[0]).not.toBe(c.ccn);
    });

    it("killed after the send, before the response: surfaced, not resent; 'filed' completes the claim without a second upload", async () => {
      const r = rig({ dropAfterLanding: true });
      const c = await seed("f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2");
      await expect(runThenKill(r.deps(), c.job)).rejects.toThrow(KILLED);
      expect(r.uploads).toEqual([c.ccn]);
      expect(r.anomalies).toHaveLength(1);
      await expectSurfacedNotResent(r, c, 1);

      const settled = await operator(r.store).resolveStale(
        { organizationId: ORG, userId: CONTRACT_OPERATOR_ID },
        { ...resolveInput(c.ccn), outcome: "sent", clearinghouseSubmissionId: "portal-file-77" },
      );
      expect(settled).toMatchObject({
        status: "sent",
        clearinghouseSubmissionId: "portal-file-77",
      });

      await runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry));
      expect(await claimState(c.claimId)).toBe("SUBMITTED");
      expect(r.uploads).toEqual([c.ccn]);
      const rows = await admin.query(
        "SELECT outcome::text AS outcome, generated_file_uri FROM claim_submission WHERE claim_id = $1 AND outcome = 'submitted'",
        [c.claimId],
      );
      expect(rows.rows).toEqual([
        { outcome: "submitted", generated_file_uri: "clearinghouse:direct_mac:portal-file-77" },
      ]);
    });

    const submissionRows = async (claimId: string) =>
      (
        await admin.query(
          `SELECT id, attempt_index, claim_control_number, outcome::text AS outcome
             FROM claim_submission WHERE claim_id = $1 ORDER BY attempt_index`,
          [claimId],
        )
      ).rows;

    const failedEventCount = async (claimId: string): Promise<number> =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type = 'm23.claim.submission_failed' AND payload->>'claimId' = $1",
          [claimId],
        )
      ).rows[0].n;

    it("filed retry keeps the control number: 999/277CA bind to the NEW submitted row, and a redelivered retry appends nothing (#754)", async () => {
      const r = rig({ dropAfterLanding: true });
      const c = await seed("f4f4f4f4-f4f4-f4f4-f4f4-f4f4f4f4f4f4");
      await expect(runThenKill(r.deps(), c.job)).rejects.toThrow(KILLED);
      // The redelivered job surfaces the in-doubt attempt on the submission row.
      await runInOrg((tx) => runClaimSubmit(tx, r.deps(), c.job));
      await operator(r.store).resolveStale(
        { organizationId: ORG, userId: CONTRACT_OPERATOR_ID },
        { ...resolveInput(c.ccn), outcome: "sent", clearinghouseSubmissionId: "portal-file-88" },
      );
      await runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry));
      expect(await claimState(c.claimId)).toBe("SUBMITTED");
      const afterRetry = await submissionRows(c.claimId);
      expect(afterRetry).toMatchObject([
        { attempt_index: 0, claim_control_number: c.ccn, outcome: "failed_portal" },
        { attempt_index: 1, claim_control_number: c.ccn, outcome: "submitted" },
      ]);
      const newRowId = afterRetry[1].id as string;

      // A redelivery of the retry job before any ack arrives is a no-op: no duplicate row, no second upload.
      await runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry));
      expect(await submissionRows(c.claimId)).toEqual(afterRetry);

      // The MAC answers under the ORIGINAL control number: both stages bind to the new submitted row.
      const at = "2026-02-02T10:00:00Z";
      r.acks.push(
        {
          eventId: "ev-ch-754",
          stage: "clearinghouse",
          disposition: "accepted",
          controlNumber: c.ccn,
          reasonCodes: [],
          occurredAt: at,
        },
        {
          eventId: "ev-pay-754",
          stage: "payer",
          disposition: "accepted",
          controlNumber: c.ccn,
          reasonCodes: [],
          occurredAt: at,
          payerClaimNumber: "ICN-754",
        },
      );
      const deps = r.deps();
      await runAckPull999(deps);
      await runAckPull277ca(deps);
      expect(await claimState(c.claimId)).toBe("ACK_ACCEPTED");
      const acked = await admin.query(
        "SELECT submission_id, kind::text AS kind FROM claim_acknowledgment WHERE claim_id = $1",
        [c.claimId],
      );
      expect(acked.rows).toHaveLength(2);
      for (const row of acked.rows) expect(row.submission_id).toBe(newRowId);

      const failedBefore = await failedEventCount(c.claimId);
      // A late redelivery of the retry (the claim has moved on) still appends nothing, never re-uploads, and does
      // not announce a failure for a claim that was filed.
      await runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry));
      expect(await failedEventCount(c.claimId)).toBe(failedBefore);
      expect(await submissionRows(c.claimId)).toEqual(afterRetry);
      expect(await claimState(c.claimId)).toBe("ACK_ACCEPTED");
      expect(r.uploads).toEqual([c.ccn]);
    });

    it("retry without the attempt store stays blocked even after the operator settled the attempt (fail closed, #754)", async () => {
      const r = rig({ dropAfterLanding: true });
      const c = await seed("f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5");
      await expect(runThenKill(r.deps(), c.job)).rejects.toThrow(KILLED);
      await runInOrg((tx) => runClaimSubmit(tx, r.deps(), c.job));
      await operator(r.store).resolveStale(
        { organizationId: ORG, userId: CONTRACT_OPERATOR_ID },
        { ...resolveInput(c.ccn), outcome: "sent", clearinghouseSubmissionId: "portal-file-99" },
      );
      const base = r.deps();
      const blind: M23WorkerDeps = {
        ...base,
        transport: {
          ...(base.transport as NonNullable<M23WorkerDeps["transport"]>),
          attempts: undefined,
        },
      };
      await expect(runInOrg((tx) => runClaimSubmitRetry(tx, blind, c.retry))).rejects.toThrow(
        /in doubt/,
      );
      expect(await claimState(c.claimId)).toBe("READY");
      expect(r.uploads).toEqual([c.ccn]);
      // With the store bound the same settlement lets the retry through (the block was the missing store, not the data).
      await runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry));
      expect(await claimState(c.claimId)).toBe("SUBMITTED");
    });

    it("a released attempt under an in-doubt submission is a deliberate dead end: retry refuses, sends nothing (#754)", async () => {
      const r = rig({ dropAfterLanding: true });
      const c = await seed("f6f6f6f6-f6f6-f6f6-f6f6-f6f6f6f6f6f6");
      await expect(runThenKill(r.deps(), c.job)).rejects.toThrow(KILLED);
      await runInOrg((tx) => runClaimSubmit(tx, r.deps(), c.job));
      expect((await submissionRow(c.submissionId)).outcome_reason).toMatch(/CH_IN_DOUBT/);
      // Force the contradictory state: the vendor "definitively did not take it" yet the submission still says in doubt.
      const released = await admin.query(
        "UPDATE clearinghouse_submission_attempt SET status = 'released' WHERE idempotency_key = $1",
        [`m23.claim.${c.ccn}`],
      );
      expect(released.rowCount).toBe(1);
      await expect(runInOrg((tx) => runClaimSubmitRetry(tx, r.deps(), c.retry))).rejects.toThrow(
        /in doubt/,
      );
      expect(await claimState(c.claimId)).toBe("READY");
      expect(r.uploads).toEqual([c.ccn]);
      expect(await submissionRows(c.claimId)).toHaveLength(1);
    });

    it("killed after the response, before the commit: the redelivered job replays the recorded send and files nothing twice", async () => {
      const r = rig();
      const c = await seed("f3f3f3f3-f3f3-f3f3-f3f3-f3f3f3f3f3f3");
      await expect(runThenKill(r.deps(), c.job)).rejects.toThrow(KILLED);
      expect(r.uploads).toEqual([c.ccn]);
      expect(await attemptStatus(c.ccn)).toEqual(["sent"]);
      expect(await claimState(c.claimId)).toBe("READY");
      expect((await submissionRow(c.submissionId)).outcome).toBe("queued");

      await runInOrg((tx) => runClaimSubmit(tx, r.deps(), c.job));
      expect(await claimState(c.claimId)).toBe("SUBMITTED");
      expect((await submissionRow(c.submissionId)).outcome).toBe("submitted");
      expect(r.uploads).toEqual([c.ccn]);
    });
  });
});
