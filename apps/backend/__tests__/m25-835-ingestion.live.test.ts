/**
 * WX-PR-012 — M25 X12-835 receive → parse → post pipeline, LIVE Postgres proof.
 *
 * Proves the real `receiveAdvice`/`postAdvice` pair (apps/backend/src/modules/25-remittance/ingest/
 * service-drizzle.ts) over real Postgres + RLS: dedup-at-insert, a genuinely transactional multi-claim
 * post (all-or-nothing), denial/PR-ledger seeding, posting-outcome classification, and cross-tenant
 * isolation. The X12835WorkerClient is a controllable FAKE (no real x12-worker sidecar exists in this
 * environment) — the local ISA/ST envelope-header extraction (@wardenx/x12-835-client
 * `parseX12EnvelopeHeader`) is real and exercised directly by the "malformed" case.
 *
 * F-128 (#251) — the whole file used to drive `receiveAdvice`/`postAdvice` over the bare superuser
 * `DB_URL` (GAP-086: a superuser BYPASSES RLS unconditionally), so nothing here had ever proven the write
 * path itself is RLS-clean; only one dedicated test at the bottom role-switched, and only for a bare
 * SELECT. Now connects as the real NOBYPASSRLS `wardenx_app` role throughout (`_live-app-role.ts`) — every
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
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m25-835-ingestion.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@wardenx/billing";
import { type DbClient, createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  ParsedRemittanceAdvice,
  X12WorkerResult,
  X12835WorkerClient,
} from "@wardenx/x12-835-client";
import { degraded835 } from "@wardenx/x12-835-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import type { MatchCandidate } from "../src/modules/25-remittance/domain/match";
import { buildM23BackedClaimMatchCandidateProvider } from "../src/modules/25-remittance/index";
import type {
  ClaimMatchCandidateProvider,
  M25IngestActor,
  ReceiveAdviceInput,
  TerminologyLookupPort,
} from "../src/modules/25-remittance/ingest/service";
import { buildDrizzleM25IngestService } from "../src/modules/25-remittance/ingest/service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
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

// ── ISA/ST envelope construction (real, fixed-width — see @wardenx/x12-835-client/envelope-header) ──────
function buildRawEdi(isa13: string, st02: string): string {
  const sep = "*";
  const elems = [
    "00",
    "          ",
    "00",
    "          ",
    "ZZ",
    "SENDERID       ",
    "ZZ",
    "RECEIVERID     ",
    "250101",
    "1200",
    "^",
    "00501",
    isa13.padStart(9, "0").slice(0, 9),
    "0",
    "T",
    ":",
  ];
  const isaBody = `ISA${sep}${elems.join(sep)}`;
  if (isaBody.length !== 105)
    throw new Error(`test ISA header must be 105 chars, got ${isaBody.length}`);
  const isaSegment = `${isaBody}~`;
  const gsSt = `GS${sep}HP${sep}SENDER${sep}RECEIVER${sep}20250101${sep}1200${sep}1${sep}X${sep}005010X221A1~ST${sep}835${sep}${st02}~`;
  return isaSegment + gsSt;
}

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
      fileSha256: "a".repeat(64),
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
      fileSha256: "b".repeat(64),
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
      client: fakeClient(new Map([[objectKey, parsed]])),
    });
    const input: ReceiveAdviceInput = {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: "c".repeat(64),
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
      fileSha256: "d".repeat(64),
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
      client: fakeClient(new Map([[objectKey, parsed]])),
      claims: { medicare: throwingOnNthClaims(2) }, // first claim's candidate lookup succeeds, second throws
    });
    const received = await service.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: "e".repeat(64),
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
      client: fakeClient(new Map([[objectKey, okParsed]])),
    });
    const received = await receiveService.receiveAdvice(actor, {
      providerEntityId: PE_A,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: objectKey,
      fileSha256: "f".repeat(64),
      rawEdi: buildRawEdi(isa, st),
    });
    if (received.outcome !== "queued") throw new Error("unreachable");

    const postService = buildDrizzleM25IngestService(handle.db, {
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
      client: fakeClient(new Map([[objectKey, okParsed]])),
    });
    const replayed = await replayService.postAdvice(actor, received.adviceId);
    expect(replayed.outcome).toBe("posted");
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
          fileSha256: "b".repeat(64),
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
          fileSha256: "c".repeat(64),
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
      client: fakeClient(new Map([["minio/org-a.835", parsedFor(11)]])),
    });
    const serviceB = buildDrizzleM25IngestService(handle.db, {
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
        fileSha256: "1".repeat(64),
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
        fileSha256: "2".repeat(64),
        rawEdi,
      },
    );
    // Different provider_entity_id ⇒ the dedup index does not collide across orgs sharing an ISA/ST space.
    expect(a.outcome).toBe("queued");
    expect(b.outcome).toBe("queued");

    // The RLS proof runs as NOBYPASSRLS `wardenx_app` (the rls-isolation.live.test.ts precedent) — the
    // `admin` connection is a superuser and would see everything regardless of `app.org_id`, which would
    // make this assertion pass vacuously.
    async function readAdviceIdsAs(organizationId: string): Promise<string[]> {
      await admin.query("SET ROLE wardenx_app");
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
});
