/**
 * #725 (ADR-0100 D8, M25 D9 "Commercial Phase 2") - commercial 835 matching, LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role, through the REAL registered `CommercialClaimReader` seam and the REAL ingest pipeline
 * (no hand-rolled claims double).
 *
 *   S15  a commercial 835 for a submitted claim of the SAME tenant, provider entity and payer binds and posts exactly once:
 *        a redelivered file is a duplicate and a second post is a no-op.
 *   S19  an advice for another PAYER, another TENANT, or a claim that cannot be paid (draft) quarantines: the line is
 *        unmatched (manual review), nothing posts, no ledger row, the claim is untouched.
 *   #835 the posted line then moves the claim (paid / partially_paid / denied) through the REAL catalog-validating publisher and
 *        the REAL dispatcher into M41's consumer, never regressing; the CLP07 payer ICN is stored so a later line that carries
 *        only the ICN binds; M23 and M24 settle the commercial id as claim_not_found; another tenant's claim is untouched.
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
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  M23_OUTBOX_EVENTS,
  buildM23RemittanceConsumer,
} from "../src/modules/23-billing-medicare/index";
import {
  M24_OUTBOX_EVENTS,
  buildM24RemittanceConsumer,
} from "../src/modules/24-billing-medicaid/index";
import {
  M25_OUTBOX_EVENTS,
  buildM41BackedClaimMatchCandidateProvider,
} from "../src/modules/25-remittance/index";
import {
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
} from "../src/modules/25-remittance/ingest/service-drizzle";
import {
  M41_OUTBOX_EVENTS,
  buildCommercialClaimReader,
  buildM41RemittanceConsumer,
} from "../src/modules/41-billing-commercial";
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
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  const skips: { module: string; reason: string; claimId: string }[] = [];

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
      paid: ["ready", "submitted", "paid"],
      denied: ["ready", "submitted", "denied"],
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
    paid?: string;
    icn?: string;
    /** Emit through the real catalog-validating publisher (otherwise the legacy no-op, so nothing is queued for the drain). */
    realOutbox?: boolean;
  }) {
    isaSeq += 1;
    const isa = String(isaSeq);
    const st = String(isaSeq).slice(-4);
    const paid = o.paid ?? "450.00";
    const raw = buildFullEdi(isa, st, paid, {
      clp01: o.ccn,
      icn: o.icn ?? `ICN-${isa}`,
      charge: "500.00",
      paid,
      patientResponsibility: (500 - Number(paid)).toFixed(2), // the balance is patient responsibility, so the 835 foots
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
      ...(o.realOutbox
        ? {
            outbox: {
              publish: (tx, input) =>
                publisher.publish(tx as never, { ...input, callerModule: "m25" }),
            },
          }
        : {}),
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

    const catalog = buildBootOutboxCatalog([
      M23_OUTBOX_EVENTS,
      M24_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M41_OUTBOX_EVENTS,
    ]);
    publisher = buildTxOutboxPublisher(catalog);
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    const portFor = (callerModule: string) => ({
      publish: (tx: never, input: Record<string, unknown>) =>
        publisher.publish(tx, { ...input, callerModule } as never),
    });
    // M23, M24 and M41 are all bound on ONE dispatcher, exactly as production binds them: each finds its own claim table.
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      eventCatalog: catalog,
      consumers: [
        buildM23RemittanceConsumer({
          db: handle.db,
          outbox: portFor("m23") as never,
          onSkipped: (i) => skips.push({ module: "m23", reason: i.reason, claimId: i.claimId }),
        }),
        buildM24RemittanceConsumer({
          db: handle.db,
          outbox: portFor("m24") as never,
          onSkipped: (i) => skips.push({ module: "m24", reason: i.reason, claimId: i.claimId }),
        }),
        buildM41RemittanceConsumer({
          db: handle.db,
          outbox: portFor("m41") as never,
          onSkipped: (i) => skips.push({ module: "m41", reason: i.reason, claimId: i.claimId }),
        }),
      ],
    });
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

  // ---- #835 ---------------------------------------------------------------------------------------------------------------
  const claimRow = async (claimId: string) =>
    (await admin.query("SELECT state, payer_icn FROM commercial_claim WHERE id=$1", [claimId]))
      .rows[0] as { state: string; payer_icn: string | null };
  const history = async (claimId: string) =>
    (
      await admin.query(
        "SELECT from_state, to_state, actor_kind FROM commercial_claim_state_history WHERE claim_id=$1 ORDER BY created_at, id",
        [claimId],
      )
    ).rows;
  const adjudicatedEvents = async (claimId: string) =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m41.claim.adjudicated' AND payload->>'claimId'=$1",
        [claimId],
      )
    ).rows[0].n as number;
  const noPublish = {
    publish: async () => {
      throw new Error("must not publish");
    },
  };

  async function post835(o: Parameters<typeof deliver>[0]) {
    const r = await deliver({ ...o, realOutbox: true });
    await dispatcher.tick();
    return r;
  }

  it("#835 paid: a full payment moves the claim to paid, stores the ICN, records history and one event; M23/M24 settle claim_not_found", async () => {
    const payerId = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-PD",
      state: "accepted",
    });
    skips.length = 0;
    await post835({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-PD",
      paid: "500.00",
      icn: "ICN-835-PD",
    });

    expect(await claimRow(claimId)).toEqual({ state: "paid", payer_icn: "ICN-835-PD" });
    expect(await history(claimId)).toContainEqual({
      from_state: "accepted",
      to_state: "paid",
      actor_kind: "system",
    });
    expect(await adjudicatedEvents(claimId)).toBe(1);
    const mine = skips.filter((x) => x.claimId === claimId);
    expect(mine.map((x) => `${x.module}:${x.reason}`).sort()).toEqual([
      "m23:claim_not_found",
      "m24:claim_not_found",
    ]);
  });

  it("#835 partial then full: partially_paid, then paid when the balance posts; a later denial never regresses it", async () => {
    const payerId = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-PP",
      state: "submitted",
    });
    const base = { org: ORG_A, pe: peA, payerId, ccn: "CCN-835-PP", icn: "ICN-835-PP" };
    await post835({ ...base, paid: "450.00" });
    expect((await claimRow(claimId)).state).toBe("partially_paid"); // an 835 may beat the payer acknowledgment
    await post835({ ...base, paid: "500.00" });
    expect((await claimRow(claimId)).state).toBe("paid");
    skips.length = 0;
    await post835({ ...base, paid: "0.00" });
    expect((await claimRow(claimId)).state).toBe("paid");
    expect(skips).toContainEqual({ module: "m41", reason: "transition_not_legal", claimId });
    expect((await history(claimId)).map((h) => h.to_state)).toEqual(["partially_paid", "paid"]);
  });

  it("#835 denied then paid on re-post (appeal / reprocess)", async () => {
    const payerId = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-DN",
      state: "accepted",
    });
    const base = { org: ORG_A, pe: peA, payerId, ccn: "CCN-835-DN", icn: "ICN-835-DN" };
    await post835({ ...base, paid: "0.00" });
    expect((await claimRow(claimId)).state).toBe("denied");
    await post835({ ...base, paid: "500.00" });
    expect((await claimRow(claimId)).state).toBe("paid");
  });

  it("#835 idempotent: a redelivered outbox event changes nothing and emits no second event", async () => {
    const payerId = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-ID",
      state: "accepted",
    });
    await post835({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-ID",
      paid: "500.00",
      icn: "ICN-835-ID",
    });
    const consumer = buildM41RemittanceConsumer({ db: handle.db, outbox: noPublish });
    await consumer.handle({
      eventType: "m25.remittance.claim_paid",
      organizationId: ORG_A,
      payload: { claimId, remittanceAdviceId: randomUUID(), payerIcn: "ICN-835-ID" },
    } as never);
    expect((await claimRow(claimId)).state).toBe("paid");
    expect(await adjudicatedEvents(claimId)).toBe(1);
  });

  it("#835 ICN-only line: after the ICN is stored a line with a different control number binds on CLP07; before it, it does not", async () => {
    const payerId = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-IC",
      state: "accepted",
    });
    const orphan = await deliver({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "PAYER-REWRITTEN-0",
      icn: "ICN-835-IC",
    });
    expect((await lines(orphan.adviceId))[0]).toMatchObject({
      match_state: "unmatched",
      claim_id: null,
    });

    await post835({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-IC",
      paid: "450.00",
      icn: "ICN-835-IC",
    });
    expect((await claimRow(claimId)).payer_icn).toBe("ICN-835-IC");
    const viaIcn = await post835({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "PAYER-REWRITTEN-1",
      paid: "500.00",
      icn: "ICN-835-IC",
    });
    expect((await lines(viaIcn.adviceId))[0]).toMatchObject({
      match_state: "posted",
      claim_id: claimId,
    });
    expect((await claimRow(claimId)).state).toBe("paid");
  });

  it("#835 ICN is scoped: the same ICN under another payer or tenant never binds; the first ICN wins on a conflict", async () => {
    const payerId = await newPayer();
    const otherPayer = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-SC",
      state: "accepted",
    });
    await post835({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-SC",
      paid: "450.00",
      icn: "ICN-835-SC",
    });
    const reader = buildCommercialClaimReader(handle.db);
    const key = { payerIcn: "ICN-835-SC" };
    expect(await reader.candidatesForLine(ORG_A, peA, payerId, key)).toHaveLength(1);
    expect(await reader.candidatesForLine(ORG_A, peA, otherPayer, key)).toEqual([]);
    expect(await reader.candidatesForLine(ORG_B, peB, payerId, key)).toEqual([]);
    expect(await reader.candidatesForLine(ORG_A, peA, payerId, {})).toEqual([]);
    skips.length = 0;
    await post835({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-SC",
      paid: "500.00",
      icn: "ICN-OTHER",
    });
    expect((await claimRow(claimId)).payer_icn).toBe("ICN-835-SC");
    expect(skips).toContainEqual({ module: "m41", reason: "payer_icn_conflict", claimId });
  });

  it("#835 cross-tenant: tenant B's posting of A's control number leaves A's claim untouched, and a forged event under B finds no row", async () => {
    const payerId = await newPayer();
    const { claimId } = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-XT",
      state: "accepted",
    });
    const b = await post835({
      org: ORG_B,
      pe: peB,
      payerId,
      ccn: "CCN-835-XT",
      paid: "500.00",
      icn: "ICN-835-XT",
    });
    expect((await lines(b.adviceId))[0]).toMatchObject({ match_state: "unmatched" });
    expect(await claimRow(claimId)).toEqual({ state: "accepted", payer_icn: null });
    skips.length = 0;
    const consumer = buildM41RemittanceConsumer({
      db: handle.db,
      outbox: noPublish,
      onSkipped: (i) => skips.push({ module: "m41", reason: i.reason, claimId: i.claimId }),
    });
    await consumer.handle({
      eventType: "m25.remittance.claim_paid",
      organizationId: ORG_B,
      payload: { claimId, remittanceAdviceId: randomUUID(), payerIcn: "ICN-FORGED" },
    } as never);
    expect(skips).toEqual([{ module: "m41", reason: "claim_not_found", claimId }]);
    expect(await claimRow(claimId)).toEqual({ state: "accepted", payer_icn: null });
  });

  it("#835 the database refuses an illegal move (paid -> denied, rejected -> paid) whatever the writer", async () => {
    const payerId = await newPayer();
    const paid = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId,
      ccn: "CCN-835-G1",
      state: "paid",
    });
    await expect(
      admin.query("UPDATE commercial_claim SET state='denied' WHERE id=$1", [paid.claimId]),
    ).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
    const rej = await seedClaim({
      org: ORG_A,
      pe: peA,
      payerId: await newPayer(),
      ccn: "CCN-835-G2",
      state: "rejected",
    });
    await expect(
      admin.query("UPDATE commercial_claim SET state='paid' WHERE id=$1", [rej.claimId]),
    ).rejects.toThrow(/M41_CLAIM_ILLEGAL_TRANSITION/);
  });
});
