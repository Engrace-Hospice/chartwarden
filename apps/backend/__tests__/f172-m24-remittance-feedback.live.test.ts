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
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ParsedRemittanceAdvice, X12WorkerResult } from "@chartwarden/x12-835-client";
import { eq } from "drizzle-orm";
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
  PAYEE_UNCHECKED,
  buildDrizzleM25IngestService,
  buildM23BackedClaimMatchCandidateProvider,
  buildM24BackedClaimMatchCandidateProvider,
} from "../src/modules/25-remittance/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

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

      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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
      const MEDICAID_SUBMISSION_ID = "00000000-0000-0000-0000-0000000c7203";
      let m24Seams: ReturnType<typeof registerM24PublishedSeams>;

      beforeAll(async () => {
        registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(handle.db));
        m24Seams = registerM24PublishedSeams(handle.db);

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
        await admin.query(
          `INSERT INTO medicaid_submission
           (id,organization_id,medicaid_claim_id,provider_entity_id,service_state,channel,
            medicaid_claim_control_number,attempt_index,adapter_vendor,adapter_version,result,
            vendor_transaction_id,submitted_at)
           VALUES ($1,$2,$3,$4,'OR','cco_clearinghouse',$5,0,'synthetic-vendor','test',
            'accepted_sync','synthetic-tx',now())`,
          [MEDICAID_SUBMISSION_ID, ORG_A, MEDICAID_CLAIM_ID, peA, SHARED_CCN],
        );
      });

      it("projects a stored attempt with no provenance as unverified and hides its identities", async () => {
        const projected = await m24Seams!.claimMatch.submissionEvidenceForLine(ORG_A, peA, {
          claimControlNumber: SHARED_CCN,
        });
        expect(projected).toHaveLength(1);
        expect(projected[0]).toMatchObject({
          disposition: "SUBMISSION_UNVERIFIED",
          claimId: null,
          replacesClaimId: null,
          replacedByClaimId: null,
          organizationId: ORG_A,
          providerEntityId: peA,
          claimVersion: 1,
          claimState: "ACK_ACCEPTED",
          // an unproven result hides the submission and assignment identities too (slice B contract)
          attempts: [
            {
              submissionId: null,
              assignmentId: null,
              vendorTransactionId: null,
              payerClassificationId: null,
              sourceAccountRef: null,
              environment: null,
              provenanceStatus: "unverified",
            },
          ],
        });
        expect(
          await m24Seams!.claimMatch.submissionEvidenceForLine(ORG_B, peA, {
            claimControlNumber: SHARED_CCN,
          }),
        ).toEqual([]);
        // The promotion guard is proven below on rows that satisfy every CHECK, where only the trigger can refuse.
        expect((await loadMedicaidClaim(MEDICAID_CLAIM_ID))?.state).toBe("ACK_ACCEPTED");
      });

      // ── M24 submission provenance (1541): the guard, and the seam's SUBMISSION_EVIDENCE path ───────────────
      // Every row below satisfies every CHECK the verified status asks for (account, environment, payer and
      // classification snapshots, program kind, assignment id and version, claim version, submitted_at and the
      // vendor transaction id). A refusal can therefore only be the guard trigger, and the controls prove each
      // statement is otherwise valid by running it as the superuser, which the guard lets through.
      const PAYER = "00000000-0000-0000-0000-0000000fa701";
      const CLASSIFICATION = "00000000-0000-0000-0000-0000000fc701";
      const MCO = "00000000-0000-0000-0000-0000000fd701";
      const REVIEWER = "33333333-3333-3333-3333-3333333333aa";
      let scenarioSeq = 0;

      /** One attempt: every field defaults to the fully qualified value, and a key breaks exactly that value. */
      type AttemptOptions = {
        readonly serviceState?: string;
        readonly channel?: string;
        readonly mcoIdSnapshot?: string | null;
        readonly claimControlNumber?: string;
        readonly environment?: string;
        readonly submittedClaimVersion?: number;
        readonly provenance?: "verified" | "unverified";
        readonly result?: string;
        readonly sourceAccountRef?: string | null;
        readonly payerSnapshot?: string | null;
        readonly classificationSnapshot?: string | null;
        readonly programKindSnapshot?: string;
        readonly assignmentIdSnapshot?: string | null;
        readonly assignmentVersionSnapshot?: number;
        readonly submittedAt?: Date | null;
        readonly vendorTransactionId?: string | null;
      };

      type ScenarioOptions = {
        readonly orgId?: string;
        readonly providerEntityId?: string;
        readonly controlNumber?: string;
        readonly claimState?: string;
        readonly claimReplacedBy?: string | null;
        readonly claimPayer?: string | null;
        /** Default true: each attempt gets one acknowledgment. False leaves the attempts free to be re-keyed. */
        readonly acknowledged?: boolean;
        readonly assignment?: {
          readonly status?: string;
          readonly payer?: string | null;
          readonly classification?: string | null;
          readonly state?: string;
          readonly version?: number;
        };
        readonly attempts?: readonly AttemptOptions[];
      };

      /** `value` unless it was left undefined (an explicit null is a value: it breaks the field on purpose). */
      const orDefault = <T>(value: T | undefined, fallback: T): T =>
        value === undefined ? fallback : value;

      /**
       * A verified program assignment, a claim naming it, and one submission attempt (with one acknowledgment that
       * carries a payer claim control number) per entry of `attempts`.
       */
      async function seedScenario(options: ScenarioOptions = {}) {
        scenarioSeq += 1;
        const orgId = options.orgId ?? ORG_A;
        const providerEntityId = options.providerEntityId ?? peA;
        const controlNumber = options.controlNumber ?? `CN-SEAM-${scenarioSeq}`;
        const claimId = randomUUID();
        const assignmentId = randomUUID();
        const assignment = options.assignment ?? {};
        await admin.query(
          `INSERT INTO medicaid_program_assignment
             (id, organization_id, patient_id, patient_payer_id, admission_id, provider_entity_id, service_state,
              program_kind, canonical_payer_id, canonical_payer_classification_id, status, effective_from,
              source_kind, verification_source, evidence_reference, verified_at, verified_by_membership_id,
              recorded_by_membership_id, version)
           VALUES ($1,$2,$3,$4,$5,$6,$11,'managed_care',$7,$8,$12,'2026-01-01','manual_candidate',
                   'state_registry','doc:synthetic-assignment',now(),$9,$10,$13)`,
          [
            assignmentId,
            orgId,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            providerEntityId,
            orDefault(assignment.payer, PAYER),
            orDefault(assignment.classification, CLASSIFICATION),
            REVIEWER,
            MEMBER,
            assignment.state ?? "OR",
            assignment.status ?? "verified",
            assignment.version ?? 1,
          ],
        );
        await seedMedicaidClaim({
          id: claimId,
          orgId,
          providerEntityId,
          state: options.claimState ?? "ACK_ACCEPTED",
          controlNumber,
        });
        // The claim replaces an earlier one (a TOB 817 names its predecessor), so an unproven result that leaked the
        // lineage would show it.
        const replacesClaimId = randomUUID();
        await admin.query(
          `UPDATE medicaid_claim
           SET canonical_payer_id=$2, program_assignment_id=$3, medicaid_program_kind='managed_care',
               replaced_by_claim_id=$4, tob='817', replaces_claim_id=$5, mco_id=$6
           WHERE id=$1`,
          [
            claimId,
            orDefault(options.claimPayer, PAYER),
            assignmentId,
            options.claimReplacedBy ?? null,
            replacesClaimId,
            MCO,
          ],
        );
        const submissionIds: string[] = [];
        const attempts = options.attempts ?? [{}];
        for (const [attemptIndex, attempt] of attempts.entries()) {
          const submissionId = randomUUID();
          await admin.query(
            `INSERT INTO medicaid_submission
               (id, organization_id, medicaid_claim_id, provider_entity_id, service_state, channel,
                mco_id_snapshot, medicaid_claim_control_number, attempt_index, adapter_vendor, adapter_version,
                source_account_ref, source_environment, canonical_payer_id_snapshot,
                payer_classification_id_snapshot, program_kind_snapshot, program_assignment_id_snapshot,
                program_assignment_version_snapshot, submitted_claim_version, source_provenance_status,
                result, vendor_transaction_id, submitted_at)
             VALUES ($1,$2,$3,$4,$19,$20,$21,COALESCE($22::varchar,$5::varchar),$6,'synthetic-vendor','test',
                     $14,$7,$8,$9,$15,$10,$16,$11,$12,$17,$13,$18)`,
            [
              submissionId,
              orgId,
              claimId,
              providerEntityId,
              controlNumber,
              attemptIndex,
              attempt.environment ?? "production",
              orDefault(attempt.payerSnapshot, PAYER),
              orDefault(attempt.classificationSnapshot, CLASSIFICATION),
              orDefault(attempt.assignmentIdSnapshot, assignmentId),
              attempt.submittedClaimVersion ?? 1,
              attempt.provenance ?? "verified",
              orDefault(attempt.vendorTransactionId, `synthetic-tx-${scenarioSeq}-${attemptIndex}`),
              orDefault(attempt.sourceAccountRef, "synthetic-account-1"),
              attempt.programKindSnapshot ?? "managed_care",
              attempt.assignmentVersionSnapshot ?? 1,
              attempt.result ?? "accepted_sync",
              orDefault(attempt.submittedAt, new Date()),
              attempt.serviceState ?? "OR",
              attempt.channel ?? "cco_clearinghouse",
              orDefault(attempt.mcoIdSnapshot, MCO),
              attempt.claimControlNumber ?? null,
            ],
          );
          if (options.acknowledged !== false) {
            await admin.query(
              `INSERT INTO medicaid_acknowledgment
                 (organization_id, medicaid_claim_id, medicaid_submission_id, kind, outcome, payer_claim_control_number)
               VALUES ($1,$2,$3,'sync_277ca','accepted',$4)`,
              [orgId, claimId, submissionId, `PCCN-${scenarioSeq}-${attemptIndex}`],
            );
          }
          submissionIds.push(submissionId);
        }
        return {
          orgId,
          providerEntityId,
          controlNumber,
          claimId,
          assignmentId,
          replacesClaimId,
          scenarioNumber: scenarioSeq,
          submissionIds,
        };
      }

      /**
       * The verified CHECK keeps a NULL account, payer, classification, assignment, time or vendor transaction out of a
       * verified row, so the seam's own test for each is reachable only without it. This drops the CHECK for the case,
       * removes the rows the case wrote that the CHECK would refuse (their acknowledgments first), and puts the
       * constraint back exactly as the catalog defined it.
       */
      async function withVerifiedCheckDropped<T>(run: () => Promise<T>): Promise<T> {
        const name = "medicaid_submission_verified_provenance_ck";
        const { rows } = await admin.query<{ definition: string }>(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1",
          [name],
        );
        const definition = rows[0]?.definition;
        if (!definition) throw new Error(`${name} is not defined`);
        const expression = definition.replace(/^CHECK /, "");
        await admin.query(`ALTER TABLE medicaid_submission DROP CONSTRAINT ${name}`);
        try {
          return await run();
        } finally {
          await admin.query(
            `DELETE FROM medicaid_acknowledgment WHERE medicaid_submission_id IN
               (SELECT id FROM medicaid_submission WHERE NOT ${expression})`,
          );
          await admin.query(`DELETE FROM medicaid_submission WHERE NOT ${expression}`);
          await admin.query(`ALTER TABLE medicaid_submission ADD CONSTRAINT ${name} ${definition}`);
        }
      }

      /** The message of a refusal, with the driver's wrapped cause (drizzle puts the Postgres text in `cause`). */
      async function refusalOf(
        run: () => Promise<unknown>,
        what = "the statement",
      ): Promise<string> {
        try {
          await run();
        } catch (error) {
          const parts: string[] = [];
          let current: unknown = error;
          while (current instanceof Error) {
            parts.push(current.message);
            current = (current as Error & { cause?: unknown }).cause;
          }
          return parts.join(" | ");
        }
        throw new Error(`${what} was expected to be refused but it succeeded`);
      }

      type AppTx = Parameters<Parameters<typeof handle.db.transaction>[0]>[0];
      const asApp = <T>(run: (tx: AppTx) => Promise<T>) =>
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, run);

      type SeamEvidence = Awaited<
        ReturnType<NonNullable<typeof m24Seams>["claimMatch"]["submissionEvidenceForLine"]>
      >;
      function expectUnproven(evidence: SeamEvidence, why: string): void {
        expect(evidence, why).toHaveLength(1);
        const [result] = evidence;
        expect(result?.disposition, why).toBe("SUBMISSION_UNVERIFIED");
        // An unproven result carries no identity a caller could follow (slice B contract): not the claim, its
        // lineage, the submission, the assignment, the vendor transaction, the payer classification or the payer
        // claim control number of an acknowledgment. Every scenario seeds each of them, so a null is a hidden value.
        expect(result?.claimId, why).toBeNull();
        expect(result?.claimControlNumber, why).toBeNull();
        expect(result?.canonicalPayerId, why).toBeNull();
        expect(result?.programKind, why).toBeNull();
        expect(result?.replacesClaimId, why).toBeNull();
        expect(result?.replacedByClaimId, why).toBeNull();
        expect(result?.attempts.length, why).toBeGreaterThan(0);
        for (const attempt of result?.attempts ?? []) {
          expect(attempt.submissionId, why).toBeNull();
          expect(attempt.assignmentId, why).toBeNull();
          expect(attempt.vendorTransactionId, why).toBeNull();
          expect(attempt.payerClassificationId, why).toBeNull();
          expect(attempt.payerId, why).toBeNull();
          expect(attempt.programKind, why).toBeNull();
          expect(attempt.acknowledgments.length, why).toBeGreaterThan(0);
          for (const acknowledgment of attempt.acknowledgments) {
            expect(acknowledgment.payerClaimControlNumber, why).toBeNull();
          }
        }
      }

      it("the application role cannot promote a fully populated attempt to verified, and an update of a verified attempt keeps working", async () => {
        const { submissionIds } = await seedScenario({
          attempts: [{ provenance: "unverified" }],
        });
        const submissionId = submissionIds[0] as string;
        const promote = () =>
          asApp((tx) =>
            tx
              .update(schema.medicaidSubmission)
              .set({ sourceProvenanceStatus: "verified" })
              .where(eq(schema.medicaidSubmission.id, submissionId)),
          );
        expect(await refusalOf(promote)).toMatch(/qualified server-owned path/);

        // Control: the same promotion is valid for a server-owned (non-application) path, so the refusal above was
        // the guard and not a CHECK.
        await admin.query(
          "UPDATE medicaid_submission SET source_provenance_status='verified' WHERE id=$1",
          [submissionId],
        );

        // A6: once an attempt is verified the application keeps updating it: the result, the polling schedule, the
        // terminal time and the error detail are none of the frozen columns. (adapter_vendor and adapter_version ARE
        // frozen on a verified row: the worker writes them after adapter.submit returns, in the same transaction as
        // the terminalizing update, while the attempt is still unverified. A future path that verified an attempt
        // before that write would fail with the provenance-guard error.)
        const updated = await asApp((tx) =>
          tx
            .update(schema.medicaidSubmission)
            .set({
              result: "pending_async",
              errorCode: "SYNTHETIC",
              errorMessage: "synthetic polling detail",
              nextPollAt: new Date(Date.now() + 60_000),
              terminalAt: new Date(),
            })
            .where(eq(schema.medicaidSubmission.id, submissionId))
            .returning({ id: schema.medicaidSubmission.id }),
        );
        expect(updated).toHaveLength(1);
        const settled = await asApp((tx) =>
          tx
            .update(schema.medicaidSubmission)
            .set({ result: "accepted_sync", nextPollAt: null, terminalAt: new Date() })
            .where(eq(schema.medicaidSubmission.id, submissionId))
            .returning({ id: schema.medicaidSubmission.id }),
        );
        expect(settled).toHaveLength(1);
      });

      // Every column the verification stands on or that says which attempt the row IS: rewriting any of them would
      // keep the row verified while changing what it proves (the seam joins an attempt to its claim by
      // medicaid_claim_id). The values are otherwise valid for the row (another claim of the same organization and
      // provider entity, another provider entity of the organization, a free attempt index...), and each case runs
      // the identical statement as the superuser right after, so a refusal can only be the guard.
      it("the application role cannot rewrite any identity or provenance column of a verified attempt", async () => {
        const otherClaim = await seedScenario({ attempts: [] });
        const otherProviderEntity = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'711113','PE three','7111111137','enc','0930') RETURNING id`,
            [ORG_A],
          )
        ).rows[0].id as string;
        type SubmissionColumns = Partial<typeof schema.medicaidSubmission.$inferInsert>;
        const frozen: readonly {
          readonly column: string;
          readonly key: keyof SubmissionColumns;
          readonly value: unknown;
        }[] = [
          { column: "id", key: "id", value: randomUUID() },
          { column: "organization_id", key: "organizationId", value: ORG_B },
          { column: "medicaid_claim_id", key: "medicaidClaimId", value: otherClaim.claimId },
          { column: "provider_entity_id", key: "providerEntityId", value: otherProviderEntity },
          { column: "service_state", key: "serviceState", value: "WA" },
          { column: "channel", key: "channel", value: "direct_mmis" },
          { column: "mco_id_snapshot", key: "mcoIdSnapshot", value: randomUUID() },
          {
            column: "medicaid_claim_control_number",
            key: "medicaidClaimControlNumber",
            value: "CN-REWRITTEN",
          },
          { column: "attempt_index", key: "attemptIndex", value: 7 },
          { column: "adapter_vendor", key: "adapterVendor", value: "another-vendor" },
          { column: "adapter_version", key: "adapterVersion", value: "another" },
          {
            column: "source_provenance_status",
            key: "sourceProvenanceStatus",
            value: "unverified",
          },
          { column: "source_account_ref", key: "sourceAccountRef", value: "another-account" },
          { column: "source_environment", key: "sourceEnvironment", value: "test" },
          {
            column: "canonical_payer_id_snapshot",
            key: "canonicalPayerIdSnapshot",
            value: randomUUID(),
          },
          {
            column: "payer_classification_id_snapshot",
            key: "payerClassificationIdSnapshot",
            value: randomUUID(),
          },
          { column: "program_kind_snapshot", key: "programKindSnapshot", value: "unsupported" },
          {
            column: "program_assignment_id_snapshot",
            key: "programAssignmentIdSnapshot",
            value: randomUUID(),
          },
          {
            column: "program_assignment_version_snapshot",
            key: "programAssignmentVersionSnapshot",
            value: 9,
          },
          { column: "submitted_claim_version", key: "submittedClaimVersion", value: 9 },
          { column: "submitted_at", key: "submittedAt", value: new Date("2020-01-01T00:00:00Z") },
          { column: "vendor_transaction_id", key: "vendorTransactionId", value: "another-tx" },
        ];
        for (const { column, key, value } of frozen) {
          const { submissionIds } = await seedScenario({ attempts: [{}], acknowledged: false });
          const submissionId = submissionIds[0] as string;
          const refusal = await refusalOf(
            () =>
              asApp((tx) =>
                tx
                  .update(schema.medicaidSubmission)
                  .set({ [key]: value } as SubmissionColumns)
                  .where(eq(schema.medicaidSubmission.id, submissionId)),
              ),
            `rewriting ${column} of a verified attempt`,
          );
          expect(refusal, column).toMatch(/qualified server-owned path/);
          // Control: the same change is valid for a server-owned (non-application) path.
          const control = await admin.query(
            `UPDATE medicaid_submission SET ${column}=$2 WHERE id=$1`,
            [submissionId, value],
          );
          expect(control.rowCount, `control: ${column} outside the app role`).toBe(1);
        }
      });

      it("the application role cannot insert a verified attempt", async () => {
        const { claimId, assignmentId, controlNumber } = await seedScenario({ attempts: [] });
        const verifiedAttempt = (vendorTransactionId: string) => ({
          organizationId: ORG_A,
          medicaidClaimId: claimId,
          providerEntityId: peA,
          serviceState: "OR",
          channel: "cco_clearinghouse",
          medicaidClaimControlNumber: controlNumber,
          adapterVendor: "synthetic-vendor",
          adapterVersion: "test",
          sourceAccountRef: "synthetic-account-1",
          sourceEnvironment: "production",
          canonicalPayerIdSnapshot: PAYER,
          payerClassificationIdSnapshot: CLASSIFICATION,
          programKindSnapshot: "managed_care",
          programAssignmentIdSnapshot: assignmentId,
          programAssignmentVersionSnapshot: 1,
          submittedClaimVersion: 1,
          sourceProvenanceStatus: "verified",
          result: "accepted_sync" as const,
          vendorTransactionId,
          submittedAt: new Date(),
        });
        expect(
          await refusalOf(() =>
            asApp((tx) =>
              tx.insert(schema.medicaidSubmission).values(verifiedAttempt("synthetic-app-insert")),
            ),
          ),
        ).toMatch(/qualified server-owned path/);
        // Control: the identical row is valid when written outside the application role.
        const { rows } = await admin.query(
          `INSERT INTO medicaid_submission
             (organization_id, medicaid_claim_id, provider_entity_id, service_state, channel,
              medicaid_claim_control_number, adapter_vendor, adapter_version, source_account_ref,
              source_environment, canonical_payer_id_snapshot, payer_classification_id_snapshot,
              program_kind_snapshot, program_assignment_id_snapshot, program_assignment_version_snapshot,
              submitted_claim_version, source_provenance_status, result, vendor_transaction_id, submitted_at)
           VALUES ($1,$2,$3,'OR','cco_clearinghouse',$4,'synthetic-vendor','test','synthetic-account-1',
                   'production',$5,$6,'managed_care',$7,1,1,'verified','accepted_sync','synthetic-super-insert',now())
           RETURNING id`,
          [ORG_A, claimId, peA, controlNumber, PAYER, CLASSIFICATION, assignmentId],
        );
        expect(rows).toHaveLength(1);
      });

      // The verified CHECK, not the guard: the superuser passes the guard (it only constrains chartwarden_app), so a
      // refusal here can only be the CHECK. A NULL would pass `col > 0` (NULL is not false), hence the IS NOT NULL.
      it("a verified attempt cannot have its assignment version snapshot nulled or set to zero (the CHECK refuses it)", async () => {
        const { submissionIds } = await seedScenario({ attempts: [{}], acknowledged: false });
        const submissionId = submissionIds[0] as string;
        const setSnapshot = (value: number | null) =>
          admin.query(
            "UPDATE medicaid_submission SET program_assignment_version_snapshot=$2 WHERE id=$1",
            [submissionId, value],
          );
        for (const value of [null, 0]) {
          const refusal = await refusalOf(
            () => setSnapshot(value),
            `setting the snapshot to ${value}`,
          );
          expect(refusal, `${value}`).toMatch(/medicaid_submission_verified_provenance_ck/);
          expect(refusal, `${value}`).not.toMatch(/qualified server-owned path/);
        }
        // Control: the same statement with a positive version is valid, so the refusals above were the CHECK.
        expect((await setSnapshot(2)).rowCount).toBe(1);
      });

      it("a fully verified production attempt on the exact claim version is SUBMISSION_EVIDENCE with its identities", async () => {
        const scenario = await seedScenario();
        const evidence = await m24Seams!.claimMatch.submissionEvidenceForLine(ORG_A, peA, {
          claimControlNumber: scenario.controlNumber,
        });
        expect(evidence).toHaveLength(1);
        expect(evidence[0]).toMatchObject({
          disposition: "SUBMISSION_EVIDENCE",
          claimId: scenario.claimId,
          replacesClaimId: scenario.replacesClaimId,
          replacedByClaimId: null,
          organizationId: ORG_A,
          providerEntityId: peA,
          canonicalPayerId: PAYER,
          programKind: "managed_care",
          claimVersion: 1,
          attempts: [
            {
              submissionId: scenario.submissionIds[0],
              assignmentId: scenario.assignmentId,
              vendorTransactionId: `synthetic-tx-${scenario.scenarioNumber}-0`,
              payerClassificationId: CLASSIFICATION,
              environment: "production",
              provenanceStatus: "verified",
              sourceAccountRef: "synthetic-account-1",
              acknowledgments: [{ payerClaimControlNumber: `PCCN-${scenario.scenarioNumber}-0` }],
            },
          ],
        });
      });

      // ── One refusal per qualification predicate of the seam ─────────────────────────────────────────────────
      // Each case builds the fully qualified scenario (the test above proves it is SUBMISSION_EVIDENCE) and breaks
      // exactly one thing. The predicates, in the order of the seam's `qualified` filter and then its claim tests:
      //   attempt: provenance verified, production environment, source account, result accepted or pending_async,
      //     submitted time, vendor transaction id, service state/channel/MCO/control snapshots exact, submitted at
      //     the claim version, assignment snapshot present and
      //     equal to the claim's assignment, assignment version equal to the assignment's, program kind snapshot
      //     equal to the claim's, payer snapshot equal to the claim's payer, classification snapshot present and
      //     equal to the assignment's
      //   assignment: verified, payer equal to the claim's, state equal to the claim's service state
      //   claim: names a payer, state not REPLACED / VOIDED / ABANDONED, no successor
      //   result: exactly one attempt qualifies
      // The cases marked `dropsVerifiedCheck` break a column the verified CHECK would not let a verified row hold
      // NULL, so the CHECK is out of the way for that case only. "names a payer", "assignment snapshot present" and
      // "classification snapshot present" are each also implied by the equality test beside them unless both sides
      // are NULL, which is how those cases isolate them.
      const OTHER_PAYER = "00000000-0000-0000-0000-0000000fa702";
      const OTHER_CLASSIFICATION = "00000000-0000-0000-0000-0000000fc702";
      const OTHER_ASSIGNMENT = "00000000-0000-0000-0000-0000000fb702";
      const SUCCESSOR_CLAIM = "00000000-0000-0000-0000-0000000c7fff";
      type RefusalCase = {
        readonly predicate: string;
        readonly options: ScenarioOptions;
        readonly dropsVerifiedCheck?: true;
      };
      const REFUSALS: readonly RefusalCase[] = [
        {
          predicate: "attempt service state matches the claim",
          options: { attempts: [{ serviceState: "WA" }] },
        },
        {
          predicate: "attempt channel matches the claim program route",
          options: { attempts: [{ channel: "direct_mmis" }] },
        },
        {
          predicate: "attempt MCO snapshot matches the claim",
          options: { attempts: [{ mcoIdSnapshot: "00000000-0000-0000-0000-00000000ffff" }] },
        },
        {
          predicate: "attempt control number matches the claim",
          options: { attempts: [{ claimControlNumber: "CN-OTHER" }] },
        },
        {
          predicate: "attempt provenance is verified",
          options: { attempts: [{ provenance: "unverified" }] },
        },
        {
          predicate: "attempt environment is production",
          options: { attempts: [{ environment: "test" }] },
        },
        {
          predicate: "attempt names a source account",
          options: { attempts: [{ sourceAccountRef: null }] },
          dropsVerifiedCheck: true,
        },
        {
          predicate: "attempt result: pending",
          options: { attempts: [{ result: "pending" }] },
        },
        {
          predicate: "attempt result: rejected_sync",
          options: { attempts: [{ result: "rejected_sync" }] },
        },
        {
          predicate: "attempt result: transport_failure",
          options: { attempts: [{ result: "transport_failure" }] },
        },
        {
          predicate: "attempt result: timeout",
          options: { attempts: [{ result: "timeout" }] },
        },
        {
          predicate: "attempt result: cancelled",
          options: { attempts: [{ result: "cancelled" }] },
        },
        {
          predicate: "attempt carries a submitted time",
          options: { attempts: [{ submittedAt: null }] },
          dropsVerifiedCheck: true,
        },
        {
          predicate: "attempt carries a vendor tx id",
          options: { attempts: [{ vendorTransactionId: null }] },
          dropsVerifiedCheck: true,
        },
        {
          predicate: "attempt was submitted at claim version",
          options: { attempts: [{ submittedClaimVersion: 2 }] },
        },
        {
          predicate: "attempt names an assignment",
          options: { attempts: [{ assignmentIdSnapshot: null }] },
          dropsVerifiedCheck: true,
        },
        {
          predicate: "attempt assignment is the claim's",
          options: { attempts: [{ assignmentIdSnapshot: OTHER_ASSIGNMENT }] },
        },
        {
          predicate: "attempt assignment version is current",
          options: { assignment: { version: 2 } },
        },
        {
          predicate: "attempt program kind is the claim's",
          options: { attempts: [{ programKindSnapshot: "ffs_open_card" }] },
        },
        {
          predicate: "attempt payer is the claim's payer",
          options: { attempts: [{ payerSnapshot: OTHER_PAYER }] },
        },
        {
          predicate: "attempt names a payer classification",
          options: {
            assignment: { classification: null },
            attempts: [{ classificationSnapshot: null }],
          },
          dropsVerifiedCheck: true,
        },
        {
          predicate: "attempt classification is assignment's",
          options: { attempts: [{ classificationSnapshot: OTHER_CLASSIFICATION }] },
        },
        { predicate: "assignment is verified", options: { assignment: { status: "revoked" } } },
        {
          predicate: "assignment payer is the claim's payer",
          options: { assignment: { payer: OTHER_PAYER } },
        },
        {
          predicate: "assignment state is the claim's state",
          options: { assignment: { state: "WA" } },
        },
        {
          predicate: "claim names a payer",
          options: {
            claimPayer: null,
            assignment: { payer: null },
            attempts: [{ payerSnapshot: null }],
          },
          dropsVerifiedCheck: true,
        },
        {
          predicate: "claim is not REPLACED",
          options: { claimState: "REPLACED" },
        },
        { predicate: "claim is not VOIDED", options: { claimState: "VOIDED" } },
        { predicate: "claim is not ABANDONED", options: { claimState: "ABANDONED" } },
        { predicate: "claim has no successor", options: { claimReplacedBy: SUCCESSOR_CLAIM } },
        { predicate: "exactly one attempt qualifies", options: { attempts: [{}, {}] } },
      ];

      it.each(REFUSALS)(
        "breaking only $predicate is SUBMISSION_UNVERIFIED and exposes no identity",
        async ({ predicate, options, dropsVerifiedCheck }) => {
          const evidenceFor = async () => {
            const scenario = await seedScenario(options);
            return m24Seams!.claimMatch.submissionEvidenceForLine(ORG_A, peA, {
              claimControlNumber: scenario.controlNumber,
            });
          };
          const evidence = dropsVerifiedCheck
            ? await withVerifiedCheckDropped(evidenceFor)
            : await evidenceFor();
          expectUnproven(evidence, predicate);
        },
      );

      it("evidence is scoped to the provider entity: the same control number under another provider entity of the same org is a different claim", async () => {
        const peA2 = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,'711112','PE two','7111111129','enc','0930') RETURNING id`,
            [ORG_A],
          )
        ).rows[0].id as string;
        const shared = "CN-SEAM-CROSS-PE";
        const first = await seedScenario({ controlNumber: shared });
        const second = await seedScenario({
          controlNumber: shared,
          providerEntityId: peA2,
          attempts: [{ environment: "test" }],
        });
        const forFirst = await m24Seams!.claimMatch.submissionEvidenceForLine(ORG_A, peA, {
          claimControlNumber: shared,
        });
        expect(forFirst).toHaveLength(1);
        expect(forFirst[0]).toMatchObject({
          disposition: "SUBMISSION_EVIDENCE",
          claimId: first.claimId,
          providerEntityId: peA,
        });
        const forSecond = await m24Seams!.claimMatch.submissionEvidenceForLine(ORG_A, peA2, {
          claimControlNumber: shared,
        });
        expectUnproven(
          forSecond,
          "the other provider entity's claim has only a test-environment attempt",
        );
        expect(forSecond[0]?.providerEntityId).toBe(peA2);
        expect(second.claimId).not.toBe(first.claimId);
      });

      function buildIngestService() {
        return buildDrizzleM25IngestService(handle.db, {
          payeeNpi: PAYEE_UNCHECKED,
          client: {
            async parse835(input) {
              const parsed: ParsedRemittanceAdvice = {
                payerProgram: input.payerProgram,
                interchangeControlNumber: input.objectKey.endsWith("medicare")
                  ? "900000001"
                  : "900000002",
                transactionSetControlNumber: input.objectKey.endsWith("medicare") ? "0001" : "0002",
                checkOrEftTraceNumber: input.objectKey.endsWith("medicare")
                  ? "SYNTHETIC-F171-MEDICARE-TRACE"
                  : "SYNTHETIC-F171-MEDICAID-TRACE",
                paymentMethod: "eft",
                totalPaymentAmount: 500,
                paymentEffectiveDate: "2026-02-10",
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
            objectKey: "minio/f171-medicare",
            fileSha256: sha256Hex(buildRawEdi(isa, st)),
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
            objectKey: "minio/f171-medicaid",
            fileSha256: sha256Hex(buildRawEdi(isa, st)),
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
