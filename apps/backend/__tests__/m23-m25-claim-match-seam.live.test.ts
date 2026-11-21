/**
 * WX-PR-012 follow-up — the REAL M23 -> M25 `ClaimSubmissionReader` seam bind, LIVE Postgres proof.
 *
 * Proves the gap explicitly flagged when WX-PR-012 first shipped is now closed for real: M25's D3
 * auto-match candidate lookup and PR-ledger patient-id resolution are bound to M23's ACTUAL `claim`
 * table (via the new `ClaimRepository.findMatchCandidates`/`patientIdForId` + the M23-published
 * `ClaimSubmissionReader` seam + M25's `buildM23BackedClaimMatchCandidateProvider` adapter) — not a test
 * fake. Runs a real 835 through the M25 ingest pipeline against a REAL seeded `claim` row and asserts the
 * line auto-matches to that claim's real id and the PR-ledger row carries that claim's real patient id.
 * A first test proves the adapter degrades gracefully to "no candidates"/"no patient" BEFORE the seam is
 * registered (the exact posture every other unbound M25 forward seam already has) — order matters here,
 * since the M1 SeamRegistry is a module-level singleton this file registers into partway through.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m23-m25-claim-match-seam.live.test.ts
 * (SUPERUSER to a THROWAWAY db; for a local PG without pgvector set CHARTWARDEN_TEST_NO_PGVECTOR=1.)
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { ParsedRemittanceAdvice, X12WorkerResult } from "@chartwarden/x12-835-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import { buildDrizzleM23ClaimReader } from "../src/modules/23-billing-medicare/seams/claim-reader";
import { buildM23BackedClaimMatchCandidateProvider } from "../src/modules/25-remittance/ingest/claim-match-adapter";
import {
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
} from "../src/modules/25-remittance/ingest/service-drizzle";
import { LIVE_DROP_ROLES } from "./_live-app-role";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG = "11111111-1111-1111-1111-111111111111";
const PE = "00000000-0000-0000-0000-0000000000a1";
const PAYER = "00000000-0000-0000-0000-00000000fee1";
const REAL_CLAIM_ID = "00000000-0000-0000-0000-0000000ccc01";
const REAL_PATIENT_ID = "00000000-0000-0000-0000-0000000ee001";
const CLAIM_PAYER_COVERAGE_ID = "00000000-0000-0000-0000-0000000ba0e1";
const REAL_ICN = "REAL-ICN-0001";
const REAL_CCN = "REAL-CCN-0001";

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
  const isaSegment = `${isaBody}~`;
  const gsSt = `GS${sep}HP${sep}SENDER${sep}RECEIVER${sep}20250101${sep}1200${sep}1${sep}X${sep}005010X221A1~ST${sep}835${sep}${st02}~`;
  return isaSegment + gsSt;
}

describe.skipIf(!DB_URL)("WX-PR-012 M23->M25 ClaimSubmissionReader seam — LIVE Postgres", () => {
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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    // A REAL M23 claim — every logical-FK column is a fresh UUID (unenforced cross-module), the fields
    // M25's D3 auto-match + PR-ledger resolution actually read are real.
    await admin.query(
      `INSERT INTO claim (
         id, organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id,
         tob, service_from, service_to, claim_control_number, payer_claim_control_number,
         mac_jurisdiction, total_charge_cents, sequestration_applied_pct, sequestration_policy_id,
         created_by_membership_id
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $6, $7,
         '811', '2026-01-01', '2026-01-31', $8, $9,
         'ngs_j6', 50000, '2.00', $10,
         $11
       )`,
      [
        REAL_CLAIM_ID,
        ORG,
        PE,
        REAL_PATIENT_ID,
        "00000000-0000-0000-0000-0000000ad001", // admission_id
        "00000000-0000-0000-0000-0000000ec0e1", // election_period_id_from/to
        CLAIM_PAYER_COVERAGE_ID,
        REAL_CCN,
        REAL_ICN,
        "00000000-0000-0000-0000-0000000f0501", // sequestration_policy_id
        "00000000-0000-0000-0000-0000000ba0cb", // created_by_membership_id
      ],
    );
    handle = createDbClient({ connectionString: DB_URL! });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("BEFORE the seam registers, the adapter degrades to no candidates / no patient id (never fabricates a match)", async () => {
    const adapter = buildM23BackedClaimMatchCandidateProvider();
    const candidates = await adapter.candidatesForLine({
      organizationId: ORG,
      providerEntityId: PE,
      payerIcn: REAL_ICN,
    });
    expect(candidates).toEqual([]);
    expect(await adapter.patientIdForClaim(ORG, REAL_CLAIM_ID)).toBeNull();
  });

  it("registers the real M23 ClaimSubmissionReader seam", () => {
    registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(handle.db));
  });

  it("correlates Medicare secondary evidence to the exact range-resolved payer coverage", async () => {
    const reader = buildDrizzleM23ClaimReader(handle.db);
    const scope = {
      providerEntityId: PE,
      admissionId: "00000000-0000-0000-0000-0000000ad001",
      primaryCoverageId: CLAIM_PAYER_COVERAGE_ID,
    };
    const matches = await reader.medicareSecondaryContext(
      ORG,
      REAL_PATIENT_ID,
      { from: "2026-01-01", to: "2026-01-31" },
      scope,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      claimId: REAL_CLAIM_ID,
      patientPayerId: CLAIM_PAYER_COVERAGE_ID,
      rangeRelation: "exact",
    });
    expect(
      await reader.medicareSecondaryContext(
        ORG,
        REAL_PATIENT_ID,
        { from: "2026-01-01", to: "2026-01-31" },
        { ...scope, primaryCoverageId: "00000000-0000-0000-0000-000000000000" },
      ),
    ).toEqual([]);
  });

  it("the adapter now resolves REAL match candidates + the REAL patient id over the bound seam", async () => {
    const adapter = buildM23BackedClaimMatchCandidateProvider();
    const candidates = await adapter.candidatesForLine({
      organizationId: ORG,
      providerEntityId: PE,
      payerIcn: REAL_ICN,
    });
    expect(candidates).toEqual([
      {
        claimId: REAL_CLAIM_ID,
        claimControlNumber: REAL_CCN,
        transmittedControlNumbers: [],
        payerIcn: REAL_ICN,
        serviceFrom: "2026-01-01",
        serviceTo: "2026-01-31",
        totalCharge: 500,
      },
    ]);
    expect(await adapter.patientIdForClaim(ORG, REAL_CLAIM_ID)).toBe(REAL_PATIENT_ID);
    // A different org must never see this org's claim (RLS) — proven by the seam's own withOrgContext,
    // exercised here via a different orgId on the SAME bound seam instance.
    const otherOrgCandidates = await adapter.candidatesForLine({
      organizationId: "99999999-9999-9999-9999-999999999999",
      providerEntityId: PE,
      payerIcn: REAL_ICN,
    });
    expect(otherOrgCandidates).toEqual([]);
  });

  it("a real 835 line auto-matches to the REAL claim end-to-end through M25's ingest pipeline", async () => {
    const objectKey = "minio/real-claim-match.835";
    const isa = "000000901";
    const st = "0901";
    const parsed: ParsedRemittanceAdvice = {
      payerProgram: "medicare",
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      paymentMethod: "eft",
      // An 835 without TRN02 is held (no verifiable payment identity), so a posting fixture carries one.
      checkOrEftTraceNumber: "SYNTHETIC-EFT-TRACE-0001",
      totalPaymentAmount: 450,
      paymentEffectiveDate: "2026-02-10",
      productionDate: "2026-02-10",
      claims: [
        {
          patientControlNumber: REAL_CCN,
          payerIcn: REAL_ICN,
          statusCode: 1,
          totalCharge: 500,
          totalPayment: 450,
          patientResponsibility: 50,
          adjustments: [{ groupCode: "PR", reasonCode: "1", amount: 50 }],
          remarks: [],
          serviceLines: [],
        },
      ],
    };
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: {
        async parse835() {
          return { ok: true, value: parsed } as X12WorkerResult<ParsedRemittanceAdvice>;
        },
        async parse277ca() {
          throw new Error("not used in this test");
        },
      },
      claims: { medicare: buildM23BackedClaimMatchCandidateProvider() },
      terminology: {
        async lookup(carcCode) {
          if (carcCode === "1")
            return { category: "informational", plainLanguage: "patient responsibility" };
          return null;
        },
      },
    });
    const received = await service.receiveAdvice(
      { organizationId: ORG },
      {
        providerEntityId: PE,
        payerId: PAYER,
        payerKind: "medicare",
        minioObjectKey: objectKey,
        fileSha256: sha256Hex(buildRawEdi(isa, st)),
        rawEdi: buildRawEdi(isa, st),
      },
    );
    if (received.outcome !== "queued") throw new Error(`unreachable: ${received.outcome}`);
    const posted = await service.postAdvice({ organizationId: ORG }, received.adviceId);
    expect(posted.outcome).toBe("posted");

    const line = await admin.query(
      "SELECT claim_id, match_state, match_strategy FROM remittance_line WHERE remittance_advice_id=$1",
      [received.adviceId],
    );
    expect(line.rows[0].claim_id).toBe(REAL_CLAIM_ID);
    expect(line.rows[0].match_state).toBe("posted");
    expect(line.rows[0].match_strategy).toBe("payer_icn");

    const ledger = await admin.query(
      "SELECT patient_id, pr_amount FROM patient_responsibility_ledger pl JOIN remittance_line rl ON pl.remittance_line_id = rl.id WHERE rl.remittance_advice_id=$1",
      [received.adviceId],
    );
    expect(ledger.rows[0].patient_id).toBe(REAL_PATIENT_ID);
    expect(Number(ledger.rows[0].pr_amount)).toBe(50);
  });

  // ADR-0053 M23-CM5-T1.2C: a claim sent since external patient control numbers is transmitted (CLM01) under its attempt's external
  // number, and the payer's 835 echoes that number as CLP01, not the claim's internal control number.
  describe("a claim sent under external patient control numbers", () => {
    const SENT_CLAIM_ID = "00000000-0000-0000-0000-0000000ccc02";
    const SENT_PATIENT_ID = "00000000-0000-0000-0000-0000000ee002";
    const SENT_CCN = "SENT-CCN-0002";
    const FIRST_ATTEMPT_PCN = "A1B2C3D4E5F6G7H8J";
    const RETRY_PCN = "K1L2M3N4P5Q6R7S8T";
    const OTHER_PE = "00000000-0000-0000-0000-0000000000a2";

    beforeAll(async () => {
      await admin.query(
        `INSERT INTO claim (
           id, organization_id, provider_entity_id, patient_id, admission_id,
           election_period_id_from, election_period_id_to, patient_payer_id,
           tob, service_from, service_to, claim_control_number,
           mac_jurisdiction, total_charge_cents, sequestration_applied_pct, sequestration_policy_id,
           created_by_membership_id
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $6, $7,
           '811', '2026-03-01', '2026-03-31', $8,
           'ngs_j6', 70000, '2.00', $9,
           $10
         )`,
        [
          SENT_CLAIM_ID,
          ORG,
          PE,
          SENT_PATIENT_ID,
          "00000000-0000-0000-0000-0000000ad002", // admission_id
          "00000000-0000-0000-0000-0000000ec0e2", // election_period_id_from/to
          "00000000-0000-0000-0000-0000000ba0e2", // patient_payer_id
          SENT_CCN,
          "00000000-0000-0000-0000-0000000f0502", // sequestration_policy_id
          "00000000-0000-0000-0000-0000000ba0cb", // created_by_membership_id
        ],
      );
      for (const [attemptIndex, controlNumber] of [
        [0, FIRST_ATTEMPT_PCN],
        [1, RETRY_PCN],
      ] as const) {
        await admin.query(
          `INSERT INTO claim_submission (organization_id, provider_entity_id, kind, claim_id, claim_control_number,
             external_patient_control_number, attempt_index, outcome, reviewed_source_fingerprint)
           VALUES ($1,$2,'claim_837i',$3,$4,$5,$6,'queued',$7)`,
          [ORG, PE, SENT_CLAIM_ID, SENT_CCN, controlNumber, attemptIndex, "a".repeat(64)],
        );
      }
    });

    it("the seam finds the claim by any number it was transmitted under, and returns them all", async () => {
      const adapter = buildM23BackedClaimMatchCandidateProvider();
      for (const patientControlNumber of [FIRST_ATTEMPT_PCN, RETRY_PCN]) {
        const found = await adapter.candidatesForLine({
          organizationId: ORG,
          providerEntityId: PE,
          patientControlNumber,
        });
        expect(found.map((c) => c.claimId)).toEqual([SENT_CLAIM_ID]);
        expect([...(found[0]?.transmittedControlNumbers ?? [])].sort()).toEqual(
          [FIRST_ATTEMPT_PCN, RETRY_PCN].sort(),
        );
        expect(found[0]?.claimControlNumber).toBe(SENT_CCN);
      }
    });

    it("a transmitted number finds nothing under another organization or provider entity", async () => {
      const adapter = buildM23BackedClaimMatchCandidateProvider();
      expect(
        await adapter.candidatesForLine({
          organizationId: "99999999-9999-9999-9999-999999999999",
          providerEntityId: PE,
          patientControlNumber: RETRY_PCN,
        }),
      ).toEqual([]);
      expect(
        await adapter.candidatesForLine({
          organizationId: ORG,
          providerEntityId: OTHER_PE,
          patientControlNumber: RETRY_PCN,
        }),
      ).toEqual([]);
    });

    it("a real 835 whose CLP01 is the transmitted number and that carries no payer ICN auto-matches by patient control number", async () => {
      const isa = "000000902";
      const st = "0902";
      const parsed: ParsedRemittanceAdvice = {
        payerProgram: "medicare",
        interchangeControlNumber: isa,
        transactionSetControlNumber: st,
        checkOrEftTraceNumber: "SYNTHETIC-TRACE-902",
        paymentMethod: "eft",
        totalPaymentAmount: 650,
        paymentEffectiveDate: "2026-04-10",
        productionDate: "2026-04-10",
        claims: [
          {
            patientControlNumber: RETRY_PCN,
            statusCode: 1,
            totalCharge: 700,
            totalPayment: 650,
            patientResponsibility: 50,
            adjustments: [{ groupCode: "PR", reasonCode: "1", amount: 50 }],
            remarks: [],
            serviceLines: [],
          },
        ],
      };
      const service = buildDrizzleM25IngestService(handle.db, {
        payeeNpi: PAYEE_UNCHECKED,
        client: {
          async parse835() {
            return { ok: true, value: parsed } as X12WorkerResult<ParsedRemittanceAdvice>;
          },
          async parse277ca() {
            throw new Error("not used in this test");
          },
        },
        claims: { medicare: buildM23BackedClaimMatchCandidateProvider() },
        terminology: {
          async lookup(carcCode) {
            if (carcCode === "1")
              return { category: "informational", plainLanguage: "patient responsibility" };
            return null;
          },
        },
      });
      const received = await service.receiveAdvice(
        { organizationId: ORG },
        {
          providerEntityId: PE,
          payerId: PAYER,
          payerKind: "medicare",
          minioObjectKey: "minio/sent-under-external-pcn.835",
          fileSha256: sha256Hex(buildRawEdi(isa, st)),
          rawEdi: buildRawEdi(isa, st),
        },
      );
      if (received.outcome !== "queued") throw new Error(`unreachable: ${received.outcome}`);
      const posted = await service.postAdvice({ organizationId: ORG }, received.adviceId);
      expect(posted.outcome).toBe("posted");

      const line = await admin.query(
        "SELECT claim_id, match_state, match_strategy FROM remittance_line WHERE remittance_advice_id=$1",
        [received.adviceId],
      );
      expect(line.rows[0].claim_id).toBe(SENT_CLAIM_ID);
      expect(line.rows[0].match_state).toBe("posted");
      expect(line.rows[0].match_strategy).toBe("patient_control");
    });
  });
});
