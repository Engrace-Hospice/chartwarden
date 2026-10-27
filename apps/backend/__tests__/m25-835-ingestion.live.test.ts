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
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { registerSeam } from "../src/bootstrap/index";
import { createTaxIdCipher } from "../src/modules/02-identity/tax-id-cipher";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import type { MatchCandidate } from "../src/modules/25-remittance/domain/match";
import {
  buildDrizzleM25ReadService,
  buildM23BackedClaimMatchCandidateProvider,
} from "../src/modules/25-remittance/index";
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
} from "../src/modules/25-remittance/ingest/service-drizzle";
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
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-31",
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
          remarks: [{ kind: "LQ" as const, code: "N123", text: "informational remark" }],
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
      "1": { category: "informational", plainLanguage: "patient responsibility" },
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
          { "ICN-RECOUP": [{ claimId: CLAIM_RECOUP, payerIcn: "ICN-RECOUP" }] },
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
      totalPaymentAmount: 200,
      productionDate: "2026-02-04",
      claims: [okClaim, { ...okClaim, patientControlNumber: "PCN-OK-2", payerIcn: "ICN-OK-2" }],
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
      client: createX12835Client({ readRaw: async (key) => (key === objectKey ? raw : "") }),
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
    const service = mk({ "ICN-PAID": [{ claimId: CLAIM_PAID, payerIcn: "ICN-PAID" }] });
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
      { organizationId: ORG_A, adviceId: received.adviceId, errorName: "Error" },
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
      return (
        buildRawEdi(isa13, first.st02) +
        seg(first.st02, body(first.icn, first.npi)) +
        rest.map((x) => `ST*835*${x.st02}~${seg(x.st02, body(x.icn, x.npi))}`).join("") +
        `GE*${sets.length}*1~IEA*1*${isa13.padStart(9, "0")}~`
      );
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
        return cipher.decrypt({ organizationId, providerEntityId, sealed: facts.taxIdSealed });
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
      const r = await receive(ORG_A, ids.a as string, raw, { [ORG_A]: ["medicaid"] });
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
      const r = await receive(ORG_A, ids.a as string, raw, { [ORG_A]: ["medicaid"] });
      expect(r.outcome).toBe("malformed");
      expect(await adviceCount("000000803")).toBe(0);
    });

    it("cross-tenant: org A's policy and TIN never open org B's provider entity, and vice versa", async () => {
      expect(await payeeTin(ORG_A, ids.b as string)).toBeNull();
      expect(await payeeTin(ORG_B, ids.a as string)).toBeNull();
      const raw = fiOnlyEdi("000000804", "0804", TIN);
      // Org B holds PE b (TIN 987654321): org A's TIN on the file must not match it.
      const r = await receive(ORG_B, ids.b as string, raw, { [ORG_B]: ["medicaid"] });
      expect(r.outcome).toBe("malformed");
      // Org A's policy does not extend to org B.
      const rawB = fiOnlyEdi("000000805", "0805", "987654321");
      const denied = await receive(ORG_B, ids.b as string, rawB, { [ORG_A]: ["medicaid"] });
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
        const r = await receive(ORG_A, ids.a as string, raw, { [ORG_A]: ["medicaid"] });
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
        { organizationId: ORG_A, adviceId: received.adviceId, code: "X12_835_RAW_UNAVAILABLE" },
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
        "1": { category: "informational", plainLanguage: "patient responsibility" },
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
      expect(received).toEqual({ outcome: "queued", adviceId: expect.any(String) });
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
        buildFullEdi(isa, "0001", "500.00", { clp01: `PCN-717-${i}`, icn: `ICN-717-${i}` }),
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
        contexts: { providerEntitiesFor: async () => [PE_A], contextFor: async () => pullCtx() },
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
        contexts: { providerEntitiesFor: async () => [PE_A], contextFor: async () => pullCtx() },
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
        contexts: { providerEntitiesFor: async () => [PE_A], contextFor: async () => pullCtx() },
        payers: { medicarePayerId: async () => PAYER },
        cursors,
        ingest: {
          receiveAdvice: async (
            _actor: { organizationId: string },
            input: { minioObjectKey: string },
          ): Promise<ReceiveAdviceResult> =>
            input.minioObjectKey.endsWith("ERA-Q-3")
              ? { outcome: "malformed", reason: "synthetic", cause: "content" }
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
        buildFullEdi("000071901", "0001", "100.00", { clp01: "PCN-R-1", icn: "ICN-R-1" }),
        scope,
      );
      let refuse = true;
      const deps = {
        transport: far,
        vendor: "in_memory_reset",
        contexts: { providerEntitiesFor: async () => [PE_A], contextFor: async () => pullCtx() },
        payers: { medicarePayerId: async () => PAYER },
        cursors,
        ingest: {
          receiveAdvice: async (): Promise<ReceiveAdviceResult> =>
            refuse
              ? { outcome: "malformed", reason: "synthetic", cause: "content" }
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
      const base = { providerEntityId: PE_A, vendor: "in_memory_rls", usage: "test" as const };
      await cursors.set({ ...base, organizationId: ORG_A }, "7");

      expect(await cursors.get({ ...base, organizationId: ORG_A })).toBe("7");
      expect(await cursors.get({ ...base, organizationId: ORG_B })).toBeNull();
    });
  });
});
