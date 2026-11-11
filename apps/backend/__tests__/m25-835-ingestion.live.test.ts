/**
 * WX-PR-012 — M25 X12-835 receive → parse → post pipeline, LIVE Postgres proof.
 *
 * Proves the real `receiveAdvice`/`postAdvice` pair (apps/backend/src/modules/25-remittance/ingest/
 * service-drizzle.ts) over real Postgres + RLS: dedup-at-insert, a genuinely transactional multi-claim
 * post (all-or-nothing), denial/PR-ledger seeding, posting-outcome classification, and cross-tenant
 * isolation. The X12835WorkerClient is a controllable FAKE in most cases (one case uses the real in-process
 * TypeScript parser, ADR-0037 — there is no sidecar) — the local ISA/ST envelope-header extraction (@chartwarden/x12-835-client
 * `parseX12EnvelopeHeader`) is real and exercised directly by the "malformed" case.
 *
 * F-128 (#251) — the whole file used to drive `receiveAdvice`/`postAdvice` over the bare superuser
 * `DB_URL` (GAP-086: a superuser BYPASSES RLS unconditionally), so nothing here had ever proven the write
 * path itself is RLS-clean; only one dedicated test at the bottom role-switched, and only for a bare
 * SELECT. Now connects as the real NOBYPASSRLS `chartwarden_app` role throughout (`_live-app-role.ts`) — every
 * assertion in this file is now a genuine RLS proof, not merely a superuser-connection convenience. It
 * also adds real coverage for the M23→M25 auto-match bridge (`buildM23BackedClaimMatchCandidateProvider`
 * over M23's registered `ClaimSubmissionReader` seam, WX-PR-012): every existing test here fed the
 * auto-matcher a hand-rolled `fakeClaims()` double, which proves the M25-side matching ALGORITHM but never
 * that the bridge actually reaches a real M23 `claim` row — the M25 module spec's own 2026-08-05
 * correction note still says this bridge "remains unbound", which is stale (checked against
 * `cost-report-seams.ts` rather than assumed): `registerM23PublishedSeams` has registered
 * `ClaimSubmissionReader` at every boot with a db since WX-PR-012 landed.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m25-835-ingestion.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set CHARTWARDEN_TEST_NO_PGVECTOR=1.)
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAuthorizationContract,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import { repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  ParsedRemittanceAdvice,
  X12WorkerResult,
  X12835WorkerClient,
} from "@chartwarden/x12-835-client";
import { createX12835Client, degraded835 } from "@chartwarden/x12-835-client";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import Fastify from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaimMdProtectedPayloadCipher } from "../src/bootstrap/claimmd-payload-cipher";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { registerSeam } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createTaxIdCipher } from "../src/modules/02-identity/tax-id-cipher";
import { createClaimMdEvidenceCipher } from "../src/modules/23-billing-medicare/claimmd-evidence/cipher";
import { createClaimMdSubmissionEvidenceStore } from "../src/modules/23-billing-medicare/claimmd-evidence/store";
import {
  readClaimMdEraCandidateEvidence,
  readM23HistoricalEraCandidates,
} from "../src/modules/23-billing-medicare/claimmd-identity/historical-era-candidates";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import type { MatchCandidate } from "../src/modules/25-remittance/domain/match";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/events-by-m25";
import {
  buildDrizzleM25ReadService,
  buildM23BackedClaimMatchCandidateProvider,
} from "../src/modules/25-remittance/index";
import { buildDrizzleClaimMdEraReviewService } from "../src/modules/25-remittance/ingest/claimmd-era-review";
import {
  MAX_REFUSALS_PER_REMITTANCE,
  pullRemittances,
} from "../src/modules/25-remittance/ingest/clearinghouse-pull";
import { parsePayeeTinPolicy } from "../src/modules/25-remittance/ingest/payee-tin-policy";
import { buildDrizzleRemittanceCursorStore } from "../src/modules/25-remittance/ingest/pull-cursor-store";
import type {
  ClaimMatchCandidateProvider,
  M25IngestActor,
  ReceiveAdviceInput,
  ReceiveAdviceResult,
  TerminologyLookupPort,
} from "../src/modules/25-remittance/ingest/service";
import {
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
  getM25TransactionPostingPort,
  m25ContentDigestOf,
} from "../src/modules/25-remittance/ingest/service-drizzle";
import { registerClaimMdEraReviewRoutes } from "../src/modules/25-remittance/routes/claimmd-era-review.routes";
import { registerRemittanceRoutes } from "../src/modules/25-remittance/routes/remittance.routes";
import type { WriteOutboxPort } from "../src/modules/25-remittance/routes/write-service";
import { M41_OUTBOX_EVENTS } from "../src/modules/41-billing-commercial/events-by-m41";
import { buildM41RemittanceConsumer } from "../src/modules/41-billing-commercial/outbox-consumers/m25-remittance";
import { readM41HistoricalEraCandidates } from "../src/modules/41-billing-commercial/services/historical-era-candidates";
import { buildFullEdi, buildRawEdi, sha256Hex } from "./_edi835-fixture";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PE_A = "00000000-0000-0000-0000-0000000000a1";
const PE_B = "00000000-0000-0000-0000-0000000000b1";
const PAYER = "00000000-0000-0000-0000-00000000fee1";
const CLAIM_PAID = "00000000-0000-0000-0000-00000000ca01";
const CLAIM_DENIED = "00000000-0000-0000-0000-00000000ca02";
const CLAIM_PR_OK = "00000000-0000-0000-0000-00000000ca03";
const CLAIM_PR_NOPATIENT = "00000000-0000-0000-0000-00000000ca04";
const CLAIM_UNMAPPED = "00000000-0000-0000-0000-00000000ca05";
const CLAIM_RECOUP = "00000000-0000-0000-0000-00000000ca06";
const PATIENT_1 = "00000000-0000-0000-0000-0000000e0001";

// ── controllable fakes ────────────────────────────────────────────────────────────────────────────────
function fakeClient(byKey: Map<string, ParsedRemittanceAdvice | "degraded">): X12835WorkerClient {
  return {
    async parse835({ minioObjectKey }): Promise<X12WorkerResult<ParsedRemittanceAdvice>> {
      const v = byKey.get(minioObjectKey);
      if (!v || v === "degraded") {
        return degraded835("X12_835_TEST_DEGRADED", "test-forced degraded", "parse835", false);
      }
      return { ok: true, value: v };
    },
    async parse277ca() {
      throw new Error("not used in this test");
    },
  };
}

function fakeTerminology(
  byCarc: Record<string, { category: string; plainLanguage: string }>,
): TerminologyLookupPort {
  return {
    async lookup(carcCode) {
      return byCarc[carcCode] ?? null;
    },
  };
}

function fakeClaims(
  candidatesByIcn: Record<string, MatchCandidate[]>,
  patientByClaim: Record<string, string>,
): ClaimMatchCandidateProvider {
  return {
    async candidatesForLine({ payerIcn }) {
      return (payerIcn && candidatesByIcn[payerIcn]) || [];
    },
    async patientIdForClaim(_org, claimId) {
      return patientByClaim[claimId] ?? null;
    },
  };
}

/** A claims provider whose candidate lookup throws on the Nth call — forces a mid-batch tx failure. */
function throwingOnNthClaims(n: number): ClaimMatchCandidateProvider {
  let calls = 0;
  return {
    async candidatesForLine() {
      calls += 1;
      if (calls === n) throw new Error("forced mid-batch failure (rollback proof)");
      return [];
    },
    async patientIdForClaim() {
      return null;
    },
  };
}

describe.skipIf(!DB_URL)("WX-PR-012 M25 835 receive/post pipeline — LIVE Postgres", () => {
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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    // `_live-app-role.ts` (GAP-086): every test in this file used to drive `receiveAdvice`/`postAdvice`
    // over the bare superuser `DB_URL` connection — a superuser BYPASSES RLS unconditionally, so nothing
    // here had ever proven the write path (envelope/line/service-line/adjustment/remark/denial_case/
    // patient_responsibility_ledger inserts) works under the RLS this module's migrations actually ship.
    // Only the one dedicated cross-tenant test at the bottom role-switched, and only for a bare SELECT.
    const appConnectionString = await appRoleConnectionString(admin, DB_URL!);
    handle = createDbClient({ connectionString: appConnectionString });
    // F-128 (#251) — M23's real, registered `ClaimSubmissionReader` seam (the exact
    // `registerM23PublishedSeams(db)` call production boot makes), so
    // `buildM23BackedClaimMatchCandidateProvider()` resolves against it for real rather than degrading
    // to "no candidates".
    registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(handle.db));
  }, 120_000);

  /** Seed a real, minimal M23 `claim` row (every non-`claim_control_number` cross-module id is a logical
   *  FK — no real constraint — so an arbitrary uuid is honest test data, not a shortcut). */
  async function seedClaim(input: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly patientId: string;
    readonly claimControlNumber: string;
    readonly payerClaimControlNumber?: string;
    readonly serviceFrom?: string;
    readonly serviceTo?: string;
  }): Promise<string> {
    const claim = await withOrgContext(
      handle.db,
      { organizationId: input.organizationId, userId: "" },
      (tx) =>
        new repositories.ClaimRepository(tx).create({
          organizationId: input.organizationId,
          providerEntityId: input.providerEntityId,
          patientId: input.patientId,
          admissionId: crypto.randomUUID(),
          electionPeriodIdFrom: crypto.randomUUID(),
          electionPeriodIdTo: crypto.randomUUID(),
          patientPayerId: crypto.randomUUID(),
          tob: "812",
          serviceFrom: input.serviceFrom ?? "2026-03-01",
          serviceTo: input.serviceTo ?? "2026-03-31",
          claimControlNumber: input.claimControlNumber,
          payerClaimControlNumber: input.payerClaimControlNumber ?? null,
          macJurisdiction: "ngs_j6",
          sequestrationAppliedPct: "2.00",
          sequestrationPolicyId: crypto.randomUUID(),
          createdByMembershipId: crypto.randomUUID(),
        }),
    );
    return claim.id;
  }

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  async function lineCount(adviceId: string): Promise<number> {
    const res = await admin.query(
      "SELECT count(*)::int AS n FROM remittance_line WHERE remittance_advice_id = $1",
      [adviceId],
    );
    return res.rows[0].n as number;
  }

  it("serializes concurrent posting retries and commits one financial line", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const key = "minio/concurrent-posting.835";
    const raw = buildRawEdi("000000991", "0991");
    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: "000000991",
      transactionSetControlNumber: "0991",
      checkOrEftTraceNumber: "SYNTHETIC-TRACE-991",
      paymentMethod: "eft",
      totalPaymentAmount: 12,
      productionDate: "2026-03-01",
      claims: [
        {
          patientControlNumber: "SYNTHETIC-PCN-991",
          payerIcn: "SYNTHETIC-ICN-991",
          statusCode: 1,
          totalCharge: 12,
          totalPayment: 12,
          patientResponsibility: 0,
          adjustments: [],
          remarks: [],
          serviceLines: [],
        },
      ],
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      client: fakeClient(new Map([[key, parsed]])),
      payeeNpi: PAYEE_UNCHECKED,
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: key,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });
    if (received.outcome !== "queued") throw new Error("unreachable");
    const results = await Promise.all([
      service.postAdvice(actor, received.adviceId),
      service.postAdvice(actor, received.adviceId),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "already_posted",
      "partial_posted",
    ]);
    expect(await lineCount(received.adviceId)).toBe(1);
    const status = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
      received.adviceId,
    ]);
    expect(status.rows[0].parse_status).toBe("partial_posted");
  });

  describe("transaction-scoped explicit-association posting core", () => {
    const injectedApps: Array<ReturnType<typeof Fastify>> = [];
    const outboxPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
    const outbox: WriteOutboxPort = {
      publish: (tx, emission) =>
        outboxPublisher.publish(tx as never, {
          ...emission,
          callerModule: "m25",
        }),
    };

    afterAll(async () => {
      await Promise.all(injectedApps.map((app) => app.close()));
      resetAuthorizationContract();
    });

    async function queuedSupportedAdvice(
      suffix: string,
      claimCount = 1,
      unsupportedClaimIndex = -1,
      trace = `SYNTHETIC-CORE-TRACE-${suffix}`,
    ) {
      const actor = { organizationId: ORG_A };
      const key = `minio/explicit-core-${suffix}.835`;
      const raw = buildRawEdi(`000001${suffix.padStart(3, "0")}`, suffix.padStart(4, "0"));
      const claims: ParsedRemittanceAdvice["claims"] = Array.from(
        { length: claimCount },
        (_, index) => ({
          patientControlNumber: `SYNTHETIC-PCN-${suffix}-${index + 1}`,
          payerIcn: `SYNTHETIC-ICN-${suffix}-${index + 1}`,
          statusCode: 1,
          totalCharge: 42,
          totalPayment: 42,
          patientResponsibility: 0,
          adjustments:
            index === unsupportedClaimIndex
              ? [{ groupCode: "CO", reasonCode: "45", amount: 1 }]
              : [],
          remarks: [],
          serviceLines: [],
        }),
      );
      const parsed: ParsedRemittanceAdvice = {
        payerProgram: "medicare",
        interchangeControlNumber: `000001${suffix.padStart(3, "0")}`,
        transactionSetControlNumber: suffix.padStart(4, "0"),
        checkOrEftTraceNumber: trace,
        paymentMethod: "eft",
        totalPaymentAmount: 42 * claimCount,
        productionDate: "2026-03-01",
        claims,
      };
      const claimIds = await Promise.all(
        claims.map((claim, index) =>
          seedClaim({
            organizationId: ORG_A,
            providerEntityId: PE_A,
            // A different patient avoids the module's active-claim-range uniqueness rule across
            // independent synthetic remittance fixtures.
            patientId: crypto.randomUUID(),
            claimControlNumber: claim.patientControlNumber!,
            payerClaimControlNumber: claim.payerIcn,
            serviceFrom: `2026-03-${String(((Number(suffix) + index) % 28) + 1).padStart(2, "0")}`,
            serviceTo: `2026-03-${String(((Number(suffix) + index) % 28) + 1).padStart(2, "0")}`,
          }),
        ),
      );
      const associations = claimIds.map((claimId, index) => ({
        organizationId: ORG_A,
        providerEntityId: PE_A,
        claimId,
        evidenceId: `synthetic-review-${suffix}-${index + 1}`,
        evidenceVersion: 1,
      }));
      const service = buildDrizzleM25IngestService(handle.db, {
        client: fakeClient(new Map([[key, parsed]])),
        payeeNpi: PAYEE_UNCHECKED,
        // The candidate set is read through the actual M23 source-owned seam and restricted app role;
        // the explicit path must accept this exact selected claim without invoking autoMatch.
        claims: { medicare: buildM23BackedClaimMatchCandidateProvider() },
        outbox,
      });
      const received = await service.receiveAdvice(actor, {
        providerEntityId: PE_A,
        payerId: PAYER,
        payerKind: "medicare",
        minioObjectKey: key,
        fileSha256: sha256Hex(raw),
        rawEdi: raw,
      });
      if (received.outcome !== "queued") throw new Error("expected queued synthetic advice");
      return {
        actor,
        parsed,
        claimId: claimIds[0]!,
        claimIds,
        adviceId: received.adviceId,
        sourceFileSha256: sha256Hex(raw),
        service,
        postingPort: getM25TransactionPostingPort(service),
        association: associations[0]!,
        associations,
      };
    }

    async function postExplicit(fx: Awaited<ReturnType<typeof queuedSupportedAdvice>>) {
      return withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        fx.postingPort.postValidatedClaimInTransaction(tx, fx.actor, {
          adviceId: fx.adviceId,
          sourceFileSha256: fx.sourceFileSha256,
          parsed: fx.parsed,
          association: fx.association,
        }),
      );
    }

    async function postExplicitBatch(fx: Awaited<ReturnType<typeof queuedSupportedAdvice>>) {
      return withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        fx.postingPort.postValidatedClaimsInTransaction(tx, fx.actor, {
          adviceId: fx.adviceId,
          sourceFileSha256: fx.sourceFileSha256,
          parsed: fx.parsed,
          associations: fx.associations,
        }),
      );
    }

    it("persists the explicit claim association and transactional posting events without running legacy auto-match", async () => {
      const fx = await queuedSupportedAdvice("941");
      const posted = await postExplicit(fx);
      expect(posted).toMatchObject({ outcome: "posted" });
      const lines = await admin.query(
        "SELECT organization_id, claim_id, clp04_total_payment_amount, match_strategy, match_state FROM remittance_line WHERE remittance_advice_id=$1",
        [fx.adviceId],
      );
      expect(lines.rows).toEqual([
        expect.objectContaining({
          organization_id: ORG_A,
          claim_id: fx.claimId,
          clp04_total_payment_amount: "42.00",
          match_strategy: "manual",
          match_state: "posted",
        }),
      ]);
      const adviceRow = await admin.query(
        "SELECT parse_status, parse_summary FROM remittance_advice WHERE id=$1",
        [fx.adviceId],
      );
      expect(adviceRow.rows[0]).toMatchObject({
        parse_status: "posted",
        parse_summary: {
          associationEvidence: [
            {
              claimId: fx.claimId,
              evidenceId: fx.association.evidenceId,
              evidenceVersion: 1,
            },
          ],
        },
      });
      const events = await admin.query(
        "SELECT event_type FROM outbox_event WHERE organization_id=$1 AND event_type='m25.remittance.claim_paid' AND aggregate_kind='remittance_line' AND aggregate_id=$2",
        [ORG_A, posted.remittanceLineId],
      );
      expect(events.rowCount).toBe(1);
      const adviceEvents = await admin.query(
        "SELECT event_type FROM outbox_event WHERE organization_id=$1 AND event_type='m25.remittance.advice_posted' AND aggregate_id=$2",
        [ORG_A, fx.adviceId],
      );
      expect(adviceEvents.rowCount).toBe(1);
      expect(await fx.service.postAdvice(fx.actor, fx.adviceId)).toMatchObject({
        outcome: "already_posted",
      });
      expect(await lineCount(fx.adviceId)).toBe(1);
    });

    it("posts every explicitly associated claim in one transaction and emits one advice event", async () => {
      const fx = await queuedSupportedAdvice("945", 2);
      const posted = await postExplicitBatch(fx);
      expect(posted).toMatchObject({ outcome: "posted" });
      expect(posted.remittanceLineIds).toHaveLength(2);
      const lines = await admin.query(
        "SELECT organization_id, claim_id, clp03_total_charge_amount, clp04_total_payment_amount, match_state FROM remittance_line WHERE remittance_advice_id=$1 ORDER BY claim_id",
        [fx.adviceId],
      );
      expect(lines.rows).toHaveLength(2);
      expect(lines.rows.map((row) => row.claim_id).sort()).toEqual([...fx.claimIds].sort());
      expect(
        lines.rows.every((row) => row.organization_id === ORG_A && row.match_state === "posted"),
      ).toBe(true);
      expect(
        lines.rows.every(
          (row) =>
            row.clp03_total_charge_amount === "42.00" && row.clp04_total_payment_amount === "42.00",
        ),
      ).toBe(true);
      const claimPaid = await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1 AND event_type='m25.remittance.claim_paid' AND aggregate_id=ANY($2::uuid[])",
        [ORG_A, posted.remittanceLineIds],
      );
      const advicePosted = await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1 AND event_type='m25.remittance.advice_posted' AND aggregate_id=$2",
        [ORG_A, fx.adviceId],
      );
      expect(claimPaid.rows[0].n).toBe(2);
      expect(advicePosted.rows[0].n).toBe(1);
      const advice = await admin.query(
        "SELECT parse_status, parse_summary FROM remittance_advice WHERE id=$1",
        [fx.adviceId],
      );
      expect(advice.rows[0]).toMatchObject({
        parse_status: "posted",
        parse_summary: { lineCount: 2, postedLineCount: 2, unmatchedLineCount: 0 },
      });
      const repeated = await postExplicitBatch(fx);
      expect(repeated).toEqual({
        outcome: "already_posted",
        remittanceLineIds: posted.remittanceLineIds,
      });
      expect(await lineCount(fx.adviceId)).toBe(2);
    });

    it("rolls back all claims when a later claim fails after an earlier line insert", async () => {
      const fx = await queuedSupportedAdvice("946", 2);
      const failClaimId = fx.claimIds[1]!;
      await admin.query(`CREATE FUNCTION public.fail_second_m25_batch_line() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.claim_id = '${failClaimId}'::uuid THEN RAISE EXCEPTION 'forced second-claim failure'; END IF; RETURN NEW; END $$`);
      await admin.query(
        "CREATE TRIGGER fail_second_m25_batch_line BEFORE INSERT ON remittance_line FOR EACH ROW EXECUTE FUNCTION public.fail_second_m25_batch_line()",
      );
      try {
        await expect(postExplicitBatch(fx)).rejects.toBeDefined();
      } finally {
        await admin.query("DROP TRIGGER IF EXISTS fail_second_m25_batch_line ON remittance_line");
        await admin.query("DROP FUNCTION IF EXISTS public.fail_second_m25_batch_line()");
      }
      expect(await lineCount(fx.adviceId)).toBe(0);
      const advice = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
        fx.adviceId,
      ]);
      expect(advice.rows[0].parse_status).toBe("queued");
      const events = await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1 AND aggregate_id=$2 AND event_type IN ('m25.remittance.claim_paid','m25.remittance.advice_posted')",
        [ORG_A, fx.adviceId],
      );
      expect(events.rows[0].n).toBe(0);
    });

    it("blocks the whole batch when any claim contains unsupported financial facts", async () => {
      const fx = await queuedSupportedAdvice("948", 2, 1);
      await expect(postExplicitBatch(fx)).rejects.toThrow("M25_POSTING_FACTS_UNSUPPORTED");
      expect(await lineCount(fx.adviceId)).toBe(0);
      const advice = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
        fx.adviceId,
      ]);
      expect(advice.rows[0].parse_status).toBe("queued");
      const events = await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1 AND aggregate_id=$2 AND event_type IN ('m25.remittance.claim_paid','m25.remittance.advice_posted')",
        [ORG_A, fx.adviceId],
      );
      expect(events.rows[0].n).toBe(0);
    });

    it("rolls back remittance records and outbox rows when the caller aborts its transaction", async () => {
      const fx = await queuedSupportedAdvice("942");
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
          await fx.postingPort.postValidatedClaimInTransaction(tx, fx.actor, {
            adviceId: fx.adviceId,
            sourceFileSha256: fx.sourceFileSha256,
            parsed: fx.parsed,
            association: fx.association,
          });
          throw new Error("forced caller rollback");
        }),
      ).rejects.toThrow("forced caller rollback");
      expect(await lineCount(fx.adviceId)).toBe(0);
      const state = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
        fx.adviceId,
      ]);
      expect(state.rows[0].parse_status).toBe("queued");
      const postedEvents = await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1 AND aggregate_id=$2 AND event_type IN ('m25.remittance.claim_paid','m25.remittance.advice_posted')",
        [ORG_A, fx.adviceId],
      );
      expect(postedEvents.rows[0].n).toBe(0);
    });

    it("rejects source-scope conflicts and unsupported adjustment facts without writes", async () => {
      const fx = await queuedSupportedAdvice("943");
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          fx.postingPort.postValidatedClaimInTransaction(tx, fx.actor, {
            adviceId: fx.adviceId,
            sourceFileSha256: fx.sourceFileSha256,
            parsed: fx.parsed,
            association: { ...fx.association, providerEntityId: PE_B },
          }),
        ),
      ).rejects.toThrow("M25_EXPLICIT_ASSOCIATION_SCOPE_MISMATCH");
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          fx.postingPort.postValidatedClaimInTransaction(tx, fx.actor, {
            adviceId: fx.adviceId,
            sourceFileSha256: fx.sourceFileSha256,
            parsed: fx.parsed,
            association: { ...fx.association, claimId: CLAIM_DENIED },
          }),
        ),
      ).rejects.toThrow("M25_EXPLICIT_ASSOCIATION_NOT_AUTHORIZED_BY_SOURCE_OWNER");
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          fx.postingPort.postValidatedClaimInTransaction(tx, fx.actor, {
            adviceId: fx.adviceId,
            sourceFileSha256: "0".repeat(64),
            parsed: fx.parsed,
            association: fx.association,
          }),
        ),
      ).rejects.toThrow("M25_POSTING_SOURCE_STALE");
      const unsupported = {
        ...fx.parsed,
        claims: [
          {
            ...fx.parsed.claims[0]!,
            adjustments: [{ groupCode: "CO" as const, reasonCode: "45", amount: 1 }],
          },
        ],
      };
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          fx.postingPort.postValidatedClaimInTransaction(tx, fx.actor, {
            adviceId: fx.adviceId,
            sourceFileSha256: fx.sourceFileSha256,
            parsed: unsupported,
            association: fx.association,
          }),
        ),
      ).rejects.toThrow("M25_POSTING_FACTS_UNSUPPORTED");
      expect(await lineCount(fx.adviceId)).toBe(0);
    });

    it("serializes concurrent explicit execution and returns an idempotent result", async () => {
      const fx = await queuedSupportedAdvice("944");
      const results = await Promise.all([postExplicit(fx), postExplicit(fx)]);
      expect(results.map((result) => result.outcome).sort()).toEqual(["already_posted", "posted"]);
      expect(await lineCount(fx.adviceId)).toBe(1);
    });

    it("holds a possible duplicate payment identity even when the parsed ERA digest differs", async () => {
      const first = await queuedSupportedAdvice("965", 1, -1, "SYNTHETIC-SHARED-TRACE-965");
      const second = await queuedSupportedAdvice("966", 1, -1, "SYNTHETIC-SHARED-TRACE-965");
      expect(m25ContentDigestOf(first.parsed)).not.toBe(m25ContentDigestOf(second.parsed));

      await postExplicit(first);
      await expect(postExplicit(second)).rejects.toThrow("M25_CROSS_SOURCE_DUPLICATE_EFFECT");
      expect(await lineCount(first.adviceId)).toBe(1);
      expect(await lineCount(second.adviceId)).toBe(0);
      const secondAdvice = await admin.query(
        "SELECT parse_status FROM remittance_advice WHERE id=$1",
        [second.adviceId],
      );
      expect(secondAdvice.rows[0].parse_status).toBe("queued");
    });

    it.each([
      { claimCount: 1, partialClaimIndex: -1, adjustmentGroup: "OA" },
      { claimCount: 2, partialClaimIndex: -1, adjustmentGroup: "OA" },
      { claimCount: 1, partialClaimIndex: 0, adjustmentGroup: "OA" },
      { claimCount: 1, partialClaimIndex: 0, adjustmentGroup: "CO" },
      {
        claimCount: 1,
        partialClaimIndex: -1,
        adjustmentGroup: "OA",
        providerAdjustmentReason: "WO",
      },
    ])(
      "reviews a staged Claim.MD ERA with $claimCount claim(s), partial index $partialClaimIndex and $adjustmentGroup adjustment",
      async ({ claimCount, partialClaimIndex, adjustmentGroup, providerAdjustmentReason }) => {
        const stageId = crypto.randomUUID();
        const sourceInboxId = crypto.randomUUID();
        const resolutionId = crypto.randomUUID();
        const claimIds = Array.from({ length: claimCount }, () => crypto.randomUUID());
        const claimId = claimIds[0]!;
        const payerId = "f0000000-0000-4000-8000-00000000fee1";
        const pcns = claimIds.map(
          (_, index) => `SYNTHETIC-CLAIMMD-PCN-${stageId.slice(0, 8)}-${index + 1}`,
        );
        const trace = `SYNTHETIC-CLAIMMD-TRACE-${stageId.slice(0, 8)}`;
        const transactionSetControlNumber = String(Date.now() % 100_000_000).padStart(8, "0");
        const parsed: ParsedRemittanceAdvice = {
          payerProgram: "commercial",
          payer: { name: "Synthetic Payer", id: payerId },
          payee: {
            name: "Synthetic Hospice",
            idQualifier: "XX",
            id: "1999999999",
          },
          interchangeControlNumber: transactionSetControlNumber.padStart(9, "0"),
          transactionSetControlNumber,
          checkOrEftTraceNumber: trace,
          paymentMethod: "eft",
          totalPaymentAmount:
            claimIds.reduce((sum, _, index) => sum + (index === partialClaimIndex ? 70 : 42), 0) -
            (providerAdjustmentReason ? 5 : 0),
          ...(providerAdjustmentReason
            ? {
                providerAdjustmentTotal: 5,
                providerAdjustments: [
                  {
                    reason: providerAdjustmentReason,
                    reference: `SYNTHETIC-FCN-${stageId.slice(0, 8)}`,
                    amount: 5,
                    providerIdentifier: "1999999999",
                    fiscalPeriod: "2026-03-31",
                    segmentPosition: 9,
                    occurrence: 1,
                  },
                ],
              }
            : {}),
          productionDate: "2026-03-01",
          claims: claimIds.map((_, index) => ({
            patientControlNumber: pcns[index],
            payerIcn: `SYNTHETIC-CLAIMMD-ICN-${index + 1}`,
            statusCode: 1,
            totalCharge: index === partialClaimIndex ? 100 : 42,
            totalPayment: index === partialClaimIndex ? 70 : 42,
            patientResponsibility: 0,
            serviceFrom: "2026-03-01",
            serviceTo: "2026-03-31",
            adjustments:
              index === partialClaimIndex
                ? [{ groupCode: adjustmentGroup as "OA" | "CO", reasonCode: "45", amount: 30 }]
                : [],
            remarks: [],
            serviceLines: [],
          })),
        };
        const historicalSubmissionEvidenceIds = claimIds.map(() => crypto.randomUUID());
        const key = randomBytes(32);
        const cipher = createClaimMdProtectedPayloadCipher(
          {
            activeId: "m25-private-test",
            byId: new Map([["m25-private-test", key]]),
          },
          "claimmd-era-stage:v1",
        );
        const idempotencyKey = createHash("sha256").update(stageId).digest("hex");
        const original835Digest = createHash("sha256")
          .update(`synthetic-original:${stageId}`)
          .digest("hex");
        const sourceFileDigest = createHash("sha256")
          .update(`synthetic-file:${stageId}`)
          .digest("hex");
        const contentDigest = m25ContentDigestOf(parsed);
        const paymentTraceDigest = createHash("sha256").update(trace).digest("hex");
        const protectedDetailsCipher = cipher
          .seal(
            sourceInboxId,
            idempotencyKey,
            JSON.stringify({
              transactionSet: parsed,
              claimOutcomes: claimIds.map((claimId, index) => ({
                claimId,
                pcn: pcns[index],
                outcome: "verified",
                billingModule: "M41",
                fileIndex: 0,
                transactionSetControlNumber,
                submissionEvidenceIds: [historicalSubmissionEvidenceIds[index]],
              })),
            }),
          )
          .toString("base64");
        await admin.query(
          `INSERT INTO claimmd_era_m25_stage
          (id, organization_id, provider_entity_id, source_inbox_id, account_reference, usage,
           era_id, file_index, interchange_control_number, transaction_set_control_number,
           original_835_digest, source_file_digest, resolution_id, resolution_version,
           idempotency_key, source_evidence, protected_details_cipher, content_digest,
           payment_trace_digest, state)
         VALUES ($1,$2,$3,$4,'synthetic-account','test','9999',0,$5,$6,$7,$8,$9,1,
           $10,$11::jsonb,$12,$13,$14,'staged')`,
          [
            stageId,
            ORG_A,
            PE_A,
            sourceInboxId,
            parsed.interchangeControlNumber,
            transactionSetControlNumber,
            original835Digest,
            sourceFileDigest,
            resolutionId,
            idempotencyKey,
            JSON.stringify({
              evidenceCodes: ["EXACT_PAYEE_NPI", "SINGLE_PROVIDER_ARTIFACT"],
            }),
            protectedDetailsCipher,
            contentDigest,
            paymentTraceDigest,
          ],
        );

        // Seed the real M41-owned historical attempt and M23-owned immutable send evidence. The
        // reviewer below must discover this claim through the production owner-reader composition,
        // not a test candidate that bypasses either module's persistence and scope checks.
        const commercialPayerId = payerId;
        await admin.query(
          `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,$3,'Synthetic Hospice','1999999999',decode('00','hex'),'12-31')
         ON CONFLICT (id) DO NOTHING`,
          [PE_A, ORG_A, `SYN${stageId.slice(0, 6)}`],
        );
        await admin.query(
          `INSERT INTO payer (id,kind,name,status) VALUES ($1,'commercial',$2,'active') ON CONFLICT (id) DO NOTHING`,
          [commercialPayerId, `Synthetic Claim.MD payer ${stageId.slice(0, 8)}`],
        );
        const commercialPlanId = crypto.randomUUID();
        await admin.query(
          `INSERT INTO commercial_payer_plan
          (id,organization_id,payer_id,plan_name,claim_filing_indicator,authorization_requirement,effective_from)
         VALUES ($1,$2,$3,$4,'CI','not_required','2026-01-01')`,
          [commercialPlanId, ORG_A, commercialPayerId, `Synthetic plan ${stageId.slice(0, 8)}`],
        );
        const submissionIds: string[] = [];
        for (let index = 0; index < claimCount; index += 1) {
          const currentClaimId = claimIds[index]!;
          const pcn = pcns[index]!;
          const submissionId = crypto.randomUUID();
          submissionIds.push(submissionId);
          await admin.query(
            `INSERT INTO commercial_claim
            (id,organization_id,provider_entity_id,patient_id,admission_id,plan_id,primary_patient_payer_id,
             claim_filing_indicator,tob,frequency_code,service_from,service_to,admission_date,patient_status_code,
             claim_control_number,total_charge_cents,state,ready_at,created_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'CI','811','1','2026-03-01','2026-03-31','2026-03-01','30',$8,$9,'submitted',now(),$10)`,
            [
              currentClaimId,
              ORG_A,
              PE_A,
              crypto.randomUUID(),
              crypto.randomUUID(),
              commercialPlanId,
              crypto.randomUUID(),
              pcn,
              partialClaimIndex === index ? 10000 : 4200,
              crypto.randomUUID(),
            ],
          );
          await admin.query(
            `INSERT INTO commercial_submission
            (id,organization_id,provider_entity_id,claim_id,idempotency_key,control_number,
             clearinghouse_key,clearinghouse_payer_id,status,attempt_count,requested_by_membership_id,sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,'claimmd',$7,'sent',1,$8,now())`,
            [
              submissionId,
              ORG_A,
              PE_A,
              currentClaimId,
              `synthetic-${stageId}-${index}`,
              pcn,
              payerId,
              crypto.randomUUID(),
            ],
          );
          await admin.query(
            `INSERT INTO claimmd_submission_evidence
            (id,organization_id,provider_entity_id,claim_id,billing_module,submission_id,attempt_key,vendor,
             account_reference,usage,billing_npi,billing_tin_ciphertext,payer_id,claim_type,pcn,isa13,gs06,st02,
             service_from,service_to,payload_sha256,payload_format,outbound_reference,reserved_at)
           VALUES ($1,$2,$3,$4,'M41',$5,$6,'claimmd','synthetic-account','test','1999999999',repeat('x',48),
             $7,'institutional',$8,'000000941','941','0941','20260301','20260331',$9,'x12',$10,now())`,
            [
              historicalSubmissionEvidenceIds[index],
              ORG_A,
              PE_A,
              currentClaimId,
              submissionId,
              `${submissionId}:1`,
              payerId,
              pcn,
              createHash("sha256").update(`synthetic-x12:${stageId}:${index}`).digest("hex"),
              `synthetic-outbound-${stageId}-${index}`,
            ],
          );
        }
        const historicalReader = async (
          input: Parameters<typeof readClaimMdEraCandidateEvidence>[0],
        ) => {
          const evidenceRows = await readClaimMdEraCandidateEvidence(input);
          return readM41HistoricalEraCandidates({ ...input, evidenceRows });
        };
        const discoveredAttempt = await withOrgContext(
          handle.db,
          { organizationId: ORG_A, userId: "" },
          (tx) =>
            historicalReader({
              tx,
              organizationId: ORG_A,
              providerEntityId: PE_A,
              accountReference: "synthetic-account",
              usage: "test",
              pcn: pcns[0]!,
            }),
        );
        expect(discoveredAttempt).toHaveLength(1);
        expect(discoveredAttempt[0]).toMatchObject({
          module: "M41",
          claimId,
          submissionId: submissionIds[0],
          attemptKey: `${submissionIds[0]}:1`,
          payerId,
          pcn: pcns[0]!,
          chargeCents: partialClaimIndex === 0 ? 10000 : 4200,
          attemptState: "sent",
          serviceFrom: "20260301",
          serviceTo: "20260331",
        });
        const outboxPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
        const outbox: WriteOutboxPort = {
          publish: (tx, emission) =>
            outboxPublisher.publish(tx as never, {
              ...emission,
              callerModule: "m25",
            }),
        };
        const m25Claims = {
          async candidatesForLine(
            input: Parameters<ClaimMatchCandidateProvider["candidatesForLine"]>[0],
          ) {
            const index = pcns.indexOf(input.patientControlNumber ?? "");
            return index < 0
              ? []
              : [
                  {
                    claimId: claimIds[index]!,
                    payerIcn: parsed.claims[index]!.payerIcn,
                    claimControlNumber: pcns[index]!,
                  },
                ];
          },
          async patientIdForClaim() {
            return null;
          },
        };
        const ingestService = buildDrizzleM25IngestService(handle.db, {
          client: fakeClient(new Map()),
          payeeNpi: PAYEE_UNCHECKED,
          claims: { commercial: m25Claims },
          outbox,
          terminology: fakeTerminology({
            "45": { category: "informational", plainLanguage: "other adjustment; review required" },
          }),
        });
        const review = buildDrizzleClaimMdEraReviewService(
          handle.db,
          cipher,
          undefined,
          [historicalReader],
          { ingestService, enabled: true },
        );
        const reviewActor = {
          organizationId: ORG_A,
          userId: "60000000-0000-4000-8000-000000000001",
          roles: ["billing_specialist"],
          providerEntityScope: [PE_A],
          membershipId: crypto.randomUUID(),
          stepUpRecent: true,
        };
        const approverActor = {
          ...reviewActor,
          userId: "60000000-0000-4000-8000-000000000002",
          membershipId: crypto.randomUUID(),
        };
        const executorActor = {
          ...reviewActor,
          userId: "60000000-0000-4000-8000-000000000003",
          membershipId: crypto.randomUUID(),
        };
        const staleExecutorActor = { ...executorActor, stepUpRecent: false };
        const matchingActor = {
          ...reviewActor,
          userId: "60000000-0000-4000-8000-000000000004",
          membershipId: crypto.randomUUID(),
        };
        const foreignReviewActor = {
          ...reviewActor,
          organizationId: ORG_B,
          providerEntityScope: [PE_B],
          userId: "60000000-0000-4000-8000-000000000005",
          membershipId: crypto.randomUUID(),
        };
        const httpActors = new Map([
          [
            "reviewer",
            {
              actor: reviewActor,
              permissions: ["remittance.read", "remittance.financial_review"],
            },
          ],
          [
            "approver",
            {
              actor: approverActor,
              permissions: ["remittance.posting.approve"],
            },
          ],
          [
            "executor",
            {
              actor: executorActor,
              permissions: ["remittance.posting.execute"],
            },
          ],
          [
            "stale-executor",
            {
              actor: staleExecutorActor,
              permissions: ["remittance.posting.execute"],
            },
          ],
          ["matching-reviewer", { actor: matchingActor, permissions: ["remittance.match_review"] }],
          [
            "foreign-reviewer",
            {
              actor: foreignReviewActor,
              permissions: ["remittance.financial_review"],
            },
          ],
        ]);
        await admin.query(
          `INSERT INTO "user" (id,email,email_verified,name) VALUES
           ($1,$2,true,'Synthetic M25 Reviewer'),($3,$4,true,'Synthetic M25 Approver'),
           ($5,$6,true,'Synthetic M25 Executor'),($7,$8,true,'Synthetic M25 Matching Reviewer'),
           ($9,$10,true,'Synthetic M25 Foreign Reviewer')
         ON CONFLICT (id) DO NOTHING`,
          [
            reviewActor.userId,
            `m25-review-${stageId}@synthetic.invalid`,
            approverActor.userId,
            `m25-approver-${stageId}@synthetic.invalid`,
            executorActor.userId,
            `m25-executor-${stageId}@synthetic.invalid`,
            matchingActor.userId,
            `m25-matching-${stageId}@synthetic.invalid`,
            foreignReviewActor.userId,
            `m25-foreign-${stageId}@synthetic.invalid`,
          ],
        );
        const http = Fastify();
        injectedApps.push(http);
        http.addHook("onRequest", async (request) => {
          // This test authenticator maps a fixed synthetic principal name to server-owned identity
          // facts. It does not accept tenant, permission, provider, membership or step-up values
          // from request payloads or headers.
          const principal = request.headers["x-test-principal"];
          const resolved = typeof principal === "string" ? httpActors.get(principal) : undefined;
          if (!resolved) return;
          request.context = {
            correlationId: crypto.randomUUID(),
            userId: resolved.actor.userId,
            organizationId: resolved.actor.organizationId,
            providerEntityIds: [...(resolved.actor.providerEntityScope ?? [])],
            locationIds: [],
            roles: [...resolved.actor.roles],
            attributes: {
              membershipId: resolved.actor.membershipId,
              sessionId: resolved.actor.userId,
              stepUpRecent: resolved.actor.stepUpRecent,
            },
            ip: "127.0.0.1",
            userAgent: "synthetic-live-test",
            startTime: Date.now(),
          };
        });
        setEffectivePermissionResolver((context) =>
          Promise.resolve(
            new Set(
              [...httpActors.values()].find((entry) => entry.actor.userId === context.userId)
                ?.permissions ?? [],
            ),
          ),
        );
        const authz = createPredicateRegistry();
        authz.register(
          "step_up_recent",
          async (context) => context.attributes.stepUpRecent === true,
        );
        registerAbacRegistry(authz);
        registerClaimMdEraReviewRoutes(http, review);
        const inject = async (
          principal: string,
          method: "GET" | "POST",
          url: string,
          payload?: Record<string, unknown>,
          idempotencyKey?: string,
        ) => {
          const response = await http.inject({
            method,
            url,
            headers: {
              "x-test-principal": principal,
              ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
            },
            ...(payload ? { payload } : {}),
          });
          return {
            statusCode: response.statusCode,
            body: response.json() as Record<string, unknown>,
          };
        };
        const reviewResponse = await inject(
          "reviewer",
          "POST",
          `/api/v1/remittance/claimmd-era/${stageId}/financial-review/decision`,
          {
            itemType: "era",
            itemIndex: -1,
            disposition: "completed",
            expectedVersion: 0,
            reason: "Synthetic source and claim facts reviewed",
          },
          `review-${stageId}`,
        );
        expect(reviewResponse.statusCode).toBe(200);
        const planResponse = await inject(
          "reviewer",
          "POST",
          `/api/v1/remittance/claimmd-era/${stageId}/posting-plan`,
        );
        expect(planResponse.statusCode, JSON.stringify(planResponse.body)).toBe(200);
        let plan = planResponse.body as unknown as Awaited<ReturnType<typeof review.postingPlan>>;
        if (providerAdjustmentReason) {
          expect(plan).toMatchObject({
            eligible: false,
            status: "blocked",
            blockers: expect.arrayContaining([
              "UNSUPPORTED_FINANCIAL_FACTS",
              "PROVIDER_ADJUSTMENT_POLICY_UNAVAILABLE",
            ]),
            providerAdjustments: [
              {
                sourceDigest: original835Digest,
                fiscalPeriod: "2026-03-31",
                segmentPosition: 9,
                occurrence: 1,
                reason: "WO",
                reference: `SYNTHETIC-FCN-${stageId.slice(0, 8)}`,
                amountCents: 500,
                classification: "overpayment_recovery_reported",
                historicalReference: "not_verified",
                policy: { status: "not_configured", version: null },
                action: "none",
              },
            ],
          });
          const detail = await review.get(reviewActor, stageId);
          expect(detail?.providerAdjustments[0]).toMatchObject({
            amount: 5,
            fiscalPeriod: "2026-03-31",
            segmentPosition: 9,
            occurrence: 1,
            classification: "overpayment_recovery_reported",
            historicalReference: "not_verified",
            policyStatus: "not_configured",
            postingEligible: false,
          });
          expect(detail?.providerAdjustments[0]?.providerIdentifierMasked).toBe("••••9999");
          const matching = await review.matching(reviewActor, stageId);
          expect(matching?.readOnlyBalance).toMatchObject({
            status: "balanced",
            claimPaymentsCents: 4200,
            providerAdjustmentsCents: 500,
            reportedPaymentCents: 3700,
            differenceCents: 0,
          });
          expect(matching?.financialReview.exceptions).toContainEqual({
            code: "PROVIDER_ADJUSTMENT_REQUIRES_POLICY_REVIEW",
            severity: "follow_up",
            blocksReviewCompletion: false,
            blocksFuturePosting: true,
          });
          const reviewAction = await review.recordFinancialReviewDecision(reviewActor, stageId, {
            itemType: "era",
            itemIndex: -1,
            disposition: "follow_up",
            expectedVersion: 1,
            reason: "Synthetic WO reference requires finance investigation",
            idempotencyKey: `plb-follow-up-${stageId}`,
          });
          expect(reviewAction).toMatchObject({ decisionVersion: 2, disposition: "follow_up" });
          const decisionCount = await admin.query(
            `SELECT count(*)::int AS n FROM claimmd_era_financial_review_decision
             WHERE organization_id=$1 AND stage_id=$2 AND item_type='era' AND item_index=-1`,
            [ORG_A, stageId],
          );
          expect(decisionCount.rows[0].n).toBe(2);
          const noAdvice = await admin.query(
            `SELECT count(*)::int AS n FROM remittance_advice WHERE organization_id=$1
             AND provider_entity_id=$2 AND check_or_eft_trace_number=$3`,
            [ORG_A, PE_A, trace],
          );
          expect(noAdvice.rows[0].n).toBe(0);
          const noEvents = await admin.query(
            `SELECT count(*)::int AS n FROM outbox_event WHERE organization_id=$1
             AND aggregate_id=$2 AND event_type LIKE 'm25.remittance.%'`,
            [ORG_A, stageId],
          );
          expect(noEvents.rows[0].n).toBe(0);
          return;
        }
        if (adjustmentGroup === "CO") {
          expect(plan).toMatchObject({
            eligible: false,
            status: "blocked",
            blockers: expect.arrayContaining(["CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE"]),
            claims: [
              {
                financialStatus: "unsupported",
                eligible: false,
                adjustments: [
                  {
                    groupCode: "CO",
                    reasonCode: "45",
                    amountCents: 3000,
                    responsibility: "provider_reported",
                    classification: "contractual_obligation_reported",
                    accountingDisposition: "policy_required",
                    policyVersion: null,
                    m25Action: "not_authorized",
                  },
                ],
                blockers: expect.arrayContaining(["CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE"]),
              },
            ],
          });
          const noAdvice = await admin.query(
            "SELECT count(*)::int AS n FROM remittance_advice WHERE organization_id=$1 AND provider_entity_id=$2 AND check_or_eft_trace_number=$3",
            [ORG_A, PE_A, trace],
          );
          expect(noAdvice.rows[0].n).toBe(0);
          const unchangedClaim = await admin.query(
            "SELECT state,total_charge_cents FROM commercial_claim WHERE id=$1",
            [claimId],
          );
          expect(unchangedClaim.rows[0]).toEqual({
            state: "submitted",
            total_charge_cents: "10000",
          });
          return;
        }
        const expectedPaymentCents = claimIds.reduce(
          (sum, _, index) => sum + (index === partialClaimIndex ? 7000 : 4200),
          0,
        );
        expect(plan.blockers).toEqual([]);
        expect(plan).toMatchObject({
          eligible: true,
          paymentCents: expectedPaymentCents,
          billedCents: partialClaimIndex < 0 ? 4200 * claimCount : 10000,
          unresolvedCents: partialClaimIndex < 0 ? 0 : 3000,
          claimId,
          claims: expect.arrayContaining(
            claimIds.map((id) => expect.objectContaining({ claimId: id })),
          ),
          status: "eligible",
        });
        if (partialClaimIndex >= 0) {
          expect(plan.claims[partialClaimIndex]).toMatchObject({
            billedCents: 10000,
            paidCents: 7000,
            patientResponsibilityCents: 0,
            financialStatus: "partial_paid",
            unresolvedCents: 3000,
            adjustments: [
              {
                scope: "claim",
                groupCode: "OA",
                reasonCode: "45",
                amountCents: 3000,
                classification: "other_adjustment_unresolved",
                m25Action: "flagged_review",
              },
            ],
          });
        }
        const planAction = {
          planDigest: plan.planDigest,
          reason: "Synthetic authorization boundary test",
        };
        expect(
          (
            await inject(
              "reviewer",
              "POST",
              `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/approval`,
              planAction,
              `approval-denied-reviewer-${stageId}`,
            )
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await inject(
              "executor",
              "POST",
              `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/execution`,
              planAction,
              `execution-denied-unapproved-${stageId}`,
            )
          ).statusCode,
        ).not.toBe(200);
        expect(
          (
            await inject(
              "foreign-reviewer",
              "POST",
              `/api/v1/remittance/claimmd-era/${stageId}/posting-plan`,
            )
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await inject(
              "stale-executor",
              "POST",
              `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/execution`,
              planAction,
              `execution-denied-step-up-${stageId}`,
            )
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await inject(
              "matching-reviewer",
              "POST",
              `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/approval`,
              planAction,
              `approval-denied-matcher-${stageId}`,
            )
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await inject(
              "reviewer",
              "POST",
              `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/execution`,
              planAction,
              `execution-denied-reviewer-${stageId}`,
            )
          ).statusCode,
        ).toBe(403);
        const foreignActor = {
          ...reviewActor,
          organizationId: ORG_B,
          providerEntityScope: [PE_B],
          membershipId: crypto.randomUUID(),
        };
        const outOfProviderActor = {
          ...reviewActor,
          providerEntityScope: [PE_B],
          membershipId: crypto.randomUUID(),
        };
        await expect(review.postingPlan(foreignActor, stageId)).rejects.toThrow();
        await expect(review.postingPlan(outOfProviderActor, stageId)).rejects.toThrow();
        await expect(
          review.approvePostingPlan(foreignActor, stageId, {
            planId: plan.planId,
            planDigest: plan.planDigest,
            reason: "Cross-tenant authorization refusal",
            idempotencyKey: `approve-foreign-${stageId}`,
          }),
        ).rejects.toThrow();
        await expect(
          review.executePostingPlan(foreignActor, stageId, {
            planId: plan.planId,
            planDigest: plan.planDigest,
            reason: "Cross-tenant execution refusal",
            idempotencyKey: `execute-foreign-${stageId}`,
          }),
        ).rejects.toThrow();
        const preApprovalAdvice = await admin.query(
          "SELECT count(*)::int AS n FROM remittance_advice WHERE parse_summary->>'stageId'=$1",
          [stageId],
        );
        expect(preApprovalAdvice.rows[0].n).toBe(0);
        expect(
          await admin.query("SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1", [
            stageId,
          ]),
        ).toMatchObject({ rows: [{ n: 0 }] });

        await review.approvePostingPlan(approverActor, stageId, {
          planId: plan.planId,
          planDigest: plan.planDigest,
          reason: "Approved synthetic fully paid claim",
          idempotencyKey: `approve-first-${stageId}`,
        });
        await review.recordFinancialReviewDecision(reviewActor, stageId, {
          itemType: "era",
          itemIndex: -1,
          disposition: "reopened",
          expectedVersion: 1,
          reason: "Synthetic test invalidates the approved review revision",
          idempotencyKey: `reopen-${stageId}`,
        });
        await expect(
          review.executePostingPlan(executorActor, stageId, {
            planId: plan.planId,
            planDigest: plan.planDigest,
            reason: "Stale approved plan must be refused",
            idempotencyKey: `execute-stale-${stageId}`,
          }),
        ).rejects.toThrow("source, matching or financial review changed after approval");
        await review.recordFinancialReviewDecision(reviewActor, stageId, {
          itemType: "era",
          itemIndex: -1,
          disposition: "completed",
          expectedVersion: 2,
          reason: "Re-reviewed unchanged synthetic source",
          idempotencyKey: `recomplete-${stageId}`,
        });
        const stalePlanId = plan.planId;
        plan = await review.postingPlan(reviewActor, stageId);
        expect(plan.planId).not.toBe(stalePlanId);
        const approvalResponse = await inject(
          "approver",
          "POST",
          `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/approval`,
          {
            planDigest: plan.planDigest,
            reason: "Approved current synthetic plan after re-review",
          },
          `approve-${stageId}`,
        );
        expect(approvalResponse.statusCode).toBe(200);
        expect(
          (
            await inject(
              "approver",
              "POST",
              `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/execution`,
              {
                planDigest: plan.planDigest,
                reason: "Approval permission alone must not execute",
              },
              `execution-denied-approver-${stageId}`,
            )
          ).statusCode,
        ).toBe(403);
        const postApprovalAdvice = await admin.query(
          "SELECT count(*)::int AS n FROM remittance_advice WHERE parse_summary->>'stageId'=$1",
          [stageId],
        );
        expect(postApprovalAdvice.rows[0].n).toBe(0);
        const disabledReview = buildDrizzleClaimMdEraReviewService(
          handle.db,
          cipher,
          undefined,
          [historicalReader],
          { ingestService, enabled: false },
        );
        await expect(
          disabledReview.executePostingPlan(executorActor, stageId, {
            planId: plan.planId,
            planDigest: plan.planDigest,
            reason: "Capability gate remains disabled",
            idempotencyKey: `execute-disabled-${stageId}`,
          }),
        ).rejects.toThrow("controlled Claim.MD ERA posting is disabled");
        const disabledAdvice = await admin.query(
          "SELECT count(*)::int AS n FROM remittance_advice WHERE parse_summary->>'stageId'=$1",
          [stageId],
        );
        expect(disabledAdvice.rows[0].n).toBe(0);
        const financialEventBaseline = await admin.query(
          `SELECT count(*)::int AS n FROM outbox_event
         WHERE event_type IN ('m25.remittance.claim_paid','m25.remittance.claim_partial_paid','m25.remittance.advice_posted')
           AND organization_id=$1`,
          [ORG_A],
        );

        await admin.query(`
        CREATE OR REPLACE FUNCTION test_fail_claimmd_posting_event() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.event_type = 'posted' THEN RAISE EXCEPTION 'forced posting evidence failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_fail_claimmd_posting_event
          BEFORE INSERT ON claimmd_era_posting_event
          FOR EACH ROW EXECUTE FUNCTION test_fail_claimmd_posting_event();
      `);
        try {
          await expect(
            review.executePostingPlan(executorActor, stageId, {
              planId: plan.planId,
              planDigest: plan.planDigest,
              reason: "Force rollback after M25 persistence",
              idempotencyKey: `execute-rollback-${stageId}`,
            }),
          ).rejects.toThrow();
        } finally {
          await admin.query(
            "DROP TRIGGER IF EXISTS test_fail_claimmd_posting_event ON claimmd_era_posting_event",
          );
          await admin.query("DROP FUNCTION IF EXISTS test_fail_claimmd_posting_event()");
        }
        const rolledBackAdvice = await admin.query(
          "SELECT count(*)::int AS n FROM remittance_advice WHERE parse_summary->>'stageId'=$1",
          [stageId],
        );
        expect(rolledBackAdvice.rows[0].n).toBe(0);
        const rolledBackFinancialEvents = await admin.query(
          `SELECT count(*)::int AS n FROM outbox_event
         WHERE event_type IN ('m25.remittance.claim_paid','m25.remittance.claim_partial_paid','m25.remittance.advice_posted')
           AND organization_id=$1`,
          [ORG_A],
        );
        expect(rolledBackFinancialEvents.rows[0].n).toBe(financialEventBaseline.rows[0].n);

        const concurrentResults = await Promise.all([
          inject(
            "executor",
            "POST",
            `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/execution`,
            {
              planDigest: plan.planDigest,
              reason: "Execute approved synthetic claim payment",
            },
            `execute-a-${stageId}`,
          ),
          inject(
            "executor",
            "POST",
            `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/execution`,
            {
              planDigest: plan.planDigest,
              reason: "Concurrent approved synthetic claim execution",
            },
            `execute-b-${stageId}`,
          ),
        ]);
        expect(
          concurrentResults.map((response) => response.statusCode),
          JSON.stringify(concurrentResults.map((response) => response.body)),
        ).toEqual([200, 200]);
        const results = concurrentResults.map((response) => response.body as { outcome: string });
        expect(results.map((result) => result.outcome).sort()).toEqual([
          "already_posted",
          "posted",
        ]);
        const posted = concurrentResults
          .map(
            (response) =>
              response.body as {
                outcome: string;
                adviceId?: string;
                remittanceLineId: string | null;
                remittanceLineIds: string[];
                paymentCents: number;
              },
          )
          .find((result) => result.outcome === "posted")!;
        if (!posted.adviceId) throw new Error("posted result must include its persisted advice id");
        expect(posted).toMatchObject({ outcome: "posted", paymentCents: expectedPaymentCents });
        const lines = await admin.query(
          `SELECT organization_id, claim_id, clp04_total_payment_amount, match_state
         FROM remittance_line WHERE id=ANY($1::uuid[]) ORDER BY claim_id`,
          [posted.remittanceLineIds],
        );
        expect(lines.rows).toHaveLength(claimCount);
        expect(lines.rows.map((row) => row.claim_id).sort()).toEqual([...claimIds].sort());
        expect(
          lines.rows.every(
            (row) =>
              row.organization_id === ORG_A &&
              row.match_state === "posted" &&
              row.clp04_total_payment_amount ===
                (claimIds.indexOf(row.claim_id) === partialClaimIndex ? "70.00" : "42.00"),
          ),
        ).toBe(true);
        const advice = await admin.query(
          "SELECT organization_id, provider_entity_id, parse_status, parse_summary FROM remittance_advice WHERE id=$1",
          [posted.adviceId],
        );
        expect(advice.rows[0]).toMatchObject({
          organization_id: ORG_A,
          provider_entity_id: PE_A,
          parse_status: "posted",
          parse_summary: {
            source: "claimmd_stage",
            stageId,
            planId: plan.planId,
            associationEvidence: expect.arrayContaining(
              claimIds.map((id) => ({
                claimId: id,
                evidenceId: expect.any(String),
                evidenceVersion: 1,
              })),
            ),
          },
        });
        const postingEvents = await review.postingHistory(reviewActor, stageId);
        expect(postingEvents.map((event) => event.eventType)).toEqual(
          expect.arrayContaining(["posted", "approved"]),
        );
        expect(
          postingEvents.find((event) => event.eventType === "posted")?.remittanceLineIds,
        ).toEqual(posted.remittanceLineIds);
        const paid = await admin.query(
          "SELECT event_type, count(*)::int AS n FROM outbox_event WHERE event_type IN ('m25.remittance.claim_paid','m25.remittance.claim_partial_paid') AND aggregate_id=ANY($1::uuid[]) GROUP BY event_type",
          [posted.remittanceLineIds],
        );
        if (partialClaimIndex >= 0) {
          const adjustmentRows = await admin.query(
            `SELECT cas_group_code, cas_reason_code, adjustment_amount, post_action
             FROM remittance_adjustment WHERE remittance_line_id=$1`,
            [posted.remittanceLineIds[partialClaimIndex]],
          );
          expect(adjustmentRows.rows).toEqual([
            {
              cas_group_code: "OA",
              cas_reason_code: "45",
              adjustment_amount: "30.00",
              post_action: "flagged_review",
            },
          ]);
          const patientLedger = await admin.query(
            "SELECT count(*)::int AS n FROM patient_responsibility_ledger WHERE remittance_line_id=$1",
            [posted.remittanceLineIds[partialClaimIndex]],
          );
          expect(patientLedger.rows[0].n).toBe(0);
        }
        const partialEvents = await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m25.remittance.claim_partial_paid' AND aggregate_id=ANY($1::uuid[])",
          [posted.remittanceLineIds],
        );
        expect(partialEvents.rows[0].n).toBe(partialClaimIndex < 0 ? 0 : 1);
        const advicePosted = await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m25.remittance.advice_posted' AND aggregate_id=$1",
          [posted.adviceId],
        );
        expect(paid.rows.reduce((sum, row) => sum + row.n, 0)).toBe(claimCount);
        expect(
          paid.rows.find((row) => row.event_type === "m25.remittance.claim_partial_paid")?.n ?? 0,
        ).toBe(partialClaimIndex < 0 ? 0 : 1);
        expect(advicePosted.rows[0].n).toBe(1);
        const outboxCatalog = buildBootOutboxCatalog([M25_OUTBOX_EVENTS, M41_OUTBOX_EVENTS]);
        const downstreamPublisher = buildTxOutboxPublisher(outboxCatalog);
        const m41Consumer = buildM41RemittanceConsumer({
          db: handle.db,
          outbox: {
            publish: (tx, emission) =>
              downstreamPublisher.publish(tx as never, {
                ...emission,
                callerModule: "m41",
              }),
          },
        });
        const paidEvent = await admin.query(
          `SELECT id, organization_id, event_type, aggregate_kind, aggregate_id, payload,
                attempt_count, created_at
         FROM outbox_event
         WHERE event_type IN ('m25.remittance.claim_paid','m25.remittance.claim_partial_paid')
           AND aggregate_id=ANY($1::uuid[]) ORDER BY aggregate_id`,
          [posted.remittanceLineIds],
        );
        expect(paidEvent.rows).toHaveLength(claimCount);
        const eventRows = paidEvent.rows;
        const beforeRestartHistory = await admin.query(
          "SELECT count(*)::int AS n FROM commercial_claim_state_history WHERE claim_id=ANY($1::uuid[])",
          [claimIds],
        );
        expect(beforeRestartHistory.rows[0].n).toBe(0);
        // Simulate the dispatcher process stopping after its durable claim but before invoking a
        // consumer. The event stays persisted in dispatching until its visibility lease expires.
        await admin.query(
          `UPDATE outbox_event SET status='dispatched'
         WHERE organization_id=$1 AND status IN ('pending','dispatching')`,
          [ORG_A],
        );
        await admin.query(
          `UPDATE outbox_event SET status='dispatching', dispatched_at=now() - interval '1 minute'
         WHERE id=ANY($1::uuid[])`,
          [eventRows.map((row) => row.id)],
        );
        const restartDispatcher = createOutboxDispatcher({
          db: handle.db,
          orgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
          eventCatalog: outboxCatalog,
          consumers: [
            {
              consumerName: "m23.m25-remittance-test-binding",
              consumerModule: "m23",
              eventTypes: ["m25.remittance.claim_paid", "m25.remittance.claim_partial_paid"],
              async handle() {},
            },
            {
              consumerName: "m24.m25-remittance-test-binding",
              consumerModule: "m24",
              eventTypes: ["m25.remittance.claim_paid"],
              async handle() {},
            },
            {
              consumerName: "m26.m25-remittance-test-binding",
              consumerModule: "m26",
              eventTypes: ["m25.remittance.claim_paid", "m25.remittance.claim_partial_paid"],
              async handle() {},
            },
            m41Consumer,
          ],
          options: { visibilityTimeoutMs: 1, log: () => {} },
        });
        const recovery = await restartDispatcher.tick();
        expect(recovery.reclaimed).toBeGreaterThanOrEqual(1);
        expect(recovery.delivered).toBeGreaterThanOrEqual(claimCount);
        const afterFirstRecovery = await admin.query(
          "SELECT claim_id, from_state, to_state FROM commercial_claim_state_history WHERE claim_id=ANY($1::uuid[]) ORDER BY claim_id, created_at",
          [claimIds],
        );
        expect(afterFirstRecovery.rows).toHaveLength(claimCount);
        expect(
          afterFirstRecovery.rows.every(
            (row) =>
              row.from_state === "submitted" &&
              row.to_state ===
                (claimIds.indexOf(row.claim_id) === partialClaimIndex ? "partially_paid" : "paid"),
          ),
        ).toBe(true);
        // Simulate the second crash window: M41's transaction committed, but the dispatcher died
        // before saving its consumer receipt. Re-delivery must be idempotent at the real consumer.
        await admin.query(
          "DELETE FROM outbox_consumer_receipt WHERE event_id=ANY($1::uuid[]) AND consumer_name='m41.m25-remittance'",
          [eventRows.map((row) => row.id)],
        );
        await admin.query(
          `UPDATE outbox_event SET status='dispatching', dispatched_at=now() - interval '1 minute'
         WHERE id=ANY($1::uuid[])`,
          [eventRows.map((row) => row.id)],
        );
        const retryDispatcher = createOutboxDispatcher({
          db: handle.db,
          orgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
          eventCatalog: outboxCatalog,
          consumers: [
            {
              consumerName: "m23.m25-remittance-test-binding",
              consumerModule: "m23",
              eventTypes: ["m25.remittance.claim_paid", "m25.remittance.claim_partial_paid"],
              async handle() {},
            },
            {
              consumerName: "m24.m25-remittance-test-binding",
              consumerModule: "m24",
              eventTypes: ["m25.remittance.claim_paid"],
              async handle() {},
            },
            {
              consumerName: "m26.m25-remittance-test-binding",
              consumerModule: "m26",
              eventTypes: ["m25.remittance.claim_paid", "m25.remittance.claim_partial_paid"],
              async handle() {},
            },
            m41Consumer,
          ],
          options: { visibilityTimeoutMs: 1, log: () => {} },
        });
        const redelivery = await retryDispatcher.tick();
        expect(redelivery.reclaimed).toBeGreaterThanOrEqual(1);
        const afterRedeliveryHistory = await admin.query(
          "SELECT claim_id, from_state, to_state FROM commercial_claim_state_history WHERE claim_id=ANY($1::uuid[]) ORDER BY claim_id, created_at",
          [claimIds],
        );
        expect(afterRedeliveryHistory.rows).toHaveLength(claimCount);
        expect(
          afterRedeliveryHistory.rows.every(
            (row) =>
              row.from_state === "submitted" &&
              row.to_state ===
                (claimIds.indexOf(row.claim_id) === partialClaimIndex ? "partially_paid" : "paid"),
          ),
        ).toBe(true);
        const recoveredOutbox = await admin.query(
          "SELECT status FROM outbox_event WHERE id=ANY($1::uuid[])",
          [eventRows.map((row) => row.id)],
        );
        expect(recoveredOutbox.rows).toHaveLength(claimCount);
        expect(recoveredOutbox.rows.every((row) => row.status === "dispatched")).toBe(true);
        const consumerReceipts = await admin.query(
          "SELECT count(*)::int AS n FROM outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])",
          [eventRows.map((row) => row.id)],
        );
        expect(consumerReceipts.rows[0].n).toBe(
          4 * (claimCount - (partialClaimIndex < 0 ? 0 : 1)) + (partialClaimIndex < 0 ? 0 : 3),
        );
        expect(
          await inject(
            "executor",
            "POST",
            `/api/v1/remittance/claimmd-era/${stageId}/posting-plans/${plan.planId}/execution`,
            {
              planDigest: plan.planDigest,
              reason: "Idempotent execution retry",
            },
            `execute-retry-${stageId}`,
          ),
        ).toMatchObject({
          statusCode: 200,
          body: {
            outcome: "already_posted",
            remittanceLineIds: posted.remittanceLineIds,
          },
        });
        expect(
          await admin.query(
            "SELECT count(*)::int AS n FROM remittance_line WHERE id=ANY($1::uuid[])",
            [posted.remittanceLineIds],
          ),
        ).toMatchObject({ rows: [{ n: claimCount }] });

        // Exercise the other direction of the cross-source guard: after the Claim.MD staged
        // transaction has committed, a legacy/manual intake of the same supported effect must be
        // retained for history but held without another payment line or posting event.
        const legacyRaw = buildRawEdi(
          parsed.interchangeControlNumber,
          parsed.transactionSetControlNumber,
        );
        const legacyKey = `manual/claimmd-duplicate-${stageId}.835`;
        const stagedLegacyPayloads = new Map<string, string>();
        const legacyService = buildDrizzleM25IngestService(handle.db, {
          client: fakeClient(new Map([[legacyKey, parsed]])),
          rawStore: {
            async put(_organizationId, adviceId, value) {
              stagedLegacyPayloads.set(adviceId, value);
            },
            async get(_organizationId, adviceId) {
              return stagedLegacyPayloads.get(adviceId) ?? null;
            },
            async delete(_organizationId, adviceId) {
              stagedLegacyPayloads.delete(adviceId);
            },
          },
          payeeNpi: PAYEE_UNCHECKED,
          claims: { commercial: m25Claims },
          outbox,
        });
        const legacyReceived = await legacyService.receiveAdvice(
          { organizationId: ORG_A },
          {
            providerEntityId: PE_A,
            payerId,
            payerKind: "commercial",
            minioObjectKey: legacyKey,
            fileSha256: sha256Hex(legacyRaw),
            rawEdi: legacyRaw,
          },
        );
        expect(legacyReceived).toMatchObject({
          outcome: "review_required",
          reason: "CLAIMMD_ERA_STAGE_MATCH",
          stageId,
        });
        expect(await lineCount(posted.adviceId)).toBe(claimCount);
        const adviceCount = await admin.query(
          `SELECT count(*)::int AS n FROM remittance_advice
         WHERE organization_id=$1 AND provider_entity_id=$2 AND payer_id=$3 AND check_or_eft_trace_number=$4`,
          [ORG_A, PE_A, payerId, trace],
        );
        expect(adviceCount.rows[0].n).toBe(1);
        expect(stagedLegacyPayloads.size).toBe(0);
        const historyResponse = await inject(
          "reviewer",
          "GET",
          `/api/v1/remittance/claimmd-era/${stageId}/posting-history`,
        );
        expect(historyResponse.statusCode).toBe(200);
        expect(Array.isArray(historyResponse.body)).toBe(true);
        expect(historyResponse.body).toEqual(
          expect.arrayContaining([expect.objectContaining({ eventType: "posted" })]),
        );
      },
    );

    it("blocks a Claim.MD posting plan when the same financial effect was posted by legacy intake first", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const stageId = crypto.randomUUID();
      const sourceInboxId = crypto.randomUUID();
      const claimId = crypto.randomUUID();
      const payerId = crypto.randomUUID();
      const trace = `SYNTHETIC-LEGACY-FIRST-${suffix}`;
      const pcn = `SYNTHETIC-LEGACY-PCN-${suffix}`;
      const st02 = String(Date.now() % 100_000_000).padStart(8, "0");
      const parsed: ParsedRemittanceAdvice = {
        payerProgram: "commercial",
        payer: { name: "Synthetic Legacy-First Payer", id: payerId },
        payee: {
          name: "Synthetic Hospice",
          idQualifier: "XX",
          id: "1999999999",
        },
        interchangeControlNumber: st02.padStart(9, "0"),
        transactionSetControlNumber: st02,
        checkOrEftTraceNumber: trace,
        paymentMethod: "eft",
        totalPaymentAmount: 42,
        productionDate: "2026-03-01",
        claims: [
          {
            patientControlNumber: pcn,
            payerIcn: `SYNTHETIC-ICN-${suffix}`,
            statusCode: 1,
            totalCharge: 42,
            totalPayment: 42,
            patientResponsibility: 0,
            serviceFrom: "2026-03-01",
            serviceTo: "2026-03-31",
            adjustments: [],
            remarks: [],
            serviceLines: [],
          },
        ],
      };
      await admin.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,$3,'Synthetic Hospice','1999999999',decode('00','hex'),'12-31')
         ON CONFLICT (id) DO NOTHING`,
        [PE_A, ORG_A, `L${suffix}`],
      );
      await admin.query(
        `INSERT INTO payer (id,kind,name,status) VALUES ($1,'commercial',$2,'active')`,
        [payerId, `Synthetic legacy-first payer ${suffix}`],
      );
      const planId = crypto.randomUUID();
      await admin.query(
        `INSERT INTO commercial_payer_plan
          (id,organization_id,payer_id,plan_name,claim_filing_indicator,authorization_requirement,effective_from)
         VALUES ($1,$2,$3,$4,'CI','not_required','2026-01-01')`,
        [planId, ORG_A, payerId, `Synthetic legacy-first plan ${suffix}`],
      );
      await admin.query(
        `INSERT INTO commercial_claim
          (id,organization_id,provider_entity_id,patient_id,admission_id,plan_id,primary_patient_payer_id,
           claim_filing_indicator,tob,frequency_code,service_from,service_to,admission_date,patient_status_code,
           claim_control_number,total_charge_cents,state,ready_at,created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CI','811','1','2026-03-01','2026-03-31','2026-03-01','30',$8,4200,'submitted',now(),$9)`,
        [
          claimId,
          ORG_A,
          PE_A,
          crypto.randomUUID(),
          crypto.randomUUID(),
          planId,
          crypto.randomUUID(),
          pcn,
          crypto.randomUUID(),
        ],
      );
      const submissionId = crypto.randomUUID();
      const historicalEvidenceId = crypto.randomUUID();
      await admin.query(
        `INSERT INTO commercial_submission
          (id,organization_id,provider_entity_id,claim_id,idempotency_key,control_number,
           clearinghouse_key,clearinghouse_payer_id,status,attempt_count,requested_by_membership_id,sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,'claimmd',$7,'sent',1,$8,now())`,
        [
          submissionId,
          ORG_A,
          PE_A,
          claimId,
          `legacy-first-${suffix}`,
          pcn,
          payerId,
          crypto.randomUUID(),
        ],
      );
      await admin.query(
        `INSERT INTO claimmd_submission_evidence
          (id,organization_id,provider_entity_id,claim_id,billing_module,submission_id,attempt_key,vendor,
           account_reference,usage,billing_npi,billing_tin_ciphertext,payer_id,claim_type,pcn,isa13,gs06,st02,
           service_from,service_to,payload_sha256,payload_format,outbound_reference,reserved_at)
         VALUES ($1,$2,$3,$4,'M41',$5,$6,'claimmd','synthetic-legacy-account','test','1999999999',repeat('x',48),
           $7,'institutional',$8,'000000941',$9,$10,'20260301','20260331',$11,'x12',$12,now())`,
        [
          historicalEvidenceId,
          ORG_A,
          PE_A,
          claimId,
          submissionId,
          `${submissionId}:1`,
          payerId,
          pcn,
          st02,
          st02,
          createHash("sha256").update(suffix).digest("hex"),
          `synthetic-${suffix}`,
        ],
      );

      const raw = buildRawEdi(parsed.interchangeControlNumber, parsed.transactionSetControlNumber);
      const rawKey = `manual/legacy-first-${suffix}.835`;
      const rawPayloads = new Map<string, string>();
      const outboxPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
      const outbox: WriteOutboxPort = {
        publish: (tx, emission) =>
          outboxPublisher.publish(tx as never, {
            ...emission,
            callerModule: "m25",
          }),
      };
      const claims = {
        async candidatesForLine() {
          return [
            {
              claimId,
              payerIcn: parsed.claims[0]!.payerIcn,
              claimControlNumber: pcn,
            },
          ];
        },
        async patientIdForClaim() {
          return null;
        },
      };
      const ingestService = buildDrizzleM25IngestService(handle.db, {
        client: fakeClient(new Map([[rawKey, parsed]])),
        rawStore: {
          async put(_org, adviceId, payload) {
            rawPayloads.set(adviceId, payload);
          },
          async get(_org, adviceId) {
            return rawPayloads.get(adviceId) ?? null;
          },
          async delete(_org, adviceId) {
            rawPayloads.delete(adviceId);
          },
        },
        payeeNpi: PAYEE_UNCHECKED,
        claims: { commercial: claims },
        outbox,
      });
      const legacyReceived = await ingestService.receiveAdvice(
        { organizationId: ORG_A },
        {
          providerEntityId: PE_A,
          payerId,
          payerKind: "commercial",
          minioObjectKey: rawKey,
          fileSha256: sha256Hex(raw),
          rawEdi: raw,
        },
      );
      expect(legacyReceived.outcome).toBe("queued");
      if (legacyReceived.outcome !== "queued")
        throw new Error("synthetic manual ERA was not queued");
      await expect(
        ingestService.postAdvice({ organizationId: ORG_A }, legacyReceived.adviceId),
      ).resolves.toMatchObject({ outcome: "posted" });

      // Owner-to-owner reconciliation consumes the persisted M25 line through M25's reader,
      // using this real M41 claim identity and the exact tenant/provider/payer scope.
      const commercialPaymentFacts = await buildDrizzleM25ReadService(
        handle.db,
      ).commercialClaimPaymentFacts(
        {
          organizationId: ORG_A,
          userId: crypto.randomUUID(),
          roles: [],
          providerEntityScope: [PE_A],
        },
        { claimId, providerEntityId: PE_A, payerId },
      );
      expect(commercialPaymentFacts).toMatchObject({
        payerReportedPaymentCents: "4200",
        m25PostedPaymentCents: "4200",
        historyRecordCount: 1,
        detailTruncated: false,
      });
      expect(commercialPaymentFacts.items).toEqual([
        expect.objectContaining({
          payerReportedPaymentCents: "4200",
          m25PostedPaymentCents: "4200",
          adviceStatus: "posted",
          lineMatchState: "posted",
        }),
      ]);

      const cipher = createClaimMdProtectedPayloadCipher(
        {
          activeId: "m25-legacy-first-test",
          byId: new Map([["m25-legacy-first-test", randomBytes(32)]]),
        },
        "claimmd-era-stage:v1",
      );
      const details = cipher
        .seal(
          sourceInboxId,
          createHash("sha256").update(`claimmd-legacy-first-${stageId}`).digest("hex"),
          JSON.stringify({
            transactionSet: parsed,
            claimOutcomes: [
              {
                claimId,
                pcn,
                outcome: "verified",
                billingModule: "M41",
                fileIndex: 0,
                transactionSetControlNumber: st02,
                submissionEvidenceIds: [historicalEvidenceId],
              },
            ],
          }),
        )
        .toString("base64");
      const originalDigest = createHash("sha256")
        .update(`legacy-first-original-${stageId}`)
        .digest("hex");
      const fileDigest = createHash("sha256").update(`legacy-first-file-${stageId}`).digest("hex");
      await admin.query(
        `INSERT INTO claimmd_era_m25_stage
          (id, organization_id, provider_entity_id, source_inbox_id, account_reference, usage,
           era_id, file_index, interchange_control_number, transaction_set_control_number,
           original_835_digest, source_file_digest, resolution_id, resolution_version,
           idempotency_key, source_evidence, protected_details_cipher, content_digest,
           payment_trace_digest, state)
         VALUES ($1,$2,$3,$4,'synthetic-legacy-account','test','9999',0,$5,$6,$7,$8,$9,1,
           $10,$11::jsonb,$12,$13,$14,'staged')`,
        [
          stageId,
          ORG_A,
          PE_A,
          sourceInboxId,
          parsed.interchangeControlNumber,
          st02,
          originalDigest,
          fileDigest,
          crypto.randomUUID(),
          createHash("sha256").update(`claimmd-legacy-first-${stageId}`).digest("hex"),
          JSON.stringify({
            evidenceCodes: ["EXACT_PAYEE_NPI", "SINGLE_PROVIDER_ARTIFACT"],
          }),
          details,
          m25ContentDigestOf(parsed),
          createHash("sha256").update(trace).digest("hex"),
        ],
      );
      const historicalReader = async (
        input: Parameters<typeof readClaimMdEraCandidateEvidence>[0],
      ) => {
        const evidenceRows = await readClaimMdEraCandidateEvidence(input);
        return readM41HistoricalEraCandidates({ ...input, evidenceRows });
      };
      const review = buildDrizzleClaimMdEraReviewService(
        handle.db,
        cipher,
        undefined,
        [historicalReader],
        {
          ingestService,
          enabled: true,
        },
      );
      const reviewer = {
        organizationId: ORG_A,
        userId: crypto.randomUUID(),
        roles: ["billing_specialist"],
        providerEntityScope: [PE_A],
        membershipId: crypto.randomUUID(),
        stepUpRecent: true,
      };
      await review.recordFinancialReviewDecision(reviewer, stageId, {
        itemType: "era",
        itemIndex: -1,
        disposition: "completed",
        expectedVersion: 0,
        reason: "Synthetic legacy-first source reviewed",
        idempotencyKey: `legacy-first-review-${stageId}`,
      });
      const postingPlan = await review.postingPlan(reviewer, stageId);
      expect(postingPlan.eligible).toBe(false);
      expect(postingPlan.blockers, JSON.stringify(postingPlan.claims)).toContain(
        "POTENTIAL_CROSS_SOURCE_DUPLICATE",
      );
      expect(postingPlan.claimId).toBe(claimId);
      const stageIdentity = await admin.query(
        "SELECT organization_id, provider_entity_id FROM claimmd_era_m25_stage WHERE id=$1",
        [stageId],
      );
      expect(stageIdentity.rows).toEqual([{ organization_id: ORG_A, provider_entity_id: PE_A }]);

      const adviceCount = await admin.query(
        `SELECT count(*)::int AS n FROM remittance_advice
         WHERE organization_id=$1 AND provider_entity_id=$2 AND payer_id=$3 AND check_or_eft_trace_number=$4`,
        [ORG_A, PE_A, payerId, trace],
      );
      expect(adviceCount.rows[0].n).toBe(1);
      const lineCount = await admin.query(
        `SELECT count(*)::int AS n FROM remittance_line rl
         JOIN remittance_advice ra ON ra.id=rl.remittance_advice_id
         WHERE ra.organization_id=$1 AND ra.provider_entity_id=$2 AND ra.payer_id=$3
           AND ra.check_or_eft_trace_number=$4`,
        [ORG_A, PE_A, payerId, trace],
      );
      expect(lineCount.rows[0].n).toBe(1);
      const paidEvents = await admin.query(
        `SELECT count(*)::int AS n FROM outbox_event
         WHERE organization_id=$1 AND event_type='m25.remittance.claim_paid'
           AND payload->>'remittanceAdviceId'=$2`,
        [ORG_A, legacyReceived.adviceId],
      );
      const postedEvents = await admin.query(
        `SELECT count(*)::int AS n FROM outbox_event
         WHERE organization_id=$1 AND event_type='m25.remittance.advice_posted'
           AND aggregate_id=$2`,
        [ORG_A, legacyReceived.adviceId],
      );
      expect(paidEvents.rows[0].n).toBe(1);
      expect(postedEvents.rows[0].n).toBe(1);
      const priorHistory = await review.postingHistory(reviewer, stageId);
      expect(priorHistory).toHaveLength(0);
      const persistedAdvice = await admin.query(
        "SELECT id, parse_status FROM remittance_advice WHERE id=$1",
        [legacyReceived.adviceId],
      );
      expect(persistedAdvice.rows[0]).toEqual({
        id: legacyReceived.adviceId,
        parse_status: "posted",
      });
    });

    it("matches a staged Medicare ERA through immutable M23 attempt evidence and blocks posting", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const stageId = crypto.randomUUID();
      const sourceInboxId = crypto.randomUUID();
      const pcn = `SYNTHETIC-M23-PCN-${suffix}`;
      const submissionId = crypto.randomUUID();
      const attemptKey = `${submissionId}:1`;
      const claimId = await seedClaim({
        organizationId: ORG_A,
        providerEntityId: PE_A,
        patientId: crypto.randomUUID(),
        claimControlNumber: pcn,
        serviceFrom: "2026-03-01",
        serviceTo: "2026-03-31",
      });
      const payerId = PAYER;
      await admin.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,$3,'Synthetic Hospice','1999999999',decode('00','hex'),'12-31')
         ON CONFLICT (id) DO NOTHING`,
        [PE_A, ORG_A, `SYN${suffix}`],
      );
      await admin.query(
        `INSERT INTO claim_submission
          (id,organization_id,provider_entity_id,kind,claim_id,claim_control_number,attempt_index,
           outcome,submitted_at)
         VALUES ($1,$2,$3,'claim_837i',$4,$5,1,'submitted',now())`,
        [submissionId, ORG_A, PE_A, claimId, pcn],
      );
      const attemptIdentity = createHash("sha256")
        .update(`synthetic-m23-attempt:${submissionId}`)
        .digest("hex");
      await admin.query(
        `INSERT INTO clearinghouse_submission_attempt
          (id,organization_id,provider_entity_id,scope,usage,idempotency_key,control_number,kind,
           identity,status,clearinghouse_submission_id,reserved_at,received_at)
         VALUES ($1,$2,$3,'claimmd:claim','test',$4,$5,'claim',$6,'sent',$7,now(),now())`,
        [
          crypto.randomUUID(),
          ORG_A,
          PE_A,
          `synthetic-m23-${submissionId}`,
          pcn,
          attemptIdentity,
          `synthetic-clearinghouse-${suffix}`,
        ],
      );
      const evidenceKey = randomBytes(32);
      const evidenceCipher = createClaimMdEvidenceCipher({
        async dekForOrg() {
          return { version: "synthetic-v1", key: evidenceKey };
        },
        async dekForOrgVersion() {
          return { version: "synthetic-v1", key: evidenceKey };
        },
      });
      const evidenceStore = createClaimMdSubmissionEvidenceStore({
        db: handle.db,
        cipher: evidenceCipher,
        accountReference: "synthetic-medicare-account",
        usage: "test",
      });
      const payloadSha256 = createHash("sha256")
        .update(`synthetic-original-837i:${submissionId}`)
        .digest("hex");
      const originalLineId = crypto.randomUUID();
      const evidenceId = await evidenceStore.reserve({
        organizationId: ORG_A,
        providerEntityId: PE_A,
        locationId: null,
        claimId,
        billingModule: "M23",
        submissionId,
        attemptKey,
        accountReference: "synthetic-medicare-account",
        usage: "test",
        x12Claim: {
          billingNpi: "1999999999",
          billingTin: "123456789",
          payerId,
          pcn,
          claimType: "81:1:1",
          serviceFrom: "20260301",
          serviceTo: "20260331",
          isa13: "000000981",
          gs06: "981",
          st02: "0981",
          serviceLines: [
            {
              position: 1,
              lineItemControlNumber: null,
              revenueCode: "0651",
              procedureCode: null,
              serviceFrom: "20260301",
              serviceTo: "20260331",
              units: "1",
              chargeCents: 4200,
            },
          ],
        },
        submittedLines: [
          {
            internalClaimLineId: originalLineId,
            revenueCode: "0651",
            procedureCode: null,
            serviceFrom: "20260301",
            serviceTo: "20260331",
            units: "1",
            chargeCents: 4200,
          },
        ],
        payloadSha256,
        outboundReference: `synthetic-outbound-${suffix}`,
        reservedAt: new Date("2026-03-01T12:00:00.000Z"),
      });
      // Deliberately diverge the current claim record after the immutable 837 snapshot was
      // captured. Candidate evidence must continue to report the amount actually submitted.
      await admin.query("UPDATE claim SET total_charge_cents=99999 WHERE id=$1", [claimId]);

      const transactionSetControlNumber = "00000981";
      const parsed: ParsedRemittanceAdvice = {
        // The M23 source-owner evidence establishes hospice identity; this parser classification
        // is context only and never authorizes Medicare posting.
        payerProgram: "medicare",
        payer: { name: "Synthetic Medicare MAC", id: payerId },
        payee: { name: "Synthetic Hospice", idQualifier: "XX", id: "1999999999" },
        interchangeControlNumber: "000000981",
        transactionSetControlNumber,
        checkOrEftTraceNumber: `SYNTHETIC-M23-TRACE-${suffix}`,
        paymentMethod: "eft",
        totalPaymentAmount: 42,
        productionDate: "2026-03-31",
        claims: [
          {
            patientControlNumber: pcn,
            payerIcn: `SYNTHETIC-MAC-ICN-${suffix}`,
            statusCode: 1,
            totalCharge: 42,
            totalPayment: 42,
            patientResponsibility: 0,
            serviceFrom: "2026-03-01",
            serviceTo: "2026-03-31",
            adjustments: [],
            remarks: [],
            serviceLines: [],
          },
        ],
      };
      const key = randomBytes(32);
      const cipher = createClaimMdProtectedPayloadCipher(
        {
          activeId: "m25-medicare-private-test",
          byId: new Map([["m25-medicare-private-test", key]]),
        },
        "claimmd-era-stage:v1",
      );
      const idempotencyKey = createHash("sha256").update(`m23-stage:${stageId}`).digest("hex");
      const protectedDetailsCipher = cipher
        .seal(
          sourceInboxId,
          idempotencyKey,
          JSON.stringify({
            transactionSet: parsed,
            claimOutcomes: [
              {
                claimId,
                pcn,
                outcome: "verified",
                billingModule: "M23",
                fileIndex: 0,
                transactionSetControlNumber,
                submissionEvidenceIds: [evidenceId],
              },
            ],
          }),
        )
        .toString("base64");
      const original835Digest = createHash("sha256")
        .update(`synthetic-original-835:${stageId}`)
        .digest("hex");
      const sourceFileDigest = createHash("sha256")
        .update(`synthetic-source-file:${stageId}`)
        .digest("hex");
      await admin.query(
        `INSERT INTO claimmd_era_m25_stage
          (id,organization_id,provider_entity_id,source_inbox_id,account_reference,usage,era_id,file_index,
           interchange_control_number,transaction_set_control_number,original_835_digest,source_file_digest,
           resolution_id,resolution_version,idempotency_key,source_evidence,protected_details_cipher,
           content_digest,payment_trace_digest,state)
         VALUES ($1,$2,$3,$4,'synthetic-medicare-account','test','9999',0,$5,$6,$7,$8,$9,1,
           $10,$11::jsonb,$12,$13,$14,'staged')`,
        [
          stageId,
          ORG_A,
          PE_A,
          sourceInboxId,
          parsed.interchangeControlNumber,
          transactionSetControlNumber,
          original835Digest,
          sourceFileDigest,
          crypto.randomUUID(),
          idempotencyKey,
          JSON.stringify({ evidenceCodes: ["EXACT_PAYEE_NPI", "SINGLE_PROVIDER_ARTIFACT"] }),
          protectedDetailsCipher,
          m25ContentDigestOf(parsed),
          createHash("sha256").update(parsed.checkOrEftTraceNumber!, "utf8").digest("hex"),
        ],
      );
      const historicalReader = async (
        input: Parameters<typeof readClaimMdEraCandidateEvidence>[0],
      ) => {
        const evidenceRows = await readClaimMdEraCandidateEvidence(input);
        const [medicare, commercial] = await Promise.all([
          readM23HistoricalEraCandidates(input),
          readM41HistoricalEraCandidates({ ...input, evidenceRows }),
        ]);
        return [...medicare, ...commercial];
      };
      const ingestService = buildDrizzleM25IngestService(handle.db, {
        client: fakeClient(new Map()),
        payeeNpi: PAYEE_UNCHECKED,
        claims: {
          commercial: {
            async candidatesForLine() {
              return [];
            },
            async patientIdForClaim() {
              return null;
            },
          },
        },
        outbox,
      });
      const review = buildDrizzleClaimMdEraReviewService(
        handle.db,
        cipher,
        undefined,
        [historicalReader],
        { ingestService, enabled: true },
      );
      const reviewer = {
        organizationId: ORG_A,
        userId: crypto.randomUUID(),
        roles: ["billing_specialist"],
        providerEntityScope: [PE_A],
        membershipId: crypto.randomUUID(),
        stepUpRecent: true,
      };
      const candidates = await review.candidates(reviewer, stageId, 0);
      expect(candidates).not.toBeNull();
      if (!candidates) throw new Error("expected scoped Medicare candidates");
      expect(candidates.candidates).toHaveLength(1);
      expect(candidates.candidates[0]).toMatchObject({
        module: "M23",
        claimId,
        evidenceId,
        submissionId,
        chargeCents: 4200,
        submittedLines: "available",
        selectable: true,
      });
      const readCandidatesForScope = async (scope: {
        organizationId: string;
        providerEntityId: string;
        accountReference: string;
        usage: "test" | "production";
        pcn: string;
      }) =>
        withOrgContext(handle.db, { organizationId: scope.organizationId, userId: "" }, (tx) =>
          readM23HistoricalEraCandidates({ tx, ...scope }),
        );
      const scopedInput = {
        organizationId: ORG_A,
        providerEntityId: PE_A,
        accountReference: "synthetic-medicare-account",
        usage: "test" as const,
        pcn,
      };
      expect(await readCandidatesForScope({ ...scopedInput, organizationId: ORG_B })).toEqual([]);
      expect(await readCandidatesForScope({ ...scopedInput, providerEntityId: PE_B })).toEqual([]);
      expect(
        await readCandidatesForScope({ ...scopedInput, accountReference: "other-account" }),
      ).toEqual([]);
      expect(await readCandidatesForScope({ ...scopedInput, usage: "production" })).toEqual([]);
      expect(await readCandidatesForScope({ ...scopedInput, pcn: `${pcn}-other` })).toEqual([]);
      const matching = await review.matching(reviewer, stageId);
      expect(matching).not.toBeNull();
      if (!matching) throw new Error("expected scoped Medicare matching result");
      expect(matching.claims[0]).toMatchObject({
        outcome: "verified",
        linkedClaimId: claimId,
        linkedModule: "M23",
      });
      await review.recordFinancialReviewDecision(reviewer, stageId, {
        itemType: "era",
        itemIndex: -1,
        disposition: "completed",
        expectedVersion: 0,
        reason: "Synthetic Medicare ERA reviewed; posting remains unavailable",
        idempotencyKey: `m23-review-${stageId}`,
      });
      const plan = await review.postingPlan(reviewer, stageId);
      expect(plan.eligible).toBe(false);
      expect(plan.claims[0]).toMatchObject({
        billingModule: "M23",
        claimId,
        matching: "verified",
        blockers: expect.arrayContaining(["MEDICARE_POSTING_NOT_CERTIFIED"]),
      });
      expect(plan.blockers).toContain("CLAIM_NOT_ELIGIBLE");
      expect(plan.claims[0]?.blockers).not.toContain("UNSUPPORTED_OR_INCOMPLETE_835");
      await expect(
        review.approvePostingPlan(reviewer, stageId, {
          planId: plan.planId,
          planDigest: plan.planDigest,
          reason: "Synthetic Medicare approval must remain blocked",
          idempotencyKey: `m23-approval-${stageId}`,
        }),
      ).rejects.toMatchObject({ code: "POSTING_PLAN_STALE_OR_BLOCKED", statusCode: 409 });
      // Exercise the execution boundary independently from the normal approval API. The
      // synthetic event models a corrupted/legacy approval reference; it is inserted only by
      // the disposable test's admin connection. Execution must re-derive the owner module and
      // refuse Medicare even when the capability is enabled in this isolated fixture.
      const forgedApprovalKey = createHash("sha256")
        .update(`synthetic-forged-m23-approval-${stageId}`)
        .digest("hex");
      await admin.query(
        `INSERT INTO claimmd_era_posting_event
          (organization_id,provider_entity_id,stage_id,plan_id,event_type,plan_digest,
           actor_membership_id,idempotency_key_hash,reason)
         VALUES ($1,$2,$3,$4,'approved',$5,$6,$7,'Synthetic forged approval for boundary test')`,
        [
          ORG_A,
          PE_A,
          stageId,
          plan.planId,
          plan.planDigest,
          crypto.randomUUID(),
          forgedApprovalKey,
        ],
      );
      await expect(
        review.executePostingPlan(reviewer, stageId, {
          planId: plan.planId,
          planDigest: plan.planDigest,
          reason: "Synthetic Medicare execution must remain blocked",
          idempotencyKey: `m23-execution-${stageId}`,
        }),
      ).rejects.toMatchObject({ code: "POSTING_PLAN_STALE_OR_BLOCKED", statusCode: 409 });
      const sideEffects = await admin.query(
        `SELECT
           (SELECT count(*)::int FROM remittance_advice WHERE parse_summary->>'stageId'=$1) AS advice_count,
           (SELECT count(*)::int FROM remittance_line rl JOIN remittance_advice ra ON ra.id=rl.remittance_advice_id WHERE ra.parse_summary->>'stageId'=$1) AS line_count,
           (SELECT count(*)::int FROM outbox_event WHERE organization_id=$2 AND event_type IN ('m25.remittance.claim_paid','m25.remittance.claim_partial_paid','m25.remittance.advice_posted') AND payload->>'stageId'=$1) AS posting_event_count`,
        [stageId, ORG_A],
      );
      expect(sideEffects.rows[0]).toEqual({
        advice_count: 0,
        line_count: 0,
        posting_event_count: 0,
      });
    });
  });

  it("holds an 835 with no trace instead of allowing an unverifiable financial identity to post", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const key = "minio/missing-trace.835";
    const raw = buildRawEdi("000000992", "0992");
    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: "000000992",
      transactionSetControlNumber: "0992",
      paymentMethod: "eft",
      totalPaymentAmount: 12,
      productionDate: "2026-03-01",
      claims: [
        {
          patientControlNumber: "SYNTHETIC-PCN-992",
          payerIcn: "SYNTHETIC-ICN-992",
          statusCode: 1,
          totalCharge: 12,
          totalPayment: 12,
          patientResponsibility: 0,
          adjustments: [],
          remarks: [],
          serviceLines: [],
        },
      ],
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      client: fakeClient(new Map([[key, parsed]])),
      payeeNpi: PAYEE_UNCHECKED,
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: key,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });
    if (received.outcome !== "queued") throw new Error("unreachable");
    await expect(service.postAdvice(actor, received.adviceId)).resolves.toMatchObject({
      outcome: "held_duplicate",
      reason: "MISSING_FINANCIAL_IDENTITY",
    });
    expect(await lineCount(received.adviceId)).toBe(0);
    const advice = await admin.query(
      "SELECT parse_status, parse_summary FROM remittance_advice WHERE id=$1",
      [received.adviceId],
    );
    expect(advice.rows[0]).toMatchObject({
      parse_status: "held_duplicate",
      parse_summary: { reason: "MISSING_FINANCIAL_IDENTITY" },
    });
  });

  it("serializes exact identities arriving through independent intake records and holds the losing source", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const keyA = "minio/source-a.835";
    const keyB = "manual/source-b.835";
    const rawA = buildRawEdi("000000993", "0993");
    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: "000000993",
      transactionSetControlNumber: "0993",
      checkOrEftTraceNumber: "SYNTHETIC-TRACE-993",
      paymentMethod: "eft",
      totalPaymentAmount: 17,
      productionDate: "2026-03-02",
      claims: [
        {
          patientControlNumber: "SYNTHETIC-PCN-993",
          payerIcn: "SYNTHETIC-ICN-993",
          statusCode: 1,
          totalCharge: 17,
          totalPayment: 17,
          patientResponsibility: 0,
          adjustments: [],
          remarks: [],
          serviceLines: [],
        },
      ],
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      client: fakeClient(
        new Map([
          [keyA, parsed],
          [keyB, parsed],
        ]),
      ),
      payeeNpi: PAYEE_UNCHECKED,
    });
    const first = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: keyA,
      fileSha256: sha256Hex(rawA),
      rawEdi: rawA,
    });
    if (first.outcome !== "queued") throw new Error("unreachable");
    // Model an independently accepted legacy/manual source record with a new envelope identity.
    // The service under test still performs both consequential posting transactions.
    const secondId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO remittance_advice (id,organization_id,provider_entity_id,payer_id,payer_kind,
      interchange_control_number,transaction_set_control_number,check_or_eft_trace_number,payment_method,total_payment_amount,
      content_digest,production_date,minio_object_key,file_sha256,parse_status)
      SELECT $1,organization_id,provider_entity_id,payer_id,payer_kind,'000000994','0994',check_or_eft_trace_number,
      payment_method,total_payment_amount,content_digest,production_date,$2,$3,'queued'
      FROM remittance_advice WHERE id=$4`,
      [secondId, keyB, sha256Hex(buildRawEdi("000000994", "0994")), first.adviceId],
    );
    const results = await Promise.all([
      service.postAdvice(actor, first.adviceId),
      service.postAdvice(actor, secondId),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "held_duplicate",
      "partial_posted",
    ]);
    expect((await lineCount(first.adviceId)) + (await lineCount(secondId))).toBe(1);
    const statuses = await admin.query(
      "SELECT parse_status FROM remittance_advice WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[first.adviceId, secondId]],
    );
    expect(statuses.rows.map((row) => row.parse_status).sort()).toEqual([
      "held_duplicate",
      "partial_posted",
    ]);
  });

  it("happy path: a multi-claim 835 posts every matched line + seeds denials/PR-ledger, and stays 'posted'", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const objectKey = "minio/happy-path.835";
    const isa = "000000101";
    const st = "0101";

    const claimPaid = {
      patientControlNumber: "PCN-1",
      payerIcn: "ICN-PAID",
      statusCode: 1,
      totalCharge: 500,
      totalPayment: 500,
      patientResponsibility: 0,
      adjustments: [{ groupCode: "CO" as const, reasonCode: "45", amount: 0 }],
      remarks: [],
      serviceLines: [
        {
          procedureCode: "T1005",
          chargeAmount: 500,
          paidAmount: 500,
          adjustments: [],
          remarks: [
            {
              kind: "LQ" as const,
              code: "N123",
              text: "informational remark",
            },
          ],
        },
      ],
    };
    const claimDeniedMapped = {
      patientControlNumber: "PCN-2",
      payerIcn: "ICN-DENIED",
      statusCode: 1,
      totalCharge: 200,
      totalPayment: 0,
      patientResponsibility: 0,
      adjustments: [{ groupCode: "PI" as const, reasonCode: "50", amount: 200 }],
      remarks: [],
      serviceLines: [],
    };
    const claimPrResolved = {
      patientControlNumber: "PCN-3",
      payerIcn: "ICN-PR-OK",
      statusCode: 1,
      totalCharge: 300,
      totalPayment: 250,
      patientResponsibility: 50,
      adjustments: [{ groupCode: "PR" as const, reasonCode: "1", amount: 50 }],
      remarks: [],
      serviceLines: [],
    };
    const claimPrUnresolved = {
      patientControlNumber: "PCN-4",
      payerIcn: "ICN-PR-NOPATIENT",
      statusCode: 1,
      totalCharge: 300,
      totalPayment: 250,
      patientResponsibility: 50,
      adjustments: [{ groupCode: "PR" as const, reasonCode: "1", amount: 50 }],
      remarks: [],
      serviceLines: [],
    };
    const claimUnmapped = {
      patientControlNumber: "PCN-5",
      payerIcn: "ICN-UNMAPPED",
      statusCode: 1,
      totalCharge: 100,
      totalPayment: 0,
      patientResponsibility: 0,
      adjustments: [{ groupCode: "OA" as const, reasonCode: "999", amount: 100 }],
      remarks: [],
      serviceLines: [],
    };
    const claimUnmatched = {
      patientControlNumber: "PCN-6",
      payerIcn: "ICN-NO-CANDIDATE",
      statusCode: 1,
      totalCharge: 400,
      totalPayment: 400,
      patientResponsibility: 0,
      adjustments: [],
      remarks: [],
      serviceLines: [],
    };

    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      checkOrEftTraceNumber: "TRN-1",
      paymentMethod: "eft",
      totalPaymentAmount: 500 + 0 + 250 + 250 + 0 + 400,
      productionDate: "2026-02-01",
      claims: [
        claimPaid,
        claimDeniedMapped,
        claimPrResolved,
        claimPrUnresolved,
        claimUnmapped,
        claimUnmatched,
      ],
    };

    const client = fakeClient(new Map([[objectKey, parsed]]));
    const terminology = fakeTerminology({
      "45": { category: "informational", plainLanguage: "contractual" },
      "50": { category: "denial", plainLanguage: "not medically necessary" },
      // routeAdjustment checks taxonomyStatus BEFORE group code (D13: unmapped always wins), so the PR
      // group's CARC must resolve to a NON-denial category here or it would route to denial_seeded
      // instead of ledger_recorded regardless of the CAS group being PR.
      "1": {
        category: "informational",
        plainLanguage: "patient responsibility",
      },
      // "999" (unmapped) deliberately absent
    });
    const claims = fakeClaims(
      {
        "ICN-PAID": [{ claimId: CLAIM_PAID, payerIcn: "ICN-PAID" }],
        "ICN-DENIED": [{ claimId: CLAIM_DENIED, payerIcn: "ICN-DENIED" }],
        "ICN-PR-OK": [{ claimId: CLAIM_PR_OK, payerIcn: "ICN-PR-OK" }],
        "ICN-PR-NOPATIENT": [{ claimId: CLAIM_PR_NOPATIENT, payerIcn: "ICN-PR-NOPATIENT" }],
        "ICN-UNMAPPED": [{ claimId: CLAIM_UNMAPPED, payerIcn: "ICN-UNMAPPED" }],
      },
      { [CLAIM_PR_OK]: PATIENT_1 }, // CLAIM_PR_NOPATIENT deliberately unresolvable
    );
    const emissions: string[] = [];
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client,
      terminology,
      claims: { medicare: claims },
      outbox: {
        async publish(_tx, emission) {
          emissions.push(emission.eventName);
        },
      },
    });

    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(buildRawEdi(isa, st)),
      rawEdi: buildRawEdi(isa, st),
    });
    expect(received.outcome).toBe("queued");
    if (received.outcome !== "queued") throw new Error("unreachable");
    const adviceId = received.adviceId;
    expect(emissions).toContain("m25.edi.835_received");

    const posted = await service.postAdvice(actor, adviceId);
    expect(posted.outcome).toBe("partial_posted"); // ICN-NO-CANDIDATE stays unmatched
    if (posted.outcome !== "posted" && posted.outcome !== "partial_posted") {
      throw new Error(`unreachable: ${posted.outcome}`);
    }
    expect(posted.postedLineCount).toBe(5);
    expect(posted.unmatchedLineCount).toBe(1);

    // paid, fully matched, auto_posted CO adjustment
    const paidRow = await admin.query(
      "SELECT match_state, claim_id, clp04_total_payment_amount FROM remittance_line WHERE remittance_advice_id=$1 AND clp01_patient_control_number='PCN-1'",
      [adviceId],
    );
    expect(paidRow.rows[0].match_state).toBe("posted");
    expect(paidRow.rows[0].claim_id).toBe(CLAIM_PAID);
    const paidAdj = await admin.query(
      "SELECT post_action FROM remittance_adjustment adj JOIN remittance_line rl ON adj.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1 AND rl.clp01_patient_control_number='PCN-1'",
      [adviceId],
    );
    expect(paidAdj.rows[0].post_action).toBe("auto_posted");

    // denied, mapped denial category → denial_case seeded
    const deniedDenial = await admin.query(
      "SELECT carc_code, category, taxonomy_status FROM denial_case dc JOIN remittance_line rl ON dc.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1 AND rl.clp01_patient_control_number='PCN-2'",
      [adviceId],
    );
    expect(deniedDenial.rows).toHaveLength(1);
    expect(deniedDenial.rows[0].carc_code).toBe("50");
    expect(deniedDenial.rows[0].category).toBe("denial");
    expect(deniedDenial.rows[0].taxonomy_status).toBe("mapped");

    // PR group, resolvable patient → real ledger row
    const prLedger = await admin.query(
      "SELECT pr_amount, patient_id FROM patient_responsibility_ledger pl JOIN remittance_line rl ON pl.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1 AND rl.clp01_patient_control_number='PCN-3'",
      [adviceId],
    );
    expect(prLedger.rows).toHaveLength(1);
    expect(prLedger.rows[0].patient_id).toBe(PATIENT_1);
    expect(Number(prLedger.rows[0].pr_amount)).toBe(50);

    // PR group, UNRESOLVABLE patient id → honest degrade to flagged_review, NO ledger row fabricated
    const prUnresolvedLedger = await admin.query(
      "SELECT count(*)::int AS n FROM patient_responsibility_ledger pl JOIN remittance_line rl ON pl.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1 AND rl.clp01_patient_control_number='PCN-4'",
      [adviceId],
    );
    expect(prUnresolvedLedger.rows[0].n).toBe(0);
    const prUnresolvedAdj = await admin.query(
      "SELECT post_action FROM remittance_adjustment adj JOIN remittance_line rl ON adj.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1 AND rl.clp01_patient_control_number='PCN-4'",
      [adviceId],
    );
    expect(prUnresolvedAdj.rows[0].post_action).toBe("flagged_review");

    // unmapped CARC → denial seeded with taxonomy_status='unmapped'
    const unmappedDenial = await admin.query(
      "SELECT taxonomy_status FROM denial_case dc JOIN remittance_line rl ON dc.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1 AND rl.clp01_patient_control_number='PCN-5'",
      [adviceId],
    );
    expect(unmappedDenial.rows[0].taxonomy_status).toBe("unmapped");

    // no candidate → stays unmatched, no claim_id, no M23 forwarding event for this line
    const unmatchedRow = await admin.query(
      "SELECT match_state, claim_id FROM remittance_line WHERE remittance_advice_id=$1 AND clp01_patient_control_number='PCN-6'",
      [adviceId],
    );
    expect(unmatchedRow.rows[0].match_state).toBe("unmatched");
    expect(unmatchedRow.rows[0].claim_id).toBeNull();

    expect(emissions).toContain("m25.remittance.claim_paid");
    expect(emissions).toContain("m25.denial.opened");
    expect(emissions).toContain("m25.taxonomy.unmapped_code_observed");
    expect(emissions).toContain("m25.patient_responsibility.recorded");
    expect(emissions).toContain("m25.remittance.advice_posted");
    // Both PCN-2 (mapped denial) and PCN-5 (unmapped) are bound + zero-payment → classify 'denied' too.
    expect(emissions.filter((e) => e === "m25.remittance.claim_denied")).toHaveLength(2);
    expect(emissions.filter((e) => e === "m25.denial.opened")).toHaveLength(2);

    const adviceRow = await admin.query(
      "SELECT parse_status, parse_summary FROM remittance_advice WHERE id=$1",
      [adviceId],
    );
    expect(adviceRow.rows[0].parse_status).toBe("partial_posted");
    expect(adviceRow.rows[0].parse_summary.postedLineCount).toBe(5);
    expect(adviceRow.rows[0].parse_summary.unmatchedLineCount).toBe(1);
  });

  it("a fully-matched envelope with a CLP02=22 reversal posts as 'posted' and matchState='reversed'", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const objectKey = "minio/recoupment.835";
    const isa = "000000102";
    const st = "0102";
    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      paymentMethod: "eft",
      checkOrEftTraceNumber: "SYNTHETIC-REVERSAL-TRACE-102",
      totalPaymentAmount: 100,
      productionDate: "2026-02-02",
      claims: [
        {
          patientControlNumber: "PCN-R1",
          payerIcn: "ICN-RECOUP",
          statusCode: 22,
          totalCharge: 100,
          totalPayment: 100,
          patientResponsibility: 0,
          adjustments: [],
          remarks: [],
          serviceLines: [],
        },
      ],
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([[objectKey, parsed]])),
      claims: {
        medicare: fakeClaims(
          {
            "ICN-RECOUP": [{ claimId: CLAIM_RECOUP, payerIcn: "ICN-RECOUP" }],
          },
          {},
        ),
      },
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(buildRawEdi(isa, st)),
      rawEdi: buildRawEdi(isa, st),
    });
    if (received.outcome !== "queued") throw new Error("unreachable");
    const posted = await service.postAdvice(actor, received.adviceId);
    expect(posted.outcome).toBe("posted");
    const row = await admin.query(
      "SELECT match_state FROM remittance_line WHERE remittance_advice_id=$1",
      [received.adviceId],
    );
    expect(row.rows[0].match_state).toBe("reversed");
  });

  it("a duplicate ISA/ST for the SAME provider entity is rejected — no second row, no re-post", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const objectKey = "minio/dup.835";
    const isa = "000000201";
    const st = "0201";
    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      paymentMethod: "check",
      totalPaymentAmount: 10,
      productionDate: "2026-02-03",
      claims: [],
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([[objectKey, parsed]])),
    });
    const input: ReceiveAdviceInput = {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(buildRawEdi(isa, st)),
      rawEdi: buildRawEdi(isa, st),
    };
    const first = await service.receiveAdvice(actor, input);
    expect(first.outcome).toBe("queued");
    const second = await service.receiveAdvice(actor, input);
    expect(second.outcome).toBe("duplicate");
    if (second.outcome !== "duplicate" || first.outcome !== "queued")
      throw new Error("unreachable");
    expect(second.existingAdviceId).toBe(first.adviceId);
    const count = await admin.query(
      "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number=$1 AND transaction_set_control_number=$2 AND provider_entity_id=$3",
      [isa, st, PE_A],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("a malformed (non-X12) file persists NOTHING — no advice row, no dedup key consumed", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map()),
    });
    const before = await admin.query(
      "SELECT count(*)::int AS n FROM remittance_advice WHERE organization_id=$1",
      [ORG_A],
    );
    const result = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: "minio/garbage.835",
      fileSha256: sha256Hex("this is not an X12 document at all, no ISA segment here"),
      rawEdi: "this is not an X12 document at all, no ISA segment here",
    });
    expect(result.outcome).toBe("malformed");
    const after = await admin.query(
      "SELECT count(*)::int AS n FROM remittance_advice WHERE organization_id=$1",
      [ORG_A],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("a mid-batch posting failure ROLLS BACK the entire batch — zero line residue, advice marked failed", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const objectKey = "minio/rollback.835";
    const isa = "000000301";
    const st = "0301";
    const okClaim = {
      patientControlNumber: "PCN-OK",
      payerIcn: "ICN-OK",
      statusCode: 1,
      totalCharge: 100,
      totalPayment: 100,
      patientResponsibility: 0,
      adjustments: [],
      remarks: [],
      serviceLines: [],
    };
    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      paymentMethod: "check",
      checkOrEftTraceNumber: "SYNTHETIC-ROLLBACK-TRACE-301",
      totalPaymentAmount: 200,
      productionDate: "2026-02-04",
      claims: [
        okClaim,
        {
          ...okClaim,
          patientControlNumber: "PCN-OK-2",
          payerIcn: "ICN-OK-2",
        },
      ],
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([[objectKey, parsed]])),
      claims: { medicare: throwingOnNthClaims(2) }, // first claim's candidate lookup succeeds, second throws
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(buildRawEdi(isa, st)),
      rawEdi: buildRawEdi(isa, st),
    });
    if (received.outcome !== "queued") throw new Error("unreachable");
    const posted = await service.postAdvice(actor, received.adviceId);
    expect(posted.outcome).toBe("failed");
    // The FIRST claim would have succeeded in isolation — proving it's gone too proves real atomicity.
    expect(await lineCount(received.adviceId)).toBe(0);
    const row = await admin.query(
      "SELECT parse_status, parse_summary FROM remittance_advice WHERE id=$1",
      [received.adviceId],
    );
    expect(row.rows[0].parse_status).toBe("failed");
    expect(row.rows[0].parse_summary.reason).toContain("forced mid-batch failure");
  });

  it("a degraded sidecar parse at receive time is malformed; at post time it fails the advice", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const objectKey = "minio/degraded-at-post.835";
    const isa = "000000401";
    const st = "0401";
    // receiveAdvice needs a SUCCESSFUL parse to get envelope fields — simulate the sidecar going down
    // AFTER receive by swapping in a second service instance backed by a client that now degrades.
    const okParsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      paymentMethod: "check",
      checkOrEftTraceNumber: "SYNTHETIC-REPLAY-TRACE-401",
      totalPaymentAmount: 5,
      productionDate: "2026-02-05",
      claims: [],
    };
    const receiveService = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([[objectKey, okParsed]])),
    });
    const received = await receiveService.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(buildRawEdi(isa, st)),
      rawEdi: buildRawEdi(isa, st),
    });
    if (received.outcome !== "queued") throw new Error("unreachable");

    const postService = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([[objectKey, "degraded"]])),
    });
    const posted = await postService.postAdvice(actor, received.adviceId);
    expect(posted.outcome).toBe("failed");
    const row = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
      received.adviceId,
    ]);
    expect(row.rows[0].parse_status).toBe("failed");

    // Operator-actionable: a THIRD call (simulating `remittance.replay`'s re-emit → dispatcher redelivery)
    // against a NOW-healthy client succeeds — proves the failed row is genuinely replayable, not stuck.
    const replayService = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([[objectKey, okParsed]])),
    });
    const replayed = await replayService.postAdvice(actor, received.adviceId);
    expect(replayed.outcome).toBe("posted");
  });

  it("RAW 835 text flows receive -> post through the in-process TypeScript parser (no sidecar configured)", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const objectKey = "minio/raw-ts-parser.835";
    const raw = buildFullEdi("000000202", "0202", "500.00");
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      // Real client: NO port, NO sidecar. `postAdvice` re-reads the staged object through `readRaw`.
      client: createX12835Client({
        readRaw: async (key) => (key === objectKey ? raw : ""),
      }),
      terminology: fakeTerminology({}),
      claims: {
        medicare: fakeClaims({ "ICN-PAID": [{ claimId: CLAIM_PAID, payerIcn: "ICN-PAID" }] }, {}),
      },
      outbox: { async publish() {} },
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });
    expect(received.outcome).toBe("queued");
    if (received.outcome !== "queued") throw new Error("unreachable");
    const posted = await service.postAdvice(actor, received.adviceId);
    expect(posted.outcome).toBe("posted");
    const row = await admin.query(
      "SELECT clp04_total_payment_amount::text AS paid, match_state FROM remittance_line WHERE remittance_advice_id=$1",
      [received.adviceId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].paid).toBe("500.00");
    expect(row.rows[0].match_state).toBe("posted");

    // An 835 whose BPR02 does not foot fails closed at receive: nothing persisted.
    const bad = buildFullEdi("000000203", "0203", "499.99");
    const rejected = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: "minio/unbalanced.835",
      fileSha256: sha256Hex(bad),
      rawEdi: bad,
    });
    expect(rejected.outcome).toBe("malformed");
    const none = await admin.query(
      "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number='000000203'",
    );
    expect(none.rows[0].n).toBe(0);
  });

  it("#658: receive stages the raw 835 in the store and post reads it back (no readRaw on the client)", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const objectKey = "minio/staged-by-receive.835";
    const raw = buildFullEdi("000000204", "0204", "500.00");
    const objects = new Map<string, string>();
    const rawStore = {
      async put(org: string, adviceId: string, text: string) {
        objects.set(`${org}/${adviceId}`, text);
      },
      async get(org: string, adviceId: string) {
        return objects.get(`${org}/${adviceId}`) ?? null;
      },
      async delete(org: string, adviceId: string) {
        objects.delete(`${org}/${adviceId}`);
      },
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: createX12835Client(), // no readRaw: the service reads through rawStore
      rawStore,
      terminology: fakeTerminology({}),
      claims: {
        medicare: fakeClaims({ "ICN-PAID": [{ claimId: CLAIM_PAID, payerIcn: "ICN-PAID" }] }, {}),
      },
      outbox: { async publish() {} },
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });
    if (received.outcome !== "queued") throw new Error("unreachable");
    // Keyed by the server-generated advice id, not the caller's key: a second advice naming the same
    // minioObjectKey cannot overwrite this one's staged text.
    expect(objects.get(`${ORG_A}/${received.adviceId}`)).toBe(raw);
    expect(objects.has(`${ORG_A}/${objectKey}`)).toBe(false);
    expect((await service.postAdvice(actor, received.adviceId)).outcome).toBe("posted");
    // #669: the staged PHI is removed once the post committed.
    expect(objects.has(`${ORG_A}/${received.adviceId}`)).toBe(false);
  });

  it("#668: a fileSha256 that does not describe the submitted text is refused with nothing persisted", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const raw = buildFullEdi("000000206", "0206", "500.00");
    const staged: string[] = [];
    const service = buildDrizzleM25IngestService(handle.db, {
      client: createX12835Client(),
      payeeNpi: PAYEE_UNCHECKED,
      rawStore: {
        async put(_o: string, id: string) {
          staged.push(id);
        },
        async get() {
          return null;
        },
        async delete() {},
      },
      outbox: { async publish() {} },
    });
    const result = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: "minio/wrong-hash.835",
      fileSha256: "0".repeat(64),
      rawEdi: raw,
    });
    expect(result).toMatchObject({ outcome: "malformed" });
    expect(staged).toEqual([]);
    const none = await admin.query(
      "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number='000000206'",
    );
    expect(none.rows[0].n).toBe(0);
    // An upper-case hex digest of the same text is the same hash.
    const ok = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: "minio/right-hash.835",
      fileSha256: sha256Hex(raw).toUpperCase(),
      rawEdi: raw,
    });
    expect(ok.outcome).toBe("queued");
  });

  it("#669: a delete failure never un-posts the advice (hook fires); a failed post keeps the staged text for replay", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const events: unknown[] = [];
    const deleted: string[] = [];
    let failDelete = true;
    const objects = new Map<string, string>();
    const mk = (claims: Record<string, unknown>) =>
      buildDrizzleM25IngestService(handle.db, {
        client: createX12835Client(),
        payeeNpi: PAYEE_UNCHECKED,
        rawStore: {
          async put(_o: string, id: string, text: string) {
            objects.set(id, text);
          },
          async get(_o: string, id: string) {
            return objects.get(id) ?? null;
          },
          async delete(_o: string, id: string) {
            if (failDelete) throw new Error("bucket down");
            deleted.push(id);
          },
        },
        onStagedDeleteFailed: (e) => events.push(e),
        terminology: fakeTerminology({}),
        claims: {
          medicare: fakeClaims(claims as never, {}),
        },
        outbox: { async publish() {} },
      });
    const raw = buildFullEdi("000000207", "0207", "500.00");
    const service = mk({
      "ICN-PAID": [{ claimId: CLAIM_PAID, payerIcn: "ICN-PAID" }],
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: "minio/delete-fails.835",
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });
    if (received.outcome !== "queued") throw new Error("unreachable");
    const posted = await service.postAdvice(actor, received.adviceId);
    expect(posted.outcome).toBe("posted");
    expect(events).toEqual([
      {
        organizationId: ORG_A,
        adviceId: received.adviceId,
        errorName: "Error",
      },
    ]);
    expect(objects.has(received.adviceId)).toBe(true); // left behind for the lifecycle rule
    // A redelivery of the same event retries the delete that failed.
    failDelete = false;
    expect((await service.postAdvice(actor, received.adviceId)).outcome).toBe("already_posted");
    expect(deleted).toEqual([received.adviceId]);
  });

  it("#658: a failed stage rolls the receive back (nothing queued); a missing object stays retryable", async () => {
    const actor: M25IngestActor = { organizationId: ORG_A };
    const raw = buildFullEdi("000000205", "0205", "500.00");
    const input = (key: string): ReceiveAdviceInput => ({
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: key,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });
    const broken = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: createX12835Client(),
      rawStore: {
        async put() {
          throw new Error("store down");
        },
        async get() {
          return null;
        },
        async delete() {},
      },
      outbox: { async publish() {} },
    });
    await expect(broken.receiveAdvice(actor, input("minio/never.835"))).rejects.toThrow(
      /store down/,
    );
    const none = await admin.query(
      "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number='000000205'",
    );
    expect(none.rows[0].n).toBe(0);

    const empty = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: createX12835Client(),
      rawStore: {
        async put() {},
        async get() {
          return null;
        },
        async delete() {},
      },
      outbox: { async publish() {} },
    });
    const received = await empty.receiveAdvice(actor, input("minio/vanished.835"));
    if (received.outcome !== "queued") throw new Error("unreachable");
    const posted = await empty.postAdvice(actor, received.adviceId);
    expect(posted.outcome).toBe("failed");
  });

  describe("several ST/SE sets in one file, and the payee identity check (#660, #659)", () => {
    const TENANT_NPI = "1234567893";

    /** One ISA/GS holding one balanced 500.00 set per entry; each set names its own ICN and payee NPI. */
    function buildEdiSets(
      isa13: string,
      sets: readonly { st02: string; icn: string; npi: string }[],
    ): string {
      const body = (icn: string, npi: string): string[] => [
        "BPR*I*500.00*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615",
        `TRN*1*EFT-${icn}*1512345678`,
        "N1*PR*SYNTHETIC MAC",
        `N1*PE*SYNTH HOSPICE*XX*${npi}`,
        `CLP*PCN-${icn}*1*500.00*500.00*0.00*MC*${icn}`,
        "SVC*HC:T1005*500.00*500.00",
      ];
      const [first, ...rest] = sets;
      if (!first) throw new Error("need a set");
      const seg = (st02: string, b: string[]) =>
        `${b.map((x) => `${x}~`).join("")}SE*${b.length + 2}*${st02}~`;
      const head = buildRawEdi(isa13, first.st02) + seg(first.st02, body(first.icn, first.npi));
      const more = rest.map((x) => `ST*835*${x.st02}~${seg(x.st02, body(x.icn, x.npi))}`).join("");
      return `${head}${more}GE*${sets.length}*1~IEA*1*${isa13.padStart(9, "0")}~`;
    }

    const input = (key: string, raw: string): ReceiveAdviceInput => ({
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: key,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });

    it("queues one advice per set, posts each from its own set, and dedups the redelivered file", async () => {
      const actor: M25IngestActor = { organizationId: ORG_A };
      const key = "minio/two-sets.835";
      const raw = buildEdiSets("000000701", [
        { st02: "0701", icn: "ICN-S1", npi: TENANT_NPI },
        { st02: "0702", icn: "ICN-S2", npi: TENANT_NPI },
      ]);
      const emissions: string[] = [];
      const service = buildDrizzleM25IngestService(handle.db, {
        client: createX12835Client({ readRaw: async () => raw }),
        terminology: fakeTerminology({}),
        claims: {
          medicare: fakeClaims(
            {
              "ICN-S1": [{ claimId: CLAIM_PAID, payerIcn: "ICN-S1" }],
              "ICN-S2": [{ claimId: CLAIM_DENIED, payerIcn: "ICN-S2" }],
            },
            {},
          ),
        },
        payeeNpi: async () => TENANT_NPI,
        outbox: {
          async publish(_tx, e) {
            emissions.push(e.eventName);
          },
        },
      });
      const received = await service.receiveAdvice(actor, input(key, raw));
      expect(received.outcome).toBe("queued");
      expect(emissions.filter((e) => e === "m25.edi.835_received")).toHaveLength(2);
      const rows = await admin.query(
        "SELECT id, transaction_set_control_number AS st FROM remittance_advice WHERE interchange_control_number='000000701' ORDER BY 2",
      );
      expect(rows.rows.map((r) => r.st)).toEqual(["0701", "0702"]);

      for (const [i, r] of rows.rows.entries()) {
        const posted = await service.postAdvice(actor, r.id);
        expect(posted.outcome).toBe("posted");
        const line = await admin.query(
          "SELECT clp07_payer_icn FROM remittance_line WHERE remittance_advice_id=$1",
          [r.id],
        );
        expect(line.rows.map((x) => x.clp07_payer_icn)).toEqual([i === 0 ? "ICN-S1" : "ICN-S2"]);
      }

      const again = await service.receiveAdvice(actor, input(key, raw));
      expect(again.outcome).toBe("duplicate");
      const count = await admin.query(
        "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number='000000701'",
      );
      expect(count.rows[0].n).toBe(2);
    });

    it("refuses the whole file, storing nothing, when one set is addressed to another provider", async () => {
      const actor: M25IngestActor = { organizationId: ORG_A };
      const raw = buildEdiSets("000000702", [
        { st02: "0711", icn: "ICN-M1", npi: TENANT_NPI },
        { st02: "0712", icn: "ICN-M2", npi: "1999999984" },
      ]);
      const service = buildDrizzleM25IngestService(handle.db, {
        client: createX12835Client({ readRaw: async () => raw }),
        payeeNpi: async () => TENANT_NPI,
      });
      const r = await service.receiveAdvice(actor, input("minio/mixed-payee.835", raw));
      expect(r.outcome).toBe("malformed");
      const none = await admin.query(
        "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number='000000702'",
      );
      expect(none.rows[0].n).toBe(0);
    });

    it("refuses at post time too: an advice queued before the check fails and posts no line", async () => {
      const actor: M25IngestActor = { organizationId: ORG_A };
      const key = "minio/wrong-payee.835";
      const raw = buildEdiSets("000000703", [{ st02: "0721", icn: "ICN-W1", npi: "1999999984" }]);
      const client = createX12835Client({ readRaw: async () => raw });
      const received = await buildDrizzleM25IngestService(handle.db, {
        client,
        payeeNpi: PAYEE_UNCHECKED,
      }).receiveAdvice(actor, input(key, raw));
      expect(received.outcome).toBe("queued");
      if (received.outcome !== "queued") throw new Error("unreachable");

      const guarded = buildDrizzleM25IngestService(handle.db, {
        client,
        payeeNpi: async () => TENANT_NPI,
      });
      const posted = await guarded.postAdvice(actor, received.adviceId);
      expect(posted.outcome).toBe("failed");
      const adv = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
        received.adviceId,
      ]);
      expect(adv.rows[0].parse_status).toBe("failed");
      const lines = await admin.query(
        "SELECT count(*)::int AS n FROM remittance_line WHERE remittance_advice_id=$1",
        [received.adviceId],
      );
      expect(lines.rows[0].n).toBe(0);
    });
  });

  describe("payee TIN through M1's reader + M2's tax-id cipher (#671)", () => {
    const TENANT_NPI = "1234567893";
    const TIN = "123456789";
    const key = randomBytes(32);
    const cipher = createTaxIdCipher({
      dekForOrg: async () => ({ version: "1", key }),
      dekForOrgVersion: async () => ({ version: "1", key }),
    });
    const ids: { a?: string; b?: string } = {};

    /** The composition root's lookup (index.ts `m25PayeeTinDeps.payeeTin`), over the real app-role db. */
    const payeeTin = (organizationId: string, providerEntityId: string) =>
      withOrgContext(handle.db, { organizationId, userId: "" }, async (tx) => {
        const facts = await buildFoundationSiteReader().providerEntityBillingFacts(
          tx,
          organizationId,
          providerEntityId,
        );
        if (!facts) return null;
        return cipher.decrypt({
          organizationId,
          providerEntityId,
          sealed: facts.taxIdSealed,
        });
      });

    async function seedProvider(org: string, npi: string, ccn: string, tin: string) {
      const id = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,'Synth Hospice',$3,'x','12-31') RETURNING id`,
          [org, ccn, npi],
        )
      ).rows[0].id as string;
      const sealed = await cipher.encrypt({
        organizationId: org,
        providerEntityId: id,
        plaintext: tin,
      });
      await admin.query("UPDATE provider_entity SET tax_id_encrypted=$1 WHERE id=$2", [sealed, id]);
      return id;
    }

    /** A balanced one-set 835 whose payee is identified only by tax id (N103=FI). */
    function fiOnlyEdi(isa13: string, st02: string, payeeTin: string): string {
      const body = [
        "BPR*I*500.00*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615",
        `TRN*1*EFT-${isa13}*1512345678`,
        "N1*PR*SYNTHETIC MAC",
        `N1*PE*SYNTH HOSPICE*FI*${payeeTin}`,
        `CLP*PCN-${isa13}*1*500.00*500.00*0.00*MC*ICN-${isa13}`,
        "SVC*HC:T1005*500.00*500.00",
      ];
      return `${buildRawEdi(isa13, st02)}${body.map((x) => `${x}~`).join("")}SE*${body.length + 2}*${st02}~GE*1*1~IEA*1*${isa13.padStart(9, "0")}~`;
    }

    beforeAll(async () => {
      ids.a = await seedProvider(ORG_A, TENANT_NPI, "H67101", TIN);
      ids.b = await seedProvider(ORG_B, "1999999984", "H67102", "987654321");
    });

    const receive = (
      org: string,
      pe: string,
      raw: string,
      policy: Record<string, string[]>,
      payerKind: "medicare" | "medicaid" = "medicaid",
    ) =>
      buildDrizzleM25IngestService(handle.db, {
        client: createX12835Client({ readRaw: async () => raw }),
        payeeNpi: async () => TENANT_NPI,
        payeeTin,
        payeeTinPolicy: parsePayeeTinPolicy(JSON.stringify(policy)),
      }).receiveAdvice(
        { organizationId: org },
        {
          providerEntityId: pe,
          payerId: PAYER,
          payerKind,
          minioObjectKey: `minio/${raw.length}.835`,
          fileSha256: sha256Hex(raw),
          rawEdi: raw,
        },
      );
    const adviceCount = async (isa: string) =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number=$1",
          [isa],
        )
      ).rows[0].n as number;

    it("a policy-allowed tax-id-only payee with the sealed TIN is queued", async () => {
      const raw = fiOnlyEdi("000000801", "0801", "12-3456789");
      const r = await receive(ORG_A, ids.a as string, raw, {
        [ORG_A]: ["medicaid"],
      });
      expect(r.outcome).toBe("queued");
    });

    it("the same file is refused by default and on a program the policy does not cover", async () => {
      const raw = fiOnlyEdi("000000802", "0802", TIN);
      expect((await receive(ORG_A, ids.a as string, raw, {})).outcome).toBe("malformed");
      expect(
        (await receive(ORG_A, ids.a as string, raw, { [ORG_A]: ["medicaid"] }, "medicare")).outcome,
      ).toBe("malformed");
      expect(await adviceCount("000000802")).toBe(0);
    });

    it("a wrong TIN is refused and nothing is stored", async () => {
      const raw = fiOnlyEdi("000000803", "0803", "987654321");
      const r = await receive(ORG_A, ids.a as string, raw, {
        [ORG_A]: ["medicaid"],
      });
      expect(r.outcome).toBe("malformed");
      expect(await adviceCount("000000803")).toBe(0);
    });

    it("cross-tenant: org A's policy and TIN never open org B's provider entity, and vice versa", async () => {
      expect(await payeeTin(ORG_A, ids.b as string)).toBeNull();
      expect(await payeeTin(ORG_B, ids.a as string)).toBeNull();
      const raw = fiOnlyEdi("000000804", "0804", TIN);
      // Org B holds PE b (TIN 987654321): org A's TIN on the file must not match it.
      const r = await receive(ORG_B, ids.b as string, raw, {
        [ORG_B]: ["medicaid"],
      });
      expect(r.outcome).toBe("malformed");
      // Org A's policy does not extend to org B.
      const rawB = fiOnlyEdi("000000805", "0805", "987654321");
      const denied = await receive(ORG_B, ids.b as string, rawB, {
        [ORG_A]: ["medicaid"],
      });
      expect(denied.outcome).toBe("malformed");
      expect(await adviceCount("000000804")).toBe(0);
    });

    it("an unopenable sealed TIN (wrong tenant AAD) fails closed", async () => {
      const foreign = await cipher.encrypt({
        organizationId: ORG_B,
        providerEntityId: ids.b as string,
        plaintext: TIN,
      });
      await admin.query("UPDATE provider_entity SET tax_id_encrypted=$1 WHERE id=$2", [
        foreign,
        ids.a,
      ]);
      try {
        const raw = fiOnlyEdi("000000806", "0806", TIN);
        const r = await receive(ORG_A, ids.a as string, raw, {
          [ORG_A]: ["medicaid"],
        });
        expect(r).toMatchObject({
          outcome: "malformed",
          reason: expect.stringContaining("could not be read"),
        });
      } finally {
        const sealed = await cipher.encrypt({
          organizationId: ORG_A,
          providerEntityId: ids.a as string,
          plaintext: TIN,
        });
        await admin.query("UPDATE provider_entity SET tax_id_encrypted=$1 WHERE id=$2", [
          sealed,
          ids.a,
        ]);
      }
    });
  });

  describe("postAdvice reaction to a degraded parse (retryable vs not)", () => {
    const receiveInput = (objectKey: string, raw: string, sha: string): ReceiveAdviceInput => ({
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });

    it("retryable X12_835_RAW_UNAVAILABLE: advice marked failed AND the ops hook fires (ids + code only)", async () => {
      const actor: M25IngestActor = { organizationId: ORG_A };
      const events: unknown[] = [];
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: createX12835Client(), // no readRaw wired
        onRetryableParseDegraded: (e) => events.push(e),
        outbox: { async publish() {} },
      });
      const received = await service.receiveAdvice(
        actor,
        receiveInput("minio/unavail.835", buildFullEdi("000090301", "9301", "500.00"), "d"),
      );
      if (received.outcome !== "queued") throw new Error(JSON.stringify(received));
      const posted = await service.postAdvice(actor, received.adviceId);
      expect(posted.outcome).toBe("failed");
      expect(events).toEqual([
        {
          organizationId: ORG_A,
          adviceId: received.adviceId,
          code: "X12_835_RAW_UNAVAILABLE",
        },
      ]);
      const row = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
        received.adviceId,
      ]);
      expect(row.rows[0].parse_status).toBe("failed");
    });

    it("retryable X12_835_RAW_READ with a leaky storage error: fixed reason stored, hook fires", async () => {
      const actor: M25IngestActor = { organizationId: ORG_A };
      const events: Array<{ code: string }> = [];
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: createX12835Client({
          readRaw: () => Promise.reject(new Error("https://minio.internal:9000/secret-bucket")),
        }),
        onRetryableParseDegraded: (e) => events.push(e),
        outbox: { async publish() {} },
      });
      const received = await service.receiveAdvice(
        actor,
        receiveInput("minio/readfail.835", buildFullEdi("000090302", "9302", "500.00"), "e"),
      );
      if (received.outcome !== "queued") throw new Error("unreachable");
      await service.postAdvice(actor, received.adviceId);
      expect(events.map((e) => e.code)).toEqual(["X12_835_RAW_READ"]);
      const row = await admin.query("SELECT parse_summary FROM remittance_advice WHERE id=$1", [
        received.adviceId,
      ]);
      expect(JSON.stringify(row.rows[0].parse_summary)).not.toContain("minio");
    });

    it("non-retryable parse failure at post time: advice marked failed, hook does NOT fire", async () => {
      const actor: M25IngestActor = { organizationId: ORG_A };
      const events: unknown[] = [];
      const staged = buildFullEdi("000090303", "9303", "499.99"); // unbalanced BPR02
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: createX12835Client({ readRaw: async () => staged }),
        onRetryableParseDegraded: (e) => events.push(e),
        outbox: { async publish() {} },
      });
      const received = await service.receiveAdvice(
        actor,
        // receive with a balanced copy (same control numbers) so the row exists; the staged object is bad
        receiveInput("minio/badstaged.835", buildFullEdi("000090303", "9303", "500.00"), "f"),
      );
      if (received.outcome !== "queued") throw new Error("unreachable");
      const posted = await service.postAdvice(actor, received.adviceId);
      expect(posted.outcome).toBe("failed");
      expect(events).toHaveLength(0);
    });

    it("a retryable degrade at RECEIVE persists nothing (no advice row to fail)", async () => {
      const actor: M25IngestActor = { organizationId: ORG_A };
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: fakeClient(new Map()), // fakeClient degrades every key
        outbox: { async publish() {} },
      });
      const r = await service.receiveAdvice(
        actor,
        receiveInput("minio/none.835", buildFullEdi("000090304", "9304", "500.00"), "a"),
      );
      expect(r.outcome).toBe("malformed");
      const n = await admin.query(
        "SELECT count(*)::int AS n FROM remittance_advice WHERE interchange_control_number='000090304'",
      );
      expect(n.rows[0].n).toBe(0);
    });
  });

  describe("the real M23 ClaimSubmissionReader bridge (F-128, #251)", () => {
    it("auto-matches a line to a REAL M23 claim by CLP01 and resolves the REAL patient id for the PR-ledger", async () => {
      const patientId = crypto.randomUUID();
      const claimId = await seedClaim({
        organizationId: ORG_A,
        providerEntityId: PE_A,
        patientId,
        claimControlNumber: "REAL-CCN-901",
      });

      const isa = "000000601";
      const st = "0601";
      const objectKey = "minio/real-bridge.835";
      const parsed: ParsedRemittanceAdvice = {
        payerProgram: "medicare",
        interchangeControlNumber: isa,
        transactionSetControlNumber: st,
        paymentMethod: "check",
        checkOrEftTraceNumber: "SYNTHETIC-BRIDGE-TRACE-601",
        totalPaymentAmount: 450,
        productionDate: "2026-03-06",
        claims: [
          {
            // CLP01 — matches the REAL claim's claim_control_number, not a fakeClaims() double.
            patientControlNumber: "REAL-CCN-901",
            statusCode: 1,
            totalCharge: 500,
            totalPayment: 450,
            patientResponsibility: 50,
            adjustments: [{ groupCode: "PR" as const, reasonCode: "1", amount: 50 }],
            remarks: [],
            serviceLines: [],
          },
        ],
      };
      const terminology = fakeTerminology({
        "1": {
          category: "informational",
          plainLanguage: "patient responsibility",
        },
      });
      // The real bridge, not `fakeClaims()` — resolves through the `ClaimSubmissionReader` seam
      // registered in `beforeAll`, exactly as `index.ts`'s composition root wires it.
      const claims = buildM23BackedClaimMatchCandidateProvider();
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: fakeClient(new Map([[objectKey, parsed]])),
        terminology,
        claims: { medicare: claims },
      });

      const received = await service.receiveAdvice(
        { organizationId: ORG_A },
        {
          providerEntityId: PE_A,
          payerId: PAYER,
          payerKind: "medicare",
          minioObjectKey: objectKey,
          fileSha256: sha256Hex(buildRawEdi(isa, st)),
          rawEdi: buildRawEdi(isa, st),
        },
      );
      expect(received.outcome).toBe("queued");
      if (received.outcome !== "queued") throw new Error("unreachable");

      const posted = await service.postAdvice({ organizationId: ORG_A }, received.adviceId);
      expect(posted.outcome).toBe("posted");

      const lineRow = await admin.query(
        "SELECT match_state, claim_id FROM remittance_line WHERE remittance_advice_id=$1",
        [received.adviceId],
      );
      expect(lineRow.rows[0].match_state).toBe("posted");
      // The REAL M23 claim id — proves `candidatesForLine` reached the real `claim` table, not a double.
      expect(lineRow.rows[0].claim_id).toBe(claimId);

      const prLedger = await admin.query(
        "SELECT patient_id FROM patient_responsibility_ledger pl JOIN remittance_line rl ON pl.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1",
        [received.adviceId],
      );
      // The REAL patient id — proves `patientIdForClaim` reached the real claim row too.
      expect(prLedger.rows[0].patient_id).toBe(patientId);
    });

    it("never matches another org's claim, even on an identical claim_control_number (org+providerEntity scoped)", async () => {
      // A real claim in ORG_B with the SAME control number ORG_A's 835 line will carry.
      await seedClaim({
        organizationId: ORG_B,
        providerEntityId: PE_B,
        patientId: crypto.randomUUID(),
        claimControlNumber: "SHARED-CCN-902",
      });

      const isa = "000000602";
      const st = "0602";
      const objectKey = "minio/cross-tenant-bridge.835";
      const parsed: ParsedRemittanceAdvice = {
        payerProgram: "medicare",
        interchangeControlNumber: isa,
        transactionSetControlNumber: st,
        paymentMethod: "check",
        checkOrEftTraceNumber: "SYNTHETIC-BRIDGE-TRACE-602",
        totalPaymentAmount: 100,
        productionDate: "2026-03-06",
        claims: [
          {
            patientControlNumber: "SHARED-CCN-902",
            statusCode: 1,
            totalCharge: 100,
            totalPayment: 100,
            patientResponsibility: 0,
            adjustments: [],
            remarks: [],
            serviceLines: [],
          },
        ],
      };
      const claims = buildM23BackedClaimMatchCandidateProvider();
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: fakeClient(new Map([[objectKey, parsed]])),
        claims: { medicare: claims },
      });

      // Received under ORG_A (a different tenant than the seeded claim) + PE_A (a different provider
      // entity than PE_B) — `findMatchCandidates` scopes on BOTH organization_id and provider_entity_id.
      const received = await service.receiveAdvice(
        { organizationId: ORG_A },
        {
          providerEntityId: PE_A,
          payerId: PAYER,
          payerKind: "medicare",
          minioObjectKey: objectKey,
          fileSha256: sha256Hex(buildRawEdi(isa, st)),
          rawEdi: buildRawEdi(isa, st),
        },
      );
      expect(received.outcome).toBe("queued");
      if (received.outcome !== "queued") throw new Error("unreachable");

      const posted = await service.postAdvice({ organizationId: ORG_A }, received.adviceId);
      // No candidate found (the org-B claim is invisible), so the line routes to manual match rather
      // than fabricating a cross-tenant match — `partial_posted` because the one line is unmatched.
      expect(posted.outcome).toBe("partial_posted");
      const lineRow = await admin.query(
        "SELECT match_state, claim_id FROM remittance_line WHERE remittance_advice_id=$1",
        [received.adviceId],
      );
      expect(lineRow.rows[0].claim_id).toBeNull();
      expect(lineRow.rows[0].match_state).toBe("unmatched");
    });
  });

  describe("a commercial 835 fails closed to manual review (S12, #710)", () => {
    it("auto-posts nothing, queues every line for manual match, and the queue is tenant-isolated", async () => {
      const ccn = "COMM-CCN-1001";
      // A REAL Medicare claim in the same tenant + provider entity carrying the very control number the
      // commercial file will name: a payer-blind matcher would bind it. Production wires only `medicare`.
      const medicareClaimId = await seedClaim({
        organizationId: ORG_A,
        providerEntityId: PE_A,
        patientId: crypto.randomUUID(),
        claimControlNumber: ccn,
      });
      const isa = "000000951";
      const st = "0951";
      const raw = buildFullEdi(isa, st, "450.00", {
        clp01: ccn,
        icn: "ICN-COMM-1",
        charge: "500.00",
        paid: "450.00",
        patientResponsibility: "50.00",
      });
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: createX12835Client(),
        rawStore: {
          put: async () => {},
          get: async () => raw,
          delete: async () => {},
        },
        claims: { medicare: buildM23BackedClaimMatchCandidateProvider() },
      });
      const received = await service.receiveAdvice(
        { organizationId: ORG_A },
        {
          providerEntityId: PE_A,
          payerId: PAYER,
          payerKind: "commercial",
          minioObjectKey: "minio/commercial.835",
          fileSha256: sha256Hex(raw),
          rawEdi: raw,
        },
      );
      expect(received).toEqual({
        outcome: "queued",
        adviceId: expect.any(String),
      });
      if (received.outcome !== "queued") throw new Error("unreachable");
      const posted = await service.postAdvice({ organizationId: ORG_A }, received.adviceId);
      expect(posted).toMatchObject({
        outcome: "partial_posted",
        postedLineCount: 0,
        unmatchedLineCount: 1,
      });

      const line = await admin.query(
        "SELECT id, match_state, claim_id FROM remittance_line WHERE remittance_advice_id=$1",
        [received.adviceId],
      );
      expect(line.rows).toHaveLength(1);
      expect(line.rows[0].match_state).toBe("unmatched");
      expect(line.rows[0].claim_id).toBeNull();
      // Nothing was posted against the Medicare claim or the patient ledger.
      const ledger = await admin.query(
        "SELECT count(*)::int AS n FROM patient_responsibility_ledger WHERE remittance_line_id=$1",
        [line.rows[0].id],
      );
      expect(ledger.rows[0].n).toBe(0);
      const paidEvents = await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm25.remittance.claim_%' AND organization_id=$1 AND payload::text LIKE '%' || $2 || '%'",
        [ORG_A, medicareClaimId],
      );
      expect(paidEvents.rows[0].n).toBe(0);
      const claimState = await admin.query("SELECT state FROM claim WHERE id=$1", [
        medicareClaimId,
      ]);
      expect(claimState.rows[0].state).toBe("DRAFT");

      // The manual-match queue shows it to its own tenant only.
      const reads = buildDrizzleM25ReadService(handle.db);
      const actorOf = (organizationId: string) => ({
        organizationId,
        userId: "",
        roles: ["billing_manager"],
      });
      const queueA = await reads.listUnmatched(actorOf(ORG_A), undefined, undefined, 50);
      expect(queueA.items.map((l) => l.id)).toContain(line.rows[0].id);
      const queueB = await reads.listUnmatched(actorOf(ORG_B), undefined, undefined, 50);
      expect(queueB.items.map((l) => l.id)).not.toContain(line.rows[0].id);
    });
  });

  it("cross-tenant: two orgs' distinct provider entities may reuse the SAME ISA/ST control numbers, and RLS hides each org's advice from the other", async () => {
    const isa = "000000501";
    const st = "0501";
    const parsedFor = (payment: number): ParsedRemittanceAdvice => ({
      payerProgram: "medicare",
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      paymentMethod: "check",
      totalPaymentAmount: payment,
      productionDate: "2026-02-06",
      claims: [],
    });
    const serviceA = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([["minio/org-a.835", parsedFor(11)]])),
    });
    const serviceB = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: fakeClient(new Map([["minio/org-b.835", parsedFor(22)]])),
    });
    const rawEdi = buildRawEdi(isa, st);
    const a = await serviceA.receiveAdvice(
      { organizationId: ORG_A },
      {
        providerEntityId: PE_A,
        payerId: PAYER,
        payerKind: "medicare",
        minioObjectKey: "minio/org-a.835",
        fileSha256: sha256Hex(rawEdi),
        rawEdi,
      },
    );
    const b = await serviceB.receiveAdvice(
      { organizationId: ORG_B },
      {
        providerEntityId: PE_B,
        payerId: PAYER,
        payerKind: "medicare",
        minioObjectKey: "minio/org-b.835",
        fileSha256: sha256Hex(rawEdi),
        rawEdi,
      },
    );
    // Different provider_entity_id ⇒ the dedup index does not collide across orgs sharing an ISA/ST space.
    expect(a.outcome).toBe("queued");
    expect(b.outcome).toBe("queued");

    // The RLS proof runs as NOBYPASSRLS `chartwarden_app` (the rls-isolation.live.test.ts precedent) — the
    // `admin` connection is a superuser and would see everything regardless of `app.org_id`, which would
    // make this assertion pass vacuously.
    async function readAdviceIdsAs(organizationId: string): Promise<string[]> {
      await admin.query("SET ROLE chartwarden_app");
      try {
        await admin.query("SELECT set_config('app.org_id', $1, false)", [organizationId]);
        const res = await admin.query("SELECT id FROM remittance_advice");
        return res.rows.map((r) => r.id as string);
      } finally {
        await admin.query("RESET ROLE");
      }
    }
    const asOrgA = await readAdviceIdsAs(ORG_A);
    const asOrgB = await readAdviceIdsAs(ORG_B);

    if (a.outcome !== "queued" || b.outcome !== "queued") throw new Error("unreachable");
    expect(asOrgA).toContain(a.adviceId);
    expect(asOrgA).not.toContain(b.adviceId);
    expect(asOrgB).toContain(b.adviceId);
    expect(asOrgB).not.toContain(a.adviceId);
  });

  // ── #717: the clearinghouse feed into this same pipeline (in-memory far side, REAL receive/post + cursor store) ──
  describe("clearinghouse remittance pull (#717)", () => {
    const pullCtx = (): ClearinghouseContext => ({
      organizationId: ORG_A,
      providerEntityId: PE_A,
      payerId: "J6",
      correlationId: "corr-717",
      usage: "test",
      billingNpi: "1234567893",
    });
    const scope = {
      organizationId: ORG_A,
      providerEntityId: PE_A,
      usage: "test" as const,
      billingNpi: "1234567893",
    };

    it("fetches cursor-paged 835s, dedups a redelivery on its control numbers (S08), posts them, and resumes from the stored cursor", async () => {
      const far = new InMemoryClearinghouse();
      const files = ["000071701", "000071702", "000071703"].map((isa, i) =>
        buildFullEdi(isa, "0001", "500.00", {
          clp01: `PCN-717-${i}`,
          icn: `ICN-717-${i}`,
        }),
      );
      await far.control.deliverRemittance("ERA-717-1", files[0] as string, scope);
      await far.control.deliverRemittance("ERA-717-2", files[1] as string, scope);
      await far.control.deliverRemittance("ERA-717-2-again", files[1] as string, scope); // same ISA/ST, new file id
      await far.control.deliverRemittance("ERA-717-3", files[2] as string, scope);

      const staged = new Map<string, string>();
      const events: string[] = [];
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: createX12835Client(),
        rawStore: {
          put: async (_o, id, text) => void staged.set(id, text),
          get: async (_o, id) => staged.get(id) ?? null,
          delete: async (_o, id) => void staged.delete(id),
        },
        terminology: fakeTerminology({}),
        claims: { medicare: fakeClaims({}, {}) },
        outbox: {
          async publish(_tx, event) {
            events.push(event.eventName);
          },
        },
      });
      const deps = {
        transport: far,
        vendor: "in_memory",
        contexts: {
          providerEntitiesFor: async () => [PE_A],
          contextFor: async () => pullCtx(),
        },
        payers: { medicarePayerId: async () => PAYER },
        cursors: buildDrizzleRemittanceCursorStore(handle.db),
        ingest: service,
      };

      const first = await pullRemittances(deps, ORG_A);

      expect(first).toMatchObject({ queued: 3, duplicates: 1, failures: [] });
      expect(events.filter((e) => e === "m25.edi.835_received")).toHaveLength(3);
      const rows = await admin.query(
        "SELECT id FROM remittance_advice WHERE interchange_control_number IN ('000071701','000071702','000071703')",
      );
      expect(rows.rows).toHaveLength(3);
      for (const r of rows.rows) {
        const posted = await service.postAdvice({ organizationId: ORG_A }, r.id as string);
        expect(["posted", "partial_posted"]).toContain(posted.outcome);
      }
      const again = await pullRemittances(deps, ORG_A);
      expect(again).toMatchObject({ queued: 0, duplicates: 0, failures: [] });
      const stored = await admin.query(
        "SELECT cursor FROM remittance_pull_cursor WHERE organization_id=$1 AND provider_entity_id=$2 AND vendor='in_memory'",
        [ORG_A, PE_A],
      );
      expect(stored.rows[0].cursor).toBe("4");
    });

    it("refuses a malformed stored cursor and leaves the row untouched (never restarts from the beginning)", async () => {
      const cursors = buildDrizzleRemittanceCursorStore(handle.db);
      const key = {
        organizationId: ORG_A,
        providerEntityId: PE_A,
        vendor: "in_memory_bad",
        usage: "test" as const,
      };
      await cursors.set(key, "not-a-cursor");
      const received: string[] = [];
      const deps = {
        transport: new InMemoryClearinghouse(),
        vendor: "in_memory_bad",
        contexts: {
          providerEntitiesFor: async () => [PE_A],
          contextFor: async () => pullCtx(),
        },
        payers: { medicarePayerId: async () => PAYER },
        cursors,
        ingest: {
          receiveAdvice: async (): Promise<ReceiveAdviceResult> => {
            received.push("x");
            return { outcome: "duplicate", existingAdviceId: "x" };
          },
        },
      };

      const result = await pullRemittances(deps, ORG_A);

      expect(result.failures[0]).toContain("request refused (cursor not reset)");
      expect(received).toHaveLength(0);
      expect(await cursors.get(key)).toBe("not-a-cursor");
    });

    it("quarantines a file refused MAX times (durable, audited), advances the cursor past it, and hides it from other tenants", async () => {
      const cursors = buildDrizzleRemittanceCursorStore(handle.db);
      const far = new InMemoryClearinghouse();
      for (const n of [1, 2, 3, 4]) {
        await far.control.deliverRemittance(
          `ERA-Q-${n}`,
          buildFullEdi(`00007180${n}`, "0001", "100.00", {
            clp01: `PCN-Q-${n}`,
            icn: `ICN-Q-${n}`,
          }),
          scope,
        );
      }
      const deps = {
        transport: far,
        vendor: "in_memory_poison",
        contexts: {
          providerEntitiesFor: async () => [PE_A],
          contextFor: async () => pullCtx(),
        },
        payers: { medicarePayerId: async () => PAYER },
        cursors,
        ingest: {
          receiveAdvice: async (
            _actor: { organizationId: string },
            input: { minioObjectKey: string },
          ): Promise<ReceiveAdviceResult> =>
            input.minioObjectKey.endsWith("ERA-Q-3")
              ? {
                  outcome: "malformed",
                  reason: "synthetic",
                  cause: "content",
                }
              : { outcome: "duplicate", existingAdviceId: "x" },
        },
      };
      const key = {
        organizationId: ORG_A,
        providerEntityId: PE_A,
        vendor: "in_memory_poison",
        usage: "test" as const,
      };

      for (let i = 1; i < MAX_REFUSALS_PER_REMITTANCE; i++) {
        const r = await pullRemittances(deps, ORG_A);
        expect(r.failures).toHaveLength(1);
        expect(await cursors.isQuarantined(key, "ERA-Q-3", "0".repeat(64))).toBe(false);
      }
      const final = await pullRemittances(deps, ORG_A);

      expect(final.failures).toEqual([]);
      expect(final.quarantined).toHaveLength(1);
      expect(final.quarantined[0]).toContain("REMITTANCE_QUARANTINED");
      expect(await cursors.get(key)).toBe("4");
      const row = await admin.query(
        "SELECT file_sha256, refusal_count, reason_code, quarantined_at FROM remittance_pull_refusal WHERE organization_id=$1 AND remittance_id='ERA-Q-3'",
        [ORG_A],
      );
      expect(row.rows[0].refusal_count).toBe(MAX_REFUSALS_PER_REMITTANCE);
      expect(row.rows[0].reason_code).toBe("RECEIVE_REFUSED");
      expect(row.rows[0].quarantined_at).not.toBeNull();
      const sha = row.rows[0].file_sha256 as string;
      expect(await cursors.isQuarantined(key, "ERA-Q-3", sha)).toBe(true);
      expect(await cursors.isQuarantined(key, "ERA-Q-3", "1".repeat(64))).toBe(false); // changed content is a new file
      expect(await cursors.isQuarantined({ ...key, organizationId: ORG_B }, "ERA-Q-3", sha)).toBe(
        false,
      );
      // still reported (skipped) when the vendor re-offers it on a later tick
      await cursors.set(key, "2");
      const again = await pullRemittances(deps, ORG_A);
      expect(again.quarantined).toHaveLength(1);
      expect(again.failures).toEqual([]);
      const audit = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='remittance_pull_refusal' AND organization_id=$1",
        [ORG_A],
      );
      expect(audit.rows[0].n).toBe(MAX_REFUSALS_PER_REMITTANCE);
    });

    it("zeroes a file's refusal count once it is accepted, and the cursor advances", async () => {
      const cursors = buildDrizzleRemittanceCursorStore(handle.db);
      const far = new InMemoryClearinghouse();
      await far.control.deliverRemittance(
        "ERA-R-1",
        buildFullEdi("000071901", "0001", "100.00", {
          clp01: "PCN-R-1",
          icn: "ICN-R-1",
        }),
        scope,
      );
      let refuse = true;
      const deps = {
        transport: far,
        vendor: "in_memory_reset",
        contexts: {
          providerEntitiesFor: async () => [PE_A],
          contextFor: async () => pullCtx(),
        },
        payers: { medicarePayerId: async () => PAYER },
        cursors,
        ingest: {
          receiveAdvice: async (): Promise<ReceiveAdviceResult> =>
            refuse
              ? {
                  outcome: "malformed",
                  reason: "synthetic",
                  cause: "content",
                }
              : { outcome: "queued", adviceId: "adv-r" },
        },
      };
      const key = {
        organizationId: ORG_A,
        providerEntityId: PE_A,
        vendor: "in_memory_reset",
        usage: "test" as const,
      };
      const sha = async (): Promise<string> =>
        (
          await admin.query(
            "SELECT file_sha256 FROM remittance_pull_refusal WHERE organization_id=$1 AND vendor='in_memory_reset' AND remittance_id='ERA-R-1'",
            [ORG_A],
          )
        ).rows[0]?.file_sha256;
      const count = async () =>
        (
          await admin.query(
            "SELECT refusal_count, file_sha256 FROM remittance_pull_refusal WHERE organization_id=$1 AND vendor='in_memory_reset' AND remittance_id='ERA-R-1'",
            [ORG_A],
          )
        ).rows[0]?.refusal_count;

      expect((await pullRemittances(deps, ORG_A)).failures).toHaveLength(1);
      expect(await count()).toBe(1);
      refuse = false;
      const ok = await pullRemittances(deps, ORG_A);

      expect(ok).toMatchObject({ queued: 1, failures: [], quarantined: [] });
      expect(await count()).toBe(0);
      expect(await cursors.get(key)).toBe("1");
      expect(await cursors.isQuarantined(key, "ERA-R-1", await sha())).toBe(false);
    });

    it("keeps one tenant's cursor invisible to another (RLS on the app role)", async () => {
      const cursors = buildDrizzleRemittanceCursorStore(handle.db);
      const base = {
        providerEntityId: PE_A,
        vendor: "in_memory_rls",
        usage: "test" as const,
      };
      await cursors.set({ ...base, organizationId: ORG_A }, "7");

      expect(await cursors.get({ ...base, organizationId: ORG_A })).toBe("7");
      expect(await cursors.get({ ...base, organizationId: ORG_B })).toBeNull();
    });

    it("serves an authenticated, provider-scoped Revenue Cycle M25 report from PostgreSQL without mutation", async () => {
      const providerEntityId = crypto.randomUUID();
      const claimControlNumber = `SYNTHETIC-REPORT-CCN-${crypto.randomUUID().slice(0, 8)}`;
      const payerIcn = `SYNTHETIC-REPORT-ICN-${crypto.randomUUID().slice(0, 8)}`;
      const claimId = await seedClaim({
        organizationId: ORG_A,
        providerEntityId,
        patientId: crypto.randomUUID(),
        claimControlNumber,
        payerClaimControlNumber: payerIcn,
      });
      const rawKey = `minio/revenue-cycle-report-${crypto.randomUUID()}.835`;
      const raw = buildRawEdi("000000991", "0991");
      const parsed: ParsedRemittanceAdvice = {
        payerProgram: "medicare",
        payer: { name: "Synthetic Reporting Payer", id: PAYER },
        payee: { name: "Synthetic Hospice", idQualifier: "XX", id: "1999999999" },
        interchangeControlNumber: "000000991",
        transactionSetControlNumber: "0991",
        checkOrEftTraceNumber: `RPT-${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`,
        paymentMethod: "eft",
        totalPaymentAmount: 42,
        productionDate: "2026-03-01",
        claims: [
          {
            patientControlNumber: claimControlNumber,
            payerIcn,
            statusCode: 1,
            totalCharge: 42,
            totalPayment: 42,
            patientResponsibility: 0,
            adjustments: [],
            remarks: [],
            serviceLines: [],
          },
          {
            patientControlNumber: `SYNTHETIC-REPORT-UNMATCHED-${crypto.randomUUID().slice(0, 8)}`,
            payerIcn: `UNMATCHED-ICN-${crypto.randomUUID().slice(0, 8)}`,
            statusCode: 1,
            totalCharge: 10,
            totalPayment: 0,
            patientResponsibility: 0,
            adjustments: [],
            remarks: [],
            serviceLines: [],
          },
        ],
      };
      const reportPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
      const reportOutbox: WriteOutboxPort = {
        publish: (tx, emission) =>
          reportPublisher.publish(tx as never, { ...emission, callerModule: "m25" }),
      };
      const ingest = buildDrizzleM25IngestService(handle.db, {
        client: fakeClient(new Map([[rawKey, parsed]])),
        payeeNpi: PAYEE_UNCHECKED,
        claims: {
          medicare: fakeClaims({ [payerIcn]: [{ claimId, payerIcn, claimControlNumber }] }, {}),
        },
        outbox: reportOutbox,
      });
      const received = await ingest.receiveAdvice(
        { organizationId: ORG_A },
        {
          providerEntityId,
          payerId: PAYER,
          payerKind: "medicare",
          minioObjectKey: rawKey,
          fileSha256: sha256Hex(raw),
          rawEdi: raw,
        },
      );
      if (received.outcome !== "queued") throw new Error("expected queued report fixture");
      const posted = await ingest.postAdvice({ organizationId: ORG_A }, received.adviceId);
      expect(posted, JSON.stringify(posted)).toMatchObject({
        outcome: "partial_posted",
        postedLineCount: 1,
        unmatchedLineCount: 1,
      });

      const reads = buildDrizzleM25ReadService(handle.db);
      const actorMap = new Map([
        [
          "tenant-a",
          {
            userId: "66666666-6666-4666-8666-666666666661",
            organizationId: ORG_A,
            providerEntityIds: [providerEntityId],
          },
        ],
        [
          "tenant-b",
          {
            userId: "66666666-6666-4666-8666-666666666662",
            organizationId: ORG_B,
            providerEntityIds: [PE_B],
          },
        ],
      ]);
      const http = Fastify();
      http.addHook("onRequest", async (request) => {
        const principal = request.headers["x-test-principal"];
        const actor = typeof principal === "string" ? actorMap.get(principal) : undefined;
        if (!actor) return;
        request.context = {
          correlationId: crypto.randomUUID(),
          userId: actor.userId,
          organizationId: actor.organizationId,
          providerEntityIds: actor.providerEntityIds,
          locationIds: [],
          roles: [],
          attributes: { membershipId: actor.userId, sessionId: actor.userId },
          ip: "127.0.0.1",
          userAgent: "synthetic-revenue-cycle-test",
          startTime: Date.now(),
        };
      });
      setEffectivePermissionResolver(() => Promise.resolve(new Set(["remittance.read"])));
      const authz = createPredicateRegistry();
      registerAbacRegistry(authz);
      registerRemittanceRoutes(http, { readService: reads, writeService: {} as never });
      try {
        const toDate = new Date().toISOString().slice(0, 10);
        const fromDate = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        const before = await admin.query(
          "SELECT (SELECT count(*) FROM remittance_advice WHERE organization_id=$1)::int AS advice, (SELECT count(*) FROM remittance_line WHERE organization_id=$1)::int AS lines, (SELECT count(*) FROM outbox_event WHERE organization_id=$1 AND event_type LIKE 'm25.remittance.claim_%')::int AS events",
          [ORG_A],
        );
        const request = (principal: string, provider: string) =>
          http.inject({
            method: "GET",
            url: `/api/v1/remittance/revenue-cycle-summary?providerEntityId=${provider}&fromDate=${fromDate}&toDate=${toDate}`,
            headers: { "x-test-principal": principal },
          });
        const allowed = await request("tenant-a", providerEntityId);
        expect(allowed.statusCode, allowed.body).toBe(200);
        expect(allowed.json()).toMatchObject({
          providerEntityId,
          dateBasis: "era_received_at_utc",
          completeness: "exact_for_m25_remittance_advice",
          receivedAdviceCount: 1,
          reportedAdviceCount: 1,
          reportedEraPaymentCents: "4200",
          reportedClaimPaymentCents: "4200",
          fullyPostedClaimPaymentCents: "0",
          postedClaimPaymentCents: "4200",
          fullyPostedAdviceCount: 0,
          partialPostedAdviceCount: 1,
          authoritativeAr: {
            status: "unavailable",
            reasonCode: "NO_CANONICAL_RECEIVABLE_LEDGER",
          },
        });
        const foreignProvider = await request("tenant-a", PE_B);
        expect(foreignProvider.statusCode).toBe(200);
        expect(foreignProvider.json()).toMatchObject({
          receivedAdviceCount: 0,
          reportedEraPaymentCents: "0",
          fullyPostedClaimPaymentCents: "0",
        });
        const foreignTenant = await request("tenant-b", providerEntityId);
        expect(foreignTenant.statusCode).toBe(200);
        expect(foreignTenant.json()).toMatchObject({
          receivedAdviceCount: 0,
          reportedEraPaymentCents: "0",
          fullyPostedClaimPaymentCents: "0",
        });
        const after = await admin.query(
          "SELECT (SELECT count(*) FROM remittance_advice WHERE organization_id=$1)::int AS advice, (SELECT count(*) FROM remittance_line WHERE organization_id=$1)::int AS lines, (SELECT count(*) FROM outbox_event WHERE organization_id=$1 AND event_type LIKE 'm25.remittance.claim_%')::int AS events",
          [ORG_A],
        );
        expect(after.rows[0]).toEqual(before.rows[0]);
      } finally {
        await http.close();
        resetAuthorizationContract();
      }
    });
  });
});
