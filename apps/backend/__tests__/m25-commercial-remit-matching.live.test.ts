/**
 * #725 (ADR-0100 D8, M25 D9 "Commercial Phase 2") - commercial 835 matching, LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role, through the REAL registered `CommercialClaimReader` seam and the REAL ingest pipeline
 * (no hand-rolled claims double).
 *
 *   S15  a commercial 835 for a submitted claim of the SAME tenant, provider entity and payer binds and posts exactly once:
 *        a redelivered file is a duplicate and a second post is a no-op.
 *   S19  an advice for another PAYER, another TENANT, or a claim that cannot be paid (draft) quarantines: the line is
 *        unmatched (manual review), nothing posts, no ledger row, the claim is untouched.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:commercial-remit-matching:live
 * (SUPERUSER to a THROWAWAY db on a PRIVATE pgvector/pgvector:pg18 - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { createX12835Client } from "@chartwarden/x12-835-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { buildM41BackedClaimMatchCandidateProvider } from "../src/modules/25-remittance/index";
import {
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
} from "../src/modules/25-remittance/ingest/service-drizzle";
import { buildCommercialClaimReader } from "../src/modules/41-billing-commercial";
import { buildFullEdi, sha256Hex } from "./_edi835-fixture";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "00000000-0000-4000-8000-0000000725a1";
const ORG_B = "00000000-0000-4000-8000-0000000725b1";

describe.skipIf(!DB_URL)("M25 commercial 835 matching (#725) - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let peA: string;
  let peB: string;
  let isaSeq = 725000;

  async function provider(org: string, ccn: string, npi: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'Synthetic Hospice',$3,'\\x00','12-31') RETURNING id`,
        [org, ccn, npi],
      )
    ).rows[0].id as string;
  }

  async function newPayer(): Promise<string> {
    return (
      await admin.query(
        "INSERT INTO payer (kind, name) VALUES ('commercial'::payer_kind, $1) RETURNING id",
        [`Synthetic Commercial ${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id as string;
  }

  /** A claim of `org`/`pe` under a fresh plan of `payerId` in `state`. */
  async function seedClaim(o: {
    org: string;
    pe: string;
    payerId: string;
    ccn: string;
    state: string;
    from?: string;
    to?: string;
    planId?: string;
  }): Promise<{ claimId: string; patientId: string; planId: string }> {
    const planId =
      o.planId ??
      ((
        await admin.query(
          `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, authorization_requirement, effective_from)
           VALUES ($1,$2,'Synthetic PPO','CI','not_required','2026-01-01') RETURNING id`,
          [o.org, o.payerId],
        )
      ).rows[0].id as string);
    const patientId = randomUUID();
    const claimId = (
      await admin.query(
        `INSERT INTO commercial_claim (organization_id, provider_entity_id, patient_id, admission_id, plan_id, primary_patient_payer_id,
           claim_filing_indicator, tob, frequency_code, service_from, service_to, admission_date, patient_status_code,
           claim_control_number, total_charge_cents, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'CI','811','1',$9,$10,'2026-01-01','30',$7,50000,$8) RETURNING id`,
        [
          o.org,
          o.pe,
          patientId,
          randomUUID(),
          planId,
          randomUUID(),
          o.ccn,
          randomUUID(),
          o.from ?? "2026-03-01",
          o.to ?? "2026-03-31",
        ],
      )
    ).rows[0].id as string;
    // The database enforces the legal path (M41_CLAIM_ILLEGAL_TRANSITION), so walk it.
    const path: Record<string, string[]> = {
      draft: [],
      ready: ["ready"],
      void: ["void"],
      submitted: ["ready", "submitted"],
      accepted: ["ready", "submitted", "accepted"],
      rejected: ["ready", "submitted", "rejected"],
    };
    for (const to of path[o.state] ?? []) {
      await admin.query(
        `UPDATE commercial_claim SET state='${to}', ready_at = CASE WHEN '${to}' IN ('draft','void') THEN NULL ELSE coalesce(ready_at, now()) END WHERE id=$1`,
        [claimId],
      );
    }
    return { claimId, patientId, planId };
  }

  /** Receive then post a one-claim commercial 835 as `org`/`pe` for `payerId`; optionally redeliver and re-post. */
  async function deliver(o: {
    org: string;
    pe: string;
    payerId: string;
    ccn: string;
    redeliver?: boolean;
  }) {
    isaSeq += 1;
    const isa = String(isaSeq);
    const st = String(isaSeq).slice(-4);
    const raw = buildFullEdi(isa, st, "450.00", {
      clp01: o.ccn,
      icn: `ICN-${isa}`,
      charge: "500.00",
      paid: "450.00",
      patientResponsibility: "50.00",
    });
    const service = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: createX12835Client(),
      rawStore: { put: async () => {}, get: async () => raw, delete: async () => {} },
      terminology: {
        lookup: async () => ({
          category: "informational",
          plainLanguage: "patient responsibility",
        }),
      },
      claims: { commercial: buildM41BackedClaimMatchCandidateProvider() },
    });
    const input = {
      providerEntityId: o.pe,
      payerId: o.payerId,
      payerKind: "commercial" as const,
      minioObjectKey: `minio/${isa}.835`,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    };
    const actor = { organizationId: o.org };
    const first = await service.receiveAdvice(actor, input);
    if (first.outcome !== "queued") throw new Error(`unexpected receive ${first.outcome}`);
    const posted = await service.postAdvice(actor, first.adviceId);
    const second = o.redeliver ? await service.receiveAdvice(actor, input) : undefined;
    const repost = o.redeliver ? await service.postAdvice(actor, first.adviceId) : undefined;
    return { adviceId: first.adviceId, posted, second, repost };
  }

  const lines = async (adviceId: string) =>
    (
      await admin.query(
        "SELECT id, match_state, claim_id FROM remittance_line WHERE remittance_advice_id=$1",
        [adviceId],
      )
    ).rows;
  const ledgerRows = async (adviceId: string) =>
    (
      await admin.query(
        `SELECT pl.patient_id FROM patient_responsibility_ledger pl JOIN remittance_line rl ON pl.remittance_line_id = rl.id
         WHERE rl.remittance_advice_id=$1`,
        [adviceId],
      )
    ).rows;
  const linesOnClaim = async (claimId: string) =>
    (
      await admin.query("SELECT count(*)::int AS n FROM remittance_line WHERE claim_id=$1", [
        claimId,
      ])
    ).rows[0].n as number;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "m25c-a"],
      [ORG_B, "m25c-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    }
    peA = await provider(ORG_A, "725001", "1234567893");
    peB = await provider(ORG_B, "725002", "1999999984");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // The registration production boot makes (`registerM41PublishedSeams`), over the app-role connection.
    registerSeam("CommercialClaimReader", buildCommercialClaimReader(handle.db));
  }, 600_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("S15: binds the submitted claim and posts exactly once; redelivery and a second post change nothing", async () => {
    const payerId = await newPayer();
    const { claimId, patientId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-S15-1",
      state: "accepted",
    });
    const r = await deliver({ org: ORG_A, pe: peA, payerId, ccn: "CCN-S15-1", redeliver: true });

    expect(r.posted).toMatchObject({
      outcome: "posted",
      postedLineCount: 1,
      unmatchedLineCount: 0,
    });
    const rows = await lines(r.adviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ match_state: "posted", claim_id: claimId });
    // The patient resolved through the real seam for the patient-responsibility ledger.
    expect((await ledgerRows(r.adviceId)).map((x) => x.patient_id)).toEqual([patientId]);
    expect(r.second?.outcome).not.toBe("queued");
    expect(r.repost?.outcome).toBe("already_posted");
    expect(await linesOnClaim(claimId)).toBe(1);
  });

  it("S19 wrong payer: an advice of another payer finds no candidate; nothing posts", async () => {
    const claimPayer = await newPayer();
    const otherPayer = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId: claimPayer,
      ccn: "CCN-S19-P",
      state: "accepted",
    });
    const r = await deliver({ org: ORG_A, pe: peA, payerId: otherPayer, ccn: "CCN-S19-P" });

    expect(r.posted).toMatchObject({
      outcome: "partial_posted",
      postedLineCount: 0,
      unmatchedLineCount: 1,
    });
    expect((await lines(r.adviceId))[0]).toMatchObject({
      match_state: "unmatched",
      claim_id: null,
    });
    expect(await ledgerRows(r.adviceId)).toHaveLength(0);
    expect(await linesOnClaim(claimId)).toBe(0);
  });

  it("S19 wrong tenant: another tenant's advice never matches this tenant's claim, and the seam is RLS-scoped", async () => {
    const payerId = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-S19-T",
      state: "accepted",
    });
    // Tenant B receives an advice naming A's control number and A's payer id (the strongest forgery).
    const r = await deliver({ org: ORG_B, pe: peB, payerId, ccn: "CCN-S19-T" });

    expect(r.posted).toMatchObject({
      outcome: "partial_posted",
      postedLineCount: 0,
      unmatchedLineCount: 1,
    });
    expect((await lines(r.adviceId))[0]).toMatchObject({
      match_state: "unmatched",
      claim_id: null,
    });
    expect(await ledgerRows(r.adviceId)).toHaveLength(0);
    expect(await linesOnClaim(claimId)).toBe(0);
    const reader = buildCommercialClaimReader(handle.db);
    const key = { claimControlNumber: "CCN-S19-T" };
    // As tenant B, A's provider entity, claim and patient are invisible; and A with B's entity is empty too.
    expect(await reader.candidatesForLine(ORG_B, peA, payerId, key)).toEqual([]);
    expect(await reader.patientIdForClaim(ORG_B, claimId)).toBeNull();
    expect(await reader.candidatesForLine(ORG_A, peB, payerId, key)).toEqual([]);
    // Control: the owner does see it.
    expect(await reader.candidatesForLine(ORG_A, peA, payerId, key)).toHaveLength(1);
  });

  it("a claim that was never sent (draft, ready, rejected, void) is not a candidate", async () => {
    for (const state of ["draft", "ready", "rejected", "void"]) {
      const payerId = await newPayer();
      const ccn = `CCN-NP-${state.toUpperCase()}`;
      const { claimId } = await seedClaim({ org: ORG_A, pe: peA, payerId, ccn, state });
      const r = await deliver({ org: ORG_A, pe: peA, payerId, ccn });
      expect(r.posted, state).toMatchObject({ outcome: "partial_posted", postedLineCount: 0 });
      expect(await linesOnClaim(claimId), state).toBe(0);
    }
  });
});
