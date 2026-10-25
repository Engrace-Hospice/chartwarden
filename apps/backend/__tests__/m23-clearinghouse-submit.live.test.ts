/**
 * M23 workers over the bound clearinghouse transport (#707) - LIVE Postgres.
 *
 * With `CLEARINGHOUSE_VENDOR` configured the claim submit/retry workers and the 999/277CA ack crons must use the
 * transport and never the legacy MAC portal. This suite drives the real worker functions against the in-memory
 * clearinghouse (the executable specification of the port), with a legacy portal that fails the test if touched, and the
 * real catalog-validating outbox publisher (a payload that drifts from the `m23.*` catalog rolls the worker back).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:clearinghouse-submit:live
 * Local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveControlNumber, type repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import {
  type ClaimSubmitJob,
  type ClaimSubmitRetryJob,
  type M23WorkerDeps,
  runAckPull277ca,
  runAckPull999,
  runClaimSubmit,
  runClaimSubmitRetry,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
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

  function depsFor(clearinghouse: InMemoryClearinghouse): M23WorkerDeps {
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
        generate837i: async () => ({ x12: "ISA*00*...~", correlationId: "corr-1" }),
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
      transport: {
        binding: { vendor: "in_memory", transport: clearinghouse },
        contexts: { contextFor: async () => CTX, providerEntitiesFor: async () => [PE] },
      },
    };
  }

  async function claimState(claimId: string): Promise<string> {
    return (await admin.query("SELECT state FROM claim WHERE id = $1", [claimId])).rows[0].state;
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
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
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
});
