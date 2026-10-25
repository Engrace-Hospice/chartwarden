/**
 * Billing E2E S07 (#712) + S09 (#715) - golden 835 posting and the supplemental-835-after-appeal path, LIVE Postgres.
 *
 * Everything here is synthetic. The raw 835 text goes through the REAL in-process parser (which already refuses an
 * unbalanced file), the REAL `receiveAdvice`/`postAdvice` pair, the REAL M23 claim bridge, the REAL catalog-validating
 * outbox publisher and (S09) the REAL M23 remittance consumer behind the REAL dispatcher, all as the NOBYPASSRLS
 * `chartwarden_app` role.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:835-golden:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { createX12835Client } from "@chartwarden/x12-835-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M23_OUTBOX_EVENTS,
  buildM23RemittanceConsumer,
} from "../src/modules/23-billing-medicare/index";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import {
  M25_OUTBOX_EVENTS,
  buildDrizzleM25ReadService,
  buildM23BackedClaimMatchCandidateProvider,
} from "../src/modules/25-remittance/index";
import type {
  RawAdviceStore,
  ReceiveAdviceResult,
  TerminologyLookupPort,
} from "../src/modules/25-remittance/ingest/service";
import {
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
} from "../src/modules/25-remittance/ingest/service-drizzle";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { buildRawEdi, sha256Hex } from "./_edi835-fixture";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ORG = "11111111-1111-1111-1111-111111111177";
const PE_OTHER = "00000000-0000-0000-0000-0000000000b7";
const PAYER = "00000000-0000-0000-0000-00000000fee7";
const ACTOR = { organizationId: ORG };

/** CARC -> category, as the M38 catalog would answer. */
const TERMINOLOGY: TerminologyLookupPort = {
  async lookup(carc) {
    const table: Record<string, string> = {
      "45": "reduction",
      "1": "informational",
      "2": "informational",
      "23": "informational",
      "50": "denial",
    };
    const category = table[carc];
    return category ? { category, plainLanguage: carc } : null;
  },
};

/** A complete ISA..IEA 835 around `body` (BPR is built from `bpr`). */
function era(
  isa13: string,
  st02: string,
  bpr: string,
  body: readonly string[],
  plb?: string,
  trn = `EFT-${isa13}`,
) {
  const segs = [
    `BPR*I*${bpr}*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615`,
    `TRN*1*${trn}*1512345678`,
    "N1*PR*SYNTHETIC MAC",
    "N1*PE*SYNTH HOSPICE",
    ...body,
    ...(plb ? [plb] : []),
  ];
  return `${buildRawEdi(isa13, st02)}${segs.map((x) => `${x}~`).join("")}SE*${segs.length + 2}*${st02}~GE*1*1~IEA*1*${isa13.padStart(9, "0")}~`;
}

describe.skipIf(!DB_URL)("S07/S09 golden 835 posting and supplemental 835 - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let ingest: ReturnType<typeof buildDrizzleM25IngestService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let providerEntityId = "";
  let actor: {
    organizationId: string;
    userId: string;
    membershipId: string;
    roles: string[];
    stepUpRecent: boolean;
  };
  const staged = new Map<string, string>();
  const rawStore: RawAdviceStore = {
    async put(_o, id, text) {
      staged.set(id, text);
    },
    async get(_o, id) {
      return staged.get(id) ?? null;
    },
    async delete(_o, id) {
      staged.delete(id);
    },
  };

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

  async function seedClaim(ccn: string, state: string, patientId = randomUUID()): Promise<string> {
    const claim = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      new repositories.ClaimRepository(tx).create({
        organizationId: ORG,
        providerEntityId,
        patientId,
        admissionId: randomUUID(),
        electionPeriodIdFrom: randomUUID(),
        electionPeriodIdTo: randomUUID(),
        patientPayerId: randomUUID(),
        tob: "812",
        serviceFrom: "2026-03-01",
        serviceTo: "2026-03-31",
        claimControlNumber: ccn,
        payerClaimControlNumber: null,
        macJurisdiction: "ngs_j6",
        sequestrationAppliedPct: "2.00",
        sequestrationPolicyId: randomUUID(),
        createdByMembershipId: randomUUID(),
        totalChargeCents: 100_000,
      }),
    );
    await admin.query("UPDATE claim SET state = $2 WHERE id = $1", [claim.id, state]);
    return claim.id;
  }

  /** receive + post one 835 text through the real service. */
  async function postEra(raw: string, key: string) {
    const received: ReceiveAdviceResult = await ingest.receiveAdvice(ACTOR, {
      providerEntityId,
      payerId: PAYER,
      payerKind: "medicare",
      minioObjectKey: key,
      fileSha256: sha256Hex(raw),
      rawEdi: raw,
    });
    if (received.outcome !== "queued") return { received, posted: null };
    return { received, posted: await ingest.postAdvice(ACTOR, received.adviceId) };
  }

  const one = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows[0];
  const rows = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const stateOf = async (claimId: string) =>
    (await one("SELECT state FROM claim WHERE id=$1", [claimId])).state as string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-g','G','G')",
      [ORG],
    );
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('m25golden@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, ORG],
      )
    ).rows[0].id as string;
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-GLD','GLD','NPI-GLD','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    actor = { organizationId: ORG, userId, membershipId, roles: ["billing_manager"], stepUpRecent: true };

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(handle.db));

    const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS, M25_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const asModule = (callerModule: "m23" | "m25") => ({
      publish: (tx: unknown, input: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...input, callerModule } as never),
    });
    ingest = buildDrizzleM25IngestService(handle.db, {
      payeeNpi: PAYEE_UNCHECKED,
      client: createX12835Client(),
      rawStore,
      terminology: TERMINOLOGY,
      claims: { medicare: buildM23BackedClaimMatchCandidateProvider() },
      outbox: asModule("m25") as never,
    });
    const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG }] };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      eventCatalog: catalog,
      consumers: [
        buildM23RemittanceConsumer({ db: handle.db, outbox: asModule("m23") as never }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ---------------------------------------------------------------------------------------------
  // S07
  // ---------------------------------------------------------------------------------------------
  describe("S07 partial payment, CAS combinations, recoupment, split service line", () => {
    const GOLDEN = era("000007001", "0001", "980.00", [
      // A: partial payment, CO + PR groups with two PR reasons in one CAS segment.
      "CLP*PCN-G-A*1*1000.00*800.00*50.00*MC*ICN-G-A",
      "CAS*CO*45*150.00",
      "CAS*PR*1*30.00**2*20.00",
      // B: split service line, three group/reason pairs across two lines.
      "CLP*PCN-G-B*1*600.00*400.00*0.00*MC*ICN-G-B",
      "SVC*HC:T1005*350.00*250.00",
      "CAS*CO*45*100.00",
      "SVC*HC:T1005*250.00*150.00",
      "CAS*CO*45*60.00",
      "CAS*OA*23*40.00",
      // C: recoupment of an earlier payment (CLP02 = 22, negative amounts).
      "CLP*PCN-G-C*22*-500.00*-500.00*0.00*MC*ICN-G-C",
      // D: a line whose claim is not on file, with a PR amount.
      "CLP*PCN-G-D*1*300.00*280.00*20.00*MC*ICN-G-D",
      "CAS*PR*1*20.00",
    ]);
    let adviceId = "";
    let claimA = "";

    it("posts the file: matched lines posted, the recoupment reversed, the unknown claim left unmatched", async () => {
      claimA = await seedClaim("PCN-G-A", "ACK_ACCEPTED");
      await seedClaim("PCN-G-B", "ACK_ACCEPTED");
      await seedClaim("PCN-G-C", "PAID");

      const { received, posted } = await postEra(GOLDEN, "minio/golden-1.835");

      expect(received).toMatchObject({ outcome: "queued" });
      expect(posted).toMatchObject({ outcome: "partial_posted", postedLineCount: 3, unmatchedLineCount: 1 });
      adviceId = (received as { adviceId: string }).adviceId;
      const states = await rows(
        "SELECT clp01_patient_control_number AS pcn, match_state FROM remittance_line WHERE remittance_advice_id=$1 ORDER BY 1",
        [adviceId],
      );
      expect(states).toEqual([
        { pcn: "PCN-G-A", match_state: "posted" },
        { pcn: "PCN-G-B", match_state: "posted" },
        { pcn: "PCN-G-C", match_state: "reversed" },
        { pcn: "PCN-G-D", match_state: "unmatched" },
      ]);
    });

    it("the ledger balances to the BPR total: sum of line payments (recoupment negative) = BPR02", async () => {
      const sums = await one(
        `SELECT a.total_payment_amount::numeric AS bpr, a.plb_total_amount::numeric AS plb,
                sum(l.clp04_total_payment_amount)::numeric AS paid
           FROM remittance_advice a JOIN remittance_line l ON l.remittance_advice_id = a.id
          WHERE a.id=$1 GROUP BY a.total_payment_amount, a.plb_total_amount`,
        [adviceId],
      );
      expect(Number(sums.bpr)).toBe(980);
      expect(Number(sums.paid) - Number(sums.plb)).toBe(Number(sums.bpr));
    });

    it("every line balances: charge - payment = claim-level CAS + service-line CAS", async () => {
      const lines = await rows(
        `SELECT l.clp01_patient_control_number AS pcn,
                (l.clp03_total_charge_amount - l.clp04_total_payment_amount)::numeric AS gap,
                (COALESCE((SELECT sum(adjustment_amount) FROM remittance_adjustment x WHERE x.remittance_line_id = l.id), 0)
                 + COALESCE((SELECT sum(x.adjustment_amount) FROM remittance_adjustment x
                               JOIN remittance_service_line s ON x.remittance_service_line_id = s.id
                              WHERE s.remittance_line_id = l.id), 0))::numeric AS cas
           FROM remittance_line l WHERE l.remittance_advice_id=$1 ORDER BY 1`,
        [adviceId],
      );
      expect(lines.map((r) => [r.pcn, Number(r.gap), Number(r.cas)])).toEqual([
        ["PCN-G-A", 200, 200],
        ["PCN-G-B", 200, 200],
        ["PCN-G-C", 0, 0],
        ["PCN-G-D", 20, 20],
      ]);
    });

    it("keeps each group/reason pair and routes it (CO/PR/OA/PR-on-unmatched)", async () => {
      const adj = await rows(
        `SELECT cas_group_code AS g, cas_reason_code AS r, post_action AS action, count(*)::int AS n,
                sum(adjustment_amount)::numeric AS amt
           FROM remittance_adjustment WHERE (remittance_line_id IN (SELECT id FROM remittance_line WHERE remittance_advice_id=$1)
              OR remittance_service_line_id IN (SELECT s.id FROM remittance_service_line s
                    JOIN remittance_line l ON s.remittance_line_id = l.id WHERE l.remittance_advice_id=$1))
          GROUP BY 1,2,3 ORDER BY 1,2,4 DESC,3 DESC`,
        [adviceId],
      );
      expect(adj.map((r) => [r.g, r.r, r.action, r.n, Number(r.amt)].join("|")).sort()).toEqual([
        "CO|45|auto_posted|3|310",
        "OA|23|flagged_review|1|40",
        "PR|1|ledger_recorded|1|30",
        "PR|1|flagged_review|1|20", // the unmatched line has no patient, so no ledger entry
        "PR|2|ledger_recorded|1|20",
      ].sort());
    });

    it("the patient-responsibility ledger equals CLP05 of the matched lines, and the split line keeps both service lines", async () => {
      const pr = await one(
        `SELECT COALESCE(sum(pr_amount),0)::numeric AS pr FROM patient_responsibility_ledger
          WHERE remittance_line_id IN (SELECT id FROM remittance_line WHERE remittance_advice_id=$1)`,
        [adviceId],
      );
      const clp05 = await one(
        `SELECT sum(clp05_patient_responsibility_amount)::numeric AS pr FROM remittance_line
          WHERE remittance_advice_id=$1 AND match_state IN ('posted','reversed')`,
        [adviceId],
      );
      expect(Number(pr.pr)).toBe(Number(clp05.pr));
      const svc = await rows(
        `SELECT svc02_charge_amount::numeric AS charge, svc03_paid_amount::numeric AS paid
           FROM remittance_service_line s JOIN remittance_line l ON s.remittance_line_id = l.id
          WHERE l.remittance_advice_id=$1 AND l.clp01_patient_control_number='PCN-G-B' ORDER BY 1 DESC`,
        [adviceId],
      );
      expect(svc.map((r) => [Number(r.charge), Number(r.paid)])).toEqual([[350, 250], [250, 150]]);
    });

    it("emits one posting event per matched line: partial, partial, recouped (no event for the unmatched line)", async () => {
      const ev = await rows(
        `SELECT event_type, count(*)::int AS n FROM outbox_event
          WHERE event_type LIKE 'm25.remittance.claim_%' AND payload->>'remittanceAdviceId'=$1
          GROUP BY 1 ORDER BY 1`,
        [adviceId],
      );
      expect(ev).toEqual([
        { event_type: "m25.remittance.claim_partial_paid", n: 2 },
        { event_type: "m25.remittance.claim_recouped", n: 1 },
      ]);
    });

    it("every unmatched line has an owner (its provider entity) and a determinable reason, and is on the worklist", async () => {
      const un = await rows(
        `SELECT l.id, l.claim_id, l.match_strategy, l.clp01_patient_control_number AS pcn, l.clp07_payer_icn AS icn,
                l.unmatched_reason AS reason, a.provider_entity_id AS owner
           FROM remittance_line l JOIN remittance_advice a ON a.id = l.remittance_advice_id
          WHERE l.match_state='unmatched' AND l.remittance_advice_id=$1`,
        [adviceId],
      );
      expect(un).toHaveLength(1);
      const read = buildDrizzleM25ReadService(handle.db, TERMINOLOGY as never);
      const readActor = { organizationId: ORG, userId: actor.userId } as never;
      const mine = await read.listUnmatched(readActor, providerEntityId, undefined, 50);
      const other = await read.listUnmatched(readActor, PE_OTHER, undefined, 50);
      for (const u of un) {
        expect(u.owner).toBe(providerEntityId);
        expect(u.claim_id).toBeNull(); // reason: no candidate claim under this control number / ICN
        expect(u.match_strategy).toBeNull();
        expect(u.reason).toBe("no_candidate"); // stored, not just derivable
        expect(u.pcn && u.icn).toBeTruthy(); // identifiers kept so the worklist can propose a claim
        expect(mine.items.map((i: { id: string }) => i.id)).toContain(u.id);
        expect(other.items.map((i: { id: string }) => i.id)).not.toContain(u.id);
      }
    });

    it("replay posts nothing twice: the same file is a duplicate, a redelivered post is a no-op", async () => {
      const before = await one(
        `SELECT (SELECT count(*) FROM remittance_line)::int AS lines,
                (SELECT count(*) FROM remittance_adjustment)::int AS adj,
                (SELECT count(*) FROM patient_responsibility_ledger)::int AS pr,
                (SELECT count(*) FROM outbox_event WHERE event_type LIKE 'm25.remittance.%')::int AS ev`,
      );

      const again = await postEra(GOLDEN, "minio/golden-1-resend.835");
      const redelivered = await ingest.postAdvice(ACTOR, adviceId);

      expect(again.received).toEqual({ outcome: "duplicate", existingAdviceId: adviceId });
      expect(redelivered).toEqual({ outcome: "already_posted", adviceId });
      const after = await one(
        `SELECT (SELECT count(*) FROM remittance_line)::int AS lines,
                (SELECT count(*) FROM remittance_adjustment)::int AS adj,
                (SELECT count(*) FROM patient_responsibility_ledger)::int AS pr,
                (SELECT count(*) FROM outbox_event WHERE event_type LIKE 'm25.remittance.%')::int AS ev`,
      );
      expect(after).toEqual(before);
    });

    it("a provider-level recoupment (PLB) is persisted, so the ledger (lines minus PLB) balances to the BPR total", async () => {
      await seedClaim("PCN-G-E", "ACK_ACCEPTED");
      const raw = era(
        "000007002",
        "0002",
        "780.00",
        ["CLP*PCN-G-E*1*900.00*900.00*0.00*MC*ICN-G-E"],
        "PLB*1512345678*20261231*WO:OVR7002*120.00",
      );

      const { posted, received } = await postEra(raw, "minio/golden-plb.835");

      expect(posted).toMatchObject({ outcome: "posted", postedLineCount: 1 });
      const r = await one(
        `SELECT a.total_payment_amount::numeric AS bpr, a.plb_total_amount::numeric AS plb,
                sum(l.clp04_total_payment_amount)::numeric AS paid
           FROM remittance_advice a JOIN remittance_line l ON l.remittance_advice_id=a.id
          WHERE a.id=$1 GROUP BY 1,2`,
        [(received as { adviceId: string }).adviceId],
      );
      expect(Number(r.plb)).toBe(120); // the provider-level recoupment is persisted on the advice
      expect(Number(r.paid) - Number(r.plb)).toBe(Number(r.bpr));
    });

    it("an unbalanced file is refused before anything is stored", async () => {
      const bad = era("000007003", "0003", "100.00", ["CLP*PCN-G-X*1*500.00*400.00*0.00*MC*ICN-X"]);
      const before = Number((await one("SELECT count(*)::int AS n FROM remittance_advice")).n);

      const { received } = await postEra(bad, "minio/golden-bad.835");

      expect(received.outcome).toBe("malformed");
      expect(Number((await one("SELECT count(*)::int AS n FROM remittance_advice")).n)).toBe(before);
    });

    it("a clearinghouse resend under NEW ISA/ST control numbers but the same TRN, payer and amount posts nothing twice", async () => {
      await seedClaim("PCN-G-R", "ACK_ACCEPTED");
      const body = ["CLP*PCN-G-R*1*250.00*250.00*0.00*MC*ICN-G-R"];
      const first = await postEra(era("000007101", "0001", "250.00", body, undefined, "CHK-RESEND-1"), "minio/resend-1.835");
      const counts = () =>
        one(`SELECT (SELECT count(*) FROM remittance_advice)::int AS adv, (SELECT count(*) FROM remittance_line)::int AS lines,
                    (SELECT count(*) FROM outbox_event WHERE event_type='m25.remittance.claim_paid')::int AS ev`);
      const before = await counts();

      const resend = await postEra(era("000007102", "0007", "250.00", body, undefined, "CHK-RESEND-1"), "minio/resend-2.835");

      expect(first.posted).toMatchObject({ outcome: "posted" });
      expect(resend.received).toEqual({
        outcome: "duplicate",
        existingAdviceId: (first.received as { adviceId: string }).adviceId,
      });
      expect(await counts()).toEqual(before);
    });

    it("the same TRN with a different amount, or a different TRN with the same content, is a new payment", async () => {
      await seedClaim("PCN-G-S", "ACK_ACCEPTED");
      const a = await postEra(
        era("000007103", "0001", "100.00", ["CLP*PCN-G-S*1*100.00*100.00*0.00*MC*ICN-G-S"], undefined, "CHK-SAME"),
        "minio/trn-a.835",
      );
      const b = await postEra(
        era("000007104", "0001", "40.00", ["CLP*PCN-G-S*1*40.00*40.00*0.00*MC*ICN-G-S2"], undefined, "CHK-SAME"),
        "minio/trn-b.835",
      );
      const c = await postEra(
        era("000007105", "0001", "100.00", ["CLP*PCN-G-S*1*100.00*100.00*0.00*MC*ICN-G-S"], undefined, "CHK-OTHER"),
        "minio/trn-c.835",
      );
      expect([a.received.outcome, b.received.outcome, c.received.outcome]).toEqual(["queued", "queued", "queued"]);
    });

    it("keeps claim A's state: a partial payment lands once", async () => {
      await dispatcher.tick();
      expect(await stateOf(claimA)).toBe("PARTIAL_PAID");
    });
  });

  // ---------------------------------------------------------------------------------------------
  // S09
  // ---------------------------------------------------------------------------------------------
  describe("S09 denial -> appeal -> supplemental 835", () => {
    const write = () =>
      buildDrizzleM25WriteService(handle.db, {
        publish: (tx: unknown, input: Record<string, unknown>) =>
          buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS])).publish(
            tx as never,
            { ...input, callerModule: "m25" } as never,
          ),
      } as never);

    it("a supplemental payment moves a denied claim to PAID, closes the denial as won on appeal, and rewrites no history", async () => {
      const claimId = await seedClaim("PCN-S09", "ACK_ACCEPTED");
      const denial = era("000009001", "0001", "0.00", [
        "CLP*PCN-S09*4*1000.00*0.00*0.00*MC*ICN-S09",
        "CAS*CO*50*1000.00",
      ]);
      const first = await postEra(denial, "minio/s09-denial.835");
      expect(first.posted).toMatchObject({ outcome: "posted" });
      await dispatcher.tick();
      expect(await stateOf(claimId)).toBe("DENIED");

      const denialCase = await one(
        "SELECT id, version, remittance_line_id, carc_code, dollar_value::numeric AS value FROM denial_case WHERE claim_id=$1",
        [claimId],
      );
      const originalLine = await one(
        "SELECT * FROM remittance_line WHERE id=$1",
        [denialCase.remittance_line_id],
      );
      const originalAdjustments = await rows(
        "SELECT id, cas_group_code, cas_reason_code, adjustment_amount::numeric AS amt FROM remittance_adjustment WHERE remittance_line_id=$1",
        [denialCase.remittance_line_id],
      );

      // The appeal is filed and won through the real write path (start -> escalate -> appeal -> decide).
      const w = write();
      let v = (await w.startDenial(actor as never, denialCase.id, denialCase.version)).version;
      v = (await w.escalateDenial(actor as never, denialCase.id, { reason: "needs appeal" } as never, v)).version;
      const appeal = await w.createAppeal(actor as never, denialCase.id, {});
      expect((await one("SELECT state FROM denial_case WHERE id=$1", [denialCase.id])).state).toBe("appealed");
      const appealId = appeal.id;
      // Submission needs the packet seams and evidence documents (covered by m25-appeal-packet.live); here the
      // draft is moved to under_review directly so the decision itself goes through the real service.
      await admin.query("UPDATE appeal_case SET state='under_review' WHERE id=$1", [appealId]);
      await w.decideAppeal(
        actor as never,
        appealId,
        { outcome: "favorable", decidedAt: new Date().toISOString() } as never,
        appeal.version,
      );

      // The supplemental 835 arrives under a new control number and pays the claim.
      const supplemental = era("000009002", "0001", "1000.00", [
        "CLP*PCN-S09*1*1000.00*1000.00*0.00*MC*ICN-S09",
      ]);
      const second = await postEra(supplemental, "minio/s09-supplemental.835");
      expect(second.posted).toMatchObject({ outcome: "posted" });
      await dispatcher.tick();

      // Financial position: the extra payment is reflected, the claim is paid.
      expect(await stateOf(claimId)).toBe("PAID");
      const paid = await one(
        `SELECT sum(clp04_total_payment_amount)::numeric AS paid, count(*)::int AS n FROM remittance_line WHERE claim_id=$1`,
        [claimId],
      );
      expect(Number(paid.paid)).toBe(1000);
      expect(paid.n).toBe(2);
      const history = await rows(
        "SELECT from_state, to_state FROM claim_state_history WHERE claim_id=$1 ORDER BY at, id",
        [claimId],
      );
      expect(history.map((h) => `${h.from_state}>${h.to_state}`)).toEqual([
        "ACK_ACCEPTED>DENIED",
        "DENIED>PAID",
      ]);
      const paidEvents = await rows(
        "SELECT payload FROM outbox_event WHERE event_type='m23.claim.paid' AND payload->>'claimId'=$1",
        [claimId],
      );
      expect(paidEvents).toHaveLength(1);
      expect(paidEvents[0].payload.paidAmountCents).toBe(100_000);

      // Denial case: resolved via the appeal, then closed. The original evidence is untouched.
      const dc = await one("SELECT state, version FROM denial_case WHERE id=$1", [denialCase.id]);
      await write().resolveDenial(actor as never, denialCase.id, { reason: "appeal won" } as never, dc.version);
      const resolved = await one("SELECT state, version, closure_outcome FROM denial_case WHERE id=$1", [denialCase.id]);
      expect(resolved).toMatchObject({ state: "resolved", closure_outcome: "resolved_via_appeal" });
      await write().closeDenial(actor as never, denialCase.id, resolved.version);
      const closed = await one(
        "SELECT state, carc_code, remittance_line_id, dollar_value::numeric AS value FROM denial_case WHERE id=$1",
        [denialCase.id],
      );
      expect(closed).toMatchObject({
        state: "closed",
        carc_code: denialCase.carc_code,
        remittance_line_id: denialCase.remittance_line_id,
      });
      expect(Number(closed.value)).toBe(Number(denialCase.value));
      expect(await one("SELECT * FROM remittance_line WHERE id=$1", [denialCase.remittance_line_id])).toEqual(originalLine);
      expect(
        await rows(
          "SELECT id, cas_group_code, cas_reason_code, adjustment_amount::numeric AS amt FROM remittance_adjustment WHERE remittance_line_id=$1",
          [denialCase.remittance_line_id],
        ),
      ).toEqual(originalAdjustments);
      const events = await rows("SELECT event_kind FROM appeal_case_event WHERE appeal_case_id=$1", [appealId]);
      expect(events.map((e) => e.event_kind)).toContain("decided");
    });

    it("a supplemental payment for the underpaid portion moves PARTIAL_PAID to PAID", async () => {
      const claimId = await seedClaim("PCN-S09B", "ACK_ACCEPTED");
      await admin.query(
        `INSERT INTO claim_line (organization_id, claim_id, line_number, revenue_code, q_code, level_of_care,
           service_date_from, service_date_to, unit_count, unit_rate_cents, line_charge_cents, level_of_care_period_id)
         VALUES ($1,$2,1,'0651','Q5001','RHC','2026-03-01','2026-03-31',30,3333,99990,$1)`,
        [ORG, claimId],
      );
      await postEra(
        era("000009003", "0001", "700.00", [
          "CLP*PCN-S09B*1*1000.00*700.00*0.00*MC*ICN-S09B",
          "CAS*CO*45*300.00",
        ]),
        "minio/s09b-partial.835",
      );
      await dispatcher.tick();
      expect(await stateOf(claimId)).toBe("PARTIAL_PAID");

      await postEra(
        era("000009004", "0001", "300.00", ["CLP*PCN-S09B*1*300.00*300.00*0.00*MC*ICN-S09B"]),
        "minio/s09b-supplemental.835",
      );
      await dispatcher.tick();

      expect(await stateOf(claimId)).toBe("PAID");
      const paid = await one(
        "SELECT sum(clp04_total_payment_amount)::numeric AS paid FROM remittance_line WHERE claim_id=$1",
        [claimId],
      );
      expect(Number(paid.paid)).toBe(1000);
      // m23.claim.paid carries the supplemental amount only (incremental); the claim total is the sum of its lines.
      const ev = await rows(
        "SELECT payload FROM outbox_event WHERE event_type='m23.claim.paid' AND payload->>'claimId'=$1",
        [claimId],
      );
      expect(ev.map((e) => e.payload.paidAmountCents)).toEqual([30_000]);
      // The cap-day signal is emitted again on the top-up, keyed by the same claim line: M26 keeps one row per
      // claim line (unique natural key, replay is a no-op - m26-cap-consumer-store.live), so days never double.
      const fin = await rows(
        "SELECT payload->>'claimLineId' AS line, payload->>'days' AS days FROM outbox_event WHERE event_type='m23.claim.line_finalized' AND payload->>'claimId'=$1",
        [claimId],
      );
      expect(fin).toHaveLength(2);
      expect(new Set(fin.map((f) => f.line)).size).toBe(1);
    });

    it("a second partial payment on a PARTIAL_PAID claim leaves the state; the cumulative paid is the sum of its remittance lines", async () => {
      const claimId = await seedClaim("PCN-S09E", "ACK_ACCEPTED");
      await postEra(
        era("000009007", "0001", "500.00", ["CLP*PCN-S09E*1*1000.00*500.00*0.00*MC*ICN-S09E", "CAS*CO*45*500.00"]),
        "minio/s09e-1.835",
      );
      await dispatcher.tick();
      await postEra(
        era("000009008", "0001", "200.00", ["CLP*PCN-S09E*1*500.00*200.00*0.00*MC*ICN-S09E2", "CAS*CO*45*300.00"]),
        "minio/s09e-2.835",
      );
      await dispatcher.tick();

      expect(await stateOf(claimId)).toBe("PARTIAL_PAID");
      const paid = await one(
        "SELECT sum(clp04_total_payment_amount)::numeric AS paid FROM remittance_line WHERE claim_id=$1",
        [claimId],
      );
      expect(Number(paid.paid)).toBe(700);
      const hist = await rows("SELECT to_state FROM claim_state_history WHERE claim_id=$1", [claimId]);
      expect(hist.map((h) => h.to_state)).toEqual(["PARTIAL_PAID"]);
    });

    it("a second paid line of the SAME advice does not read as a won appeal", async () => {
      const claimId = await seedClaim("PCN-S09D", "ACK_ACCEPTED");
      await postEra(
        era("000009006", "0001", "1100.00", [
          "CLP*PCN-S09D*1*1000.00*700.00*0.00*MC*ICN-S09D",
          "CAS*CO*45*300.00",
          "CLP*PCN-S09D*1*400.00*400.00*0.00*MC*ICN-S09D2",
        ]),
        "minio/s09d.835",
      );
      await dispatcher.tick();
      expect(await stateOf(claimId)).toBe("PARTIAL_PAID");
    });

    it("a supplemental payment the machine cannot place (draft claim) is skipped, not retried forever", async () => {
      const claimId = await seedClaim("PCN-S09C", "DRAFT");
      await postEra(
        era("000009005", "0001", "50.00", ["CLP*PCN-S09C*1*50.00*50.00*0.00*MC*ICN-S09C"]),
        "minio/s09c.835",
      );
      await dispatcher.tick();
      expect(await stateOf(claimId)).toBe("DRAFT");
    });
  });
});
