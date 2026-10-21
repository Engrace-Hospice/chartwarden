/**
 * F-172 (#248, m24 group) — the m24 `handlers-unbound` group's last two events, `mark-claim-paid` /
 * `mark-claim-denied`, LIVE Postgres.
 *
 * Two things had to be true at once for these to be reachable: (1) M24 needed a real
 * `OutboxConsumerBinding` for `m25.remittance.claim_paid`/`.claim_denied` (the dead `handlers.ts`/
 * `M24ConsumerStore` abstraction never had one — `buildM24RemittanceConsumer`, the Medicaid sibling of
 * M23's own GAP-037 `m25-remittance.ts` consumer); and (2) M25's `postAdvice` auto-match needed to be
 * ROUTED BY PAYER — before this pass it matched every 835 (Medicare, Medicaid, commercial alike) against
 * M23's Medicare `claim` table alone, so a Medicaid 835's `claimId` could never resolve to a
 * `medicaid_claim.id` in the first place, no matter how many consumers were bound downstream.
 *
 * Section 1 proves the consumer directly (the GAP-037 `postAndDrain` shape): paid, denied, a redelivery
 * skip, a not-legal skip, cross-tenant isolation, and — since `m25.remittance.claim_paid`/`.claim_denied`
 * declare BOTH `m23` and `m24` as consumers — that binding both consumers on the same dispatcher never
 * interrupts either (a Medicaid claim id is invisible to M23's `claim` table and a settled
 * `claim_not_found` skip there, never a delivery failure).
 *
 * Section 2 proves the payer-routing fix itself end to end: a real M23 claim and a real M24 claim share
 * the identical claim-control-number (an X12-generated string, not guaranteed unique cross-payer) under
 * the same provider entity, a Medicare-payerKind 835 and a Medicaid-payerKind 835 carrying that SAME
 * control number are each posted through the real `postAdvice` auto-match, and each resolves to the
 * correct payer's claim — never the other's. The Medicaid posting's own `m25.remittance.claim_paid`
 * emission then drains through the REAL dispatcher into the REAL M24 consumer, flipping the real
 * `medicaid_claim` row PAID.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m24:remittance-feedback:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ParsedRemittanceAdvice, X12WorkerResult } from "@chartwarden/x12-835-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import {
  M23_OUTBOX_EVENTS,
  buildM23RemittanceConsumer,
} from "../src/modules/23-billing-medicare/index";
import {
  M24_OUTBOX_EVENTS,
  buildM24RemittanceConsumer,
  registerM24PublishedSeams,
} from "../src/modules/24-billing-medicaid/index";
import {
  M25_OUTBOX_EVENTS,
  buildDrizzleM25IngestService,
  buildM23BackedClaimMatchCandidateProvider,
  buildM24BackedClaimMatchCandidateProvider,
} from "../src/modules/25-remittance/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111171";
const ORG_B = "22222222-2222-2222-2222-222222222271";
const MEMBER = "33333333-3333-3333-3333-333333333371";
const ADVICE = "00000000-0000-0000-0000-0000000ad071";

const CLAIM = {
  paid: "00000000-0000-0000-0000-0000000c7101",
  denied: "00000000-0000-0000-0000-0000000c7102",
  redelivered: "00000000-0000-0000-0000-0000000c7103",
  notLegal: "00000000-0000-0000-0000-0000000c7104",
  crossTenant: "00000000-0000-0000-0000-0000000c7105",
} as const;

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
  const isaSegment = `ISA${sep}${elems.join(sep)}~`;
  const gsSt = `GS${sep}HP${sep}SENDER${sep}RECEIVER${sep}20250101${sep}1200${sep}1${sep}X${sep}005010X221A1~ST${sep}835${sep}${st02}~`;
  return isaSegment + gsSt;
}

describe.skipIf(!DB_URL)(
  "F-172 M25->M24 remittance feedback + payer routing — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let publisher: ReturnType<typeof buildTxOutboxPublisher>;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;
    let peA: string;
    let peB: string;
    const skips: { module: string; reason: string; claimId: string }[] = [];

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

    async function seedOrg(orgId: string, slug: string, npi: string): Promise<string> {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, slug],
      );
      const pe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'PE',$3,'enc','0930') RETURNING id`,
        [orgId, slug === "org-a" ? "711111" : "722222", npi],
      );
      return pe.rows[0].id;
    }

    /** Seed one `medicaid_claim` row directly (bypassing `assembleClaim`). */
    async function seedMedicaidClaim(args: {
      readonly id: string;
      readonly orgId: string;
      readonly providerEntityId: string;
      readonly state: string;
      readonly controlNumber: string;
    }): Promise<void> {
      await admin.query(
        `INSERT INTO medicaid_claim
         (id, organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
          service_state, kind, tob, service_from, service_to, state_plan_code_id,
          state_plan_code_snapshot, medicaid_claim_control_number, state, version,
          created_by_membership_id, updated_by_membership_id)
       VALUES
         ($1,$2,$3,$4,$5,$6,
          'OR','hospice_only','811','2026-01-01','2026-01-31',$7,
          'OHP-STD',$8,$9,1,$10,$10)`,
        [
          args.id,
          args.orgId,
          args.providerEntityId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          args.controlNumber,
          args.state,
          MEMBER,
        ],
      );
    }

    /** Seed one real M23 `claim` row (each gets its own service month — `claim_*_active_by_range_uidx`). */
    let seededMonth = 0;
    async function seedMedicareClaim(args: {
      readonly id: string;
      readonly orgId: string;
      readonly providerEntityId: string;
      readonly controlNumber: string;
    }): Promise<void> {
      seededMonth += 1;
      const mm = String(seededMonth).padStart(2, "0");
      await admin.query(
        `INSERT INTO claim (
         id, organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id,
         tob, service_from, service_to, claim_control_number,
         mac_jurisdiction, total_charge_cents, sequestration_applied_pct,
         sequestration_policy_id, created_by_membership_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'811',$10,$11,$8,'ngs_j6',50000,'2.00',$9,$12)`,
        [
          args.id,
          args.orgId,
          args.providerEntityId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          args.controlNumber,
          randomUUID(),
          `2026-${mm}-01`,
          `2026-${mm}-28`,
          MEMBER,
        ],
      );
    }

    async function loadMedicaidClaim(claimId: string) {
      const { rows } = await admin.query("SELECT state, version FROM medicaid_claim WHERE id=$1", [
        claimId,
      ]);
      return rows[0] as { state: string; version: number } | undefined;
    }

    async function historyFor(claimId: string) {
      const { rows } = await admin.query(
        "SELECT from_state, to_state, trigger_source, actor_membership_id, reason FROM medicaid_claim_state_history WHERE medicaid_claim_id=$1 ORDER BY at",
        [claimId],
      );
      return rows;
    }

    /** Publish one M25 posting event through the REAL catalog-validating publisher, then drain. */
    async function postAndDrain(
      organizationId: string,
      eventName: string,
      payload: Record<string, unknown>,
    ) {
      await withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
        publisher.publish(tx as never, {
          eventName,
          payload,
          organizationId,
          aggregateKind: "remittance_line",
          aggregateId: "00000000-0000-0000-0000-0000000f71e1",
          callerModule: "m25",
        }),
      );
      await dispatcher.tick();
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
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m24remit@x.test')`, [MEMBER]);
      peA = await seedOrg(ORG_A, "org-a", "7111111110");
      peB = await seedOrg(ORG_B, "org-b", "7222222220");

      await seedMedicaidClaim({
        id: CLAIM.paid,
        orgId: ORG_A,
        providerEntityId: peA,
        state: "ACK_ACCEPTED",
        controlNumber: "CN-PAID",
      });
      await seedMedicaidClaim({
        id: CLAIM.denied,
        orgId: ORG_A,
        providerEntityId: peA,
        state: "ACK_ACCEPTED",
        controlNumber: "CN-DENY",
      });
      await seedMedicaidClaim({
        id: CLAIM.redelivered,
        orgId: ORG_A,
        providerEntityId: peA,
        state: "PAID",
        controlNumber: "CN-REDL",
      });
      await seedMedicaidClaim({
        id: CLAIM.notLegal,
        orgId: ORG_A,
        providerEntityId: peA,
        state: "DRAFT",
        controlNumber: "CN-DRFT",
      });
      await seedMedicaidClaim({
        id: CLAIM.crossTenant,
        orgId: ORG_B,
        providerEntityId: peB,
        state: "ACK_ACCEPTED",
        controlNumber: "CN-XTEN",
      });

      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = buildBootOutboxCatalog([
        M23_OUTBOX_EVENTS,
        M24_OUTBOX_EVENTS,
        M25_OUTBOX_EVENTS,
      ]);
      publisher = buildTxOutboxPublisher(catalog);
      const orgs: ActiveOrgEnumerator = {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      };
      // Both M23's own GAP-037 consumer AND M24's new one are bound on the SAME dispatcher — proving that
      // declaring `m24` alongside the already-live `m23` never interrupts Medicare's own delivery
      // (`buildOutboxRoutingPlan` delivers to every bound consumer regardless of what else is declared).
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs,
        eventCatalog: catalog,
        consumers: [
          buildM23RemittanceConsumer({
            db: handle.db,
            outbox: {
              publish: (tx, input) =>
                publisher.publish(tx as never, { ...input, callerModule: "m23" }),
            },
            onSkipped: (info) =>
              skips.push({ module: "m23", reason: info.reason, claimId: info.claimId }),
          }),
          buildM24RemittanceConsumer({
            db: handle.db,
            outbox: {
              publish: (tx, input) =>
                publisher.publish(tx as never, { ...input, callerModule: "m24" }),
            },
            onSkipped: (info) =>
              skips.push({ module: "m24", reason: info.reason, claimId: info.claimId }),
          }),
        ],
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    // ── Section 1 — the consumer, driven directly through the real dispatcher ──────────────────────────────

    it("a full-payment 835 advances ACK_ACCEPTED -> PAID, records history, and emits m24.medicaid_claim.paid in CENTS", async () => {
      skips.length = 0;
      await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
        patientId: null,
        paidAmountCents: 123456,
        serviceFrom: null,
        serviceTo: null,
        claimId: CLAIM.paid,
        remittanceLineId: "00000000-0000-0000-0000-0000000f71e1",
        remittanceAdviceId: ADVICE,
        paidAmount: "1234.56",
        postedAt: "2026-03-04T05:06:07.000Z",
      });
      expect((await loadMedicaidClaim(CLAIM.paid))?.state).toBe("PAID");

      const hist = await historyFor(CLAIM.paid);
      expect(hist).toHaveLength(1);
      expect(hist[0]).toMatchObject({
        from_state: "ACK_ACCEPTED",
        to_state: "PAID",
        trigger_source: "consumer",
        actor_membership_id: null,
        reason: "remittance_paid",
      });

      // "1234.56" dollars -> 123456 cents. The catalogued schema is `paidAmountCents`; a unit slip here is a
      // 100x misstatement of what the state paid.
      const events = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m24.medicaid_claim.paid' AND payload->>'claimId'=$1",
        [CLAIM.paid],
      );
      expect(events.rows[0].payload).toMatchObject({
        claimId: CLAIM.paid,
        remittanceAdviceId: ADVICE,
        paidAmountCents: 123_456,
        paidAt: "2026-03-04T05:06:07.000Z",
      });

      // M23's own consumer ran too (both are bound) — the Medicaid claim id is invisible to its `claim`
      // table, a settled skip, never a delivery failure or a stray write.
      expect(skips).toContainEqual({
        module: "m23",
        reason: "claim_not_found",
        claimId: CLAIM.paid,
      });
    });

    it("a denial 835 advances ACK_ACCEPTED -> DENIED and carries the CARC codes onto m24.medicaid_claim.denied", async () => {
      await postAndDrain(ORG_A, "m25.remittance.claim_denied", {
        claimId: CLAIM.denied,
        remittanceLineId: "00000000-0000-0000-0000-0000000f71e2",
        remittanceAdviceId: ADVICE,
        carcCodes: ["16", "97"],
        postedAt: "2026-03-04T05:06:07.000Z",
      });
      expect((await loadMedicaidClaim(CLAIM.denied))?.state).toBe("DENIED");
      const events = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m24.medicaid_claim.denied' AND payload->>'claimId'=$1",
        [CLAIM.denied],
      );
      expect(events.rows[0].payload.denialCodes).toEqual(["16", "97"]);
    });

    it("a second 835 line posting the same outcome is a settled skip, not a retry storm", async () => {
      skips.length = 0;
      await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
        patientId: null,
        paidAmountCents: 1000,
        serviceFrom: null,
        serviceTo: null,
        claimId: CLAIM.redelivered,
        remittanceLineId: "00000000-0000-0000-0000-0000000f71e3",
        remittanceAdviceId: ADVICE,
        paidAmount: "10.00",
        postedAt: "2026-03-04T05:06:07.000Z",
      });
      expect((await loadMedicaidClaim(CLAIM.redelivered))?.state).toBe("PAID");
      expect(skips).toContainEqual({
        module: "m24",
        reason: "already_applied",
        claimId: CLAIM.redelivered,
      });
      expect(await historyFor(CLAIM.redelivered)).toHaveLength(0);
    });

    it("an 835 against a claim the transition is not legal from is skipped with its own reason", async () => {
      skips.length = 0;
      await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
        patientId: null,
        paidAmountCents: 1000,
        serviceFrom: null,
        serviceTo: null,
        claimId: CLAIM.notLegal,
        remittanceLineId: "00000000-0000-0000-0000-0000000f71e4",
        remittanceAdviceId: ADVICE,
        paidAmount: "10.00",
        postedAt: "2026-03-04T05:06:07.000Z",
      });
      expect((await loadMedicaidClaim(CLAIM.notLegal))?.state).toBe("DRAFT");
      expect(skips).toContainEqual({
        module: "m24",
        reason: "transition_not_legal",
        claimId: CLAIM.notLegal,
      });
    });

    it("cannot pay another tenant's claim — the consumer runs under the EVENT's org (RLS)", async () => {
      skips.length = 0;
      await postAndDrain(ORG_A, "m25.remittance.claim_paid", {
        patientId: null,
        paidAmountCents: 1000,
        serviceFrom: null,
        serviceTo: null,
        claimId: CLAIM.crossTenant,
        remittanceLineId: "00000000-0000-0000-0000-0000000f71e5",
        remittanceAdviceId: ADVICE,
        paidAmount: "10.00",
        postedAt: "2026-03-04T05:06:07.000Z",
      });
      expect((await loadMedicaidClaim(CLAIM.crossTenant))?.state).toBe("ACK_ACCEPTED");
      expect(skips).toContainEqual({
        module: "m24",
        reason: "claim_not_found",
        claimId: CLAIM.crossTenant,
      });
    });

    // ── Section 2 — the payer-routing fix itself: a shared control number, resolved by `payerKind` ─────────

    describe("payer-routed auto-match (a Medicare and a Medicaid claim share one control number)", () => {
      const SHARED_CCN = "SHARED-CCN-001";
      const MEDICARE_CLAIM_ID = "00000000-0000-0000-0000-0000000c7201";
      const MEDICAID_CLAIM_ID = "00000000-0000-0000-0000-0000000c7202";

      beforeAll(async () => {
        registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(handle.db));
        registerM24PublishedSeams(handle.db);

        await seedMedicareClaim({
          id: MEDICARE_CLAIM_ID,
          orgId: ORG_A,
          providerEntityId: peA,
          controlNumber: SHARED_CCN,
        });
        await seedMedicaidClaim({
          id: MEDICAID_CLAIM_ID,
          orgId: ORG_A,
          providerEntityId: peA,
          state: "ACK_ACCEPTED",
          controlNumber: SHARED_CCN,
        });
      });

      function buildIngestService() {
        return buildDrizzleM25IngestService(handle.db, {
          client: {
            async parse835(input) {
              const parsed: ParsedRemittanceAdvice = {
                payerProgram: input.payerProgram,
                interchangeControlNumber: input.minioObjectKey.endsWith("medicare")
                  ? "900000001"
                  : "900000002",
                transactionSetControlNumber: input.minioObjectKey.endsWith("medicare")
                  ? "0001"
                  : "0002",
                paymentMethod: "eft",
                totalPaymentAmount: 500,
                productionDate: "2026-02-10",
                claims: [
                  {
                    patientControlNumber: SHARED_CCN,
                    statusCode: 1,
                    totalCharge: 500,
                    totalPayment: 500,
                    patientResponsibility: 0,
                    adjustments: [],
                    remarks: [],
                    serviceLines: [],
                  },
                ],
              };
              return { ok: true, value: parsed } as X12WorkerResult<ParsedRemittanceAdvice>;
            },
            async parse277ca() {
              throw new Error("not used in this test");
            },
          },
          outbox: {
            publish: (tx, input) =>
              publisher.publish(tx as never, { ...input, callerModule: "m25" }),
          },
          claims: {
            medicare: buildM23BackedClaimMatchCandidateProvider(),
            medicaid: buildM24BackedClaimMatchCandidateProvider(),
          },
          terminology: {
            async lookup() {
              return null;
            },
          },
        });
      }

      it("a Medicare-payerKind 835 carrying the shared control number matches the M23 claim, never the M24 one", async () => {
        const service = buildIngestService();
        const isa = "900000001";
        const st = "0001";
        const received = await service.receiveAdvice(
          { organizationId: ORG_A },
          {
            providerEntityId: peA,
            payerId: "00000000-0000-0000-0000-0000000fee01",
            payerKind: "medicare",
            minioObjectKey: "minio/f171-medicare",
            fileSha256: "1".repeat(64),
            rawEdi: buildRawEdi(isa, st),
          },
        );
        if (received.outcome !== "queued") throw new Error(`unreachable: ${received.outcome}`);
        const posted = await service.postAdvice({ organizationId: ORG_A }, received.adviceId);
        expect(posted.outcome).toBe("posted");

        const line = await admin.query(
          "SELECT claim_id, match_strategy FROM remittance_line WHERE remittance_advice_id=$1",
          [received.adviceId],
        );
        expect(line.rows[0].claim_id).toBe(MEDICARE_CLAIM_ID);
        expect(line.rows[0].match_strategy).toBe("patient_control");

        // `postAdvice`'s own `m25.remittance.claim_paid` emission is already sitting in the outbox; drain
        // it now (rather than leaving it for the next test to drain implicitly) — the Medicare claim was
        // seeded with no explicit state (defaults to DRAFT), so the real transition is NOT LEGAL and both
        // bound consumers settle it as a skip, never a stray PAID.
        await dispatcher.tick();
        const medicareAfter = await admin.query("SELECT state FROM claim WHERE id=$1", [
          MEDICARE_CLAIM_ID,
        ]);
        expect(medicareAfter.rows[0].state).toBe("DRAFT");
      });

      it("a Medicaid-payerKind 835 carrying the SAME control number matches the M24 claim instead, and the real dispatcher pays it", async () => {
        const service = buildIngestService();
        const isa = "900000002";
        const st = "0002";
        const received = await service.receiveAdvice(
          { organizationId: ORG_A },
          {
            providerEntityId: peA,
            payerId: "00000000-0000-0000-0000-0000000fee02",
            payerKind: "medicaid",
            minioObjectKey: "minio/f171-medicaid",
            fileSha256: "2".repeat(64),
            rawEdi: buildRawEdi(isa, st),
          },
        );
        if (received.outcome !== "queued") throw new Error(`unreachable: ${received.outcome}`);
        const posted = await service.postAdvice({ organizationId: ORG_A }, received.adviceId);
        expect(posted.outcome).toBe("posted");

        const line = await admin.query(
          "SELECT claim_id, match_strategy FROM remittance_line WHERE remittance_advice_id=$1",
          [received.adviceId],
        );
        expect(line.rows[0].claim_id).toBe(MEDICAID_CLAIM_ID);
        expect(line.rows[0].match_strategy).toBe("patient_control");

        // `postAdvice`'s own `m25.remittance.claim_paid` emission is already sitting in the outbox from the
        // call above; drain it through the REAL dispatcher into the REAL M24 consumer.
        await dispatcher.tick();
        expect((await loadMedicaidClaim(MEDICAID_CLAIM_ID))?.state).toBe("PAID");
        // The Medicare claim, sharing the same control number, was never touched by the Medicaid posting.
        const medicare = await admin.query("SELECT state FROM claim WHERE id=$1", [
          MEDICARE_CLAIM_ID,
        ]);
        expect(medicare.rows[0].state).not.toBe("PAID");
      });
    });
  },
);
