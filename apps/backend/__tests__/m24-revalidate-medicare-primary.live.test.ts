/**
 * M24 Billing — Medicaid — F-165 (#248, m24 group): the m24 `handlers-unbound` deferred-consumers group's
 * "trigger-revalidate" + "resolve-medicare-primary" bindings, proven against real Postgres.
 *
 * `runMedicaidRevalidate` (`jobs/revalidate-jobs.ts`) and `buildM24MedicarePrimaryAckConsumer`
 * (`outbox-consumers/m24-medicare-primary-ack.ts`) are driven directly (not through BullMQ — the
 * enqueue/worker wrapper around `runMedicaidRevalidate` is a thin, untested-here BullMQ shim; the
 * value under test is the real Drizzle writes) as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Gated on a live DB: CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run <this file>
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { PatientCoverage, PatientCoverageReader } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMedicaidRevalidate } from "../src/modules/24-billing-medicaid/jobs/revalidate-jobs";
import { buildM24MedicarePrimaryAckConsumer } from "../src/modules/24-billing-medicaid/outbox-consumers/m24-medicare-primary-ack";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)(
  "M24 revalidate + medicare-primary-ack consumers — LIVE Postgres (F-165, #248)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let peA: string;
    let peB: string;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    async function seedOrg(orgId: string, slug: string): Promise<string> {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, slug],
      );
      const pe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'PE',$3,'enc','0930') RETURNING id`,
        [
          orgId,
          slug === "org-a" ? "111111" : "222222",
          // `provider_entity_npi_idx` is globally unique — the same literal NPI for both orgs' PEs
          // collided the instant a second org was seeded.
          slug === "org-a" ? "1234567890" : "1234567891",
        ],
      );
      return pe.rows[0].id;
    }

    /** Seed one `medicaid_claim` row directly (bypassing `assembleClaim`'s clinical-seam requirements —
     *  this suite tests the STATE MACHINE + write path, not per-line assembly). */
    async function seedClaim(args: {
      readonly orgId: string;
      readonly providerEntityId: string;
      readonly state: string;
      readonly patientId?: string;
      readonly medicareClaimId?: string | null;
    }): Promise<{
      readonly id: string;
      readonly patientId: string;
      readonly patientPayerId: string;
    }> {
      const claimId = randomUUID();
      const patientId = args.patientId ?? randomUUID();
      const patientPayerId = randomUUID();
      const controlNumber = `CN-${claimId.slice(0, 8)}`;
      await admin.query(
        `INSERT INTO medicaid_claim
           (id, organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
            service_state, kind, tob, service_from, service_to, state_plan_code_id,
            state_plan_code_snapshot, medicare_claim_id, medicare_secondary_context_snapshot,
            medicaid_claim_control_number, state, version, created_by_membership_id, updated_by_membership_id)
         VALUES
           ($1,$2,$3,$4,$5,$6,
            'OR','hospice_only','811','2026-01-01','2026-01-31',$7,
            'OHP-STD',$8,$9,
            $10,$11,1,$12,$12)`,
        [
          claimId,
          args.orgId,
          args.providerEntityId,
          patientId,
          patientPayerId,
          randomUUID(),
          randomUUID(),
          args.medicareClaimId ?? null,
          args.medicareClaimId
            ? JSON.stringify({ syntheticFixture: true, evidenceStatus: "unknown" })
            : null,
          controlNumber,
          args.state,
          USER,
        ],
      );
      return { id: claimId, patientId, patientPayerId };
    }

    async function loadClaim(claimId: string) {
      const { rows } = await admin.query(
        "SELECT state, version, updated_by_membership_id, validation_run_id_latest FROM medicaid_claim WHERE id=$1",
        [claimId],
      );
      return rows[0] as {
        state: string;
        version: number;
        updated_by_membership_id: string;
        validation_run_id_latest: string | null;
      };
    }

    async function historyFor(claimId: string) {
      const { rows } = await admin.query(
        "SELECT from_state, to_state, trigger_source, actor_membership_id, reason FROM medicaid_claim_state_history WHERE medicaid_claim_id=$1 ORDER BY at",
        [claimId],
      );
      return rows;
    }

    function fakeOutbox() {
      const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
      return {
        published,
        port: {
          async publish(
            _tx: unknown,
            event: { eventName: string; payload: Record<string, unknown> },
          ) {
            published.push({ eventName: event.eventName, payload: event.payload });
          },
        },
      };
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m24revalidate@x.test')`, [USER]);
      peA = await seedOrg(ORG_A, "org-a");
      peB = await seedOrg(ORG_B, "org-b");
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("runMedicaidRevalidate: a READY claim re-runs the rule cycle, transitions, records consumer-attributed history, and never touches updated_by_membership_id", async () => {
      const claim = await seedClaim({ orgId: ORG_A, providerEntityId: peA, state: "READY" });
      const outbox = fakeOutbox();

      const before = await loadClaim(claim.id);
      expect(before.state).toBe("READY");
      expect(before.updated_by_membership_id).toBe(USER);

      await withTx(ORG_A, async (tx) => {
        await runMedicaidRevalidate(
          tx,
          { connection: {} as never, db: handle.db, outbox: outbox.port },
          {
            organizationId: ORG_A,
            eventId: randomUUID(),
            eventName: "m5.patient.updated",
            patientId: claim.patientId,
          },
        );
      });

      const after = await loadClaim(claim.id);
      // The rule cycle ran and landed on one of its two real outcomes.
      expect(["READY", "FAILED_VALIDATION"]).toContain(after.state);
      expect(after.validation_run_id_latest).not.toBeNull();
      // The claim's real human editor stays on record — the F-144 lesson applied to this consumer.
      expect(after.updated_by_membership_id).toBe(USER);

      const hist = await historyFor(claim.id);
      expect(hist).toHaveLength(2);
      expect(hist[0]).toMatchObject({
        from_state: "READY",
        to_state: "VALIDATING",
        trigger_source: "consumer",
        actor_membership_id: null,
        reason: "m5.patient.updated",
      });
      expect(hist[1]).toMatchObject({
        to_state: after.state,
        trigger_source: "consumer",
        actor_membership_id: null,
      });

      expect(outbox.published.map((p) => p.eventName)).toContain(
        "m24.medicaid_claim.validation_started",
      );
      expect(outbox.published.some((p) => p.eventName.startsWith("m24.medicaid_claim."))).toBe(
        true,
      );

      const vr = await admin.query(
        "SELECT triggered_by, actor_membership_id, trigger_signal_id FROM medicaid_validation_run WHERE id=$1",
        [after.validation_run_id_latest],
      );
      expect(vr.rows[0]).toMatchObject({
        triggered_by: "re_validation_after_correction",
        actor_membership_id: null,
      });
    });

    it("runMedicaidRevalidate: a legacy Medicare link cannot become ready despite resolved primary Medicaid", async () => {
      const claim = await seedClaim({
        orgId: ORG_A,
        providerEntityId: peA,
        state: "READY",
        medicareClaimId: randomUUID(),
      });
      const outbox = fakeOutbox();
      const coverage: PatientCoverage = {
        id: claim.patientPayerId,
        patientId: claim.patientId,
        payerId: randomUUID(),
        rank: 1,
        coverageKind: "medicaid",
        subscriberId: "synthetic-member-0001",
        groupNumber: null,
        current: true,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      };
      const coverages: Pick<PatientCoverageReader, "coverageSnapshotForRangeInTransaction"> = {
        async coverageSnapshotForRangeInTransaction(_transaction, input) {
          expect(input.patientId).toBe(claim.patientId);
          return {
            coverages: [coverage],
            resolution: { status: "uniform", coverage },
            primaryResolution: { status: "uniform", coverage },
          };
        },
      };

      await withTx(ORG_A, async (tx) => {
        await runMedicaidRevalidate(
          tx,
          { connection: {} as never, db: handle.db, outbox: outbox.port, coverages },
          {
            organizationId: ORG_A,
            eventId: randomUUID(),
            eventName: "m5.patient.updated",
            patientId: claim.patientId,
          },
        );
      });

      const after = await loadClaim(claim.id);
      expect(after.state).toBe("FAILED_VALIDATION");
      const result = await admin.query(
        "SELECT rule_key, outcome FROM medicaid_validation_result WHERE medicaid_validation_run_id=$1 AND organization_id=$2",
        [after.validation_run_id_latest, ORG_A],
      );
      expect(result.rows).toContainEqual({
        rule_key: "medicaid_medicare_linkage_supported",
        outcome: "fail",
      });
      expect(outbox.published.map((event) => event.eventName)).toContain(
        "m24.medicaid_claim.validation_failed",
      );
      expect(outbox.published.map((event) => event.eventName)).not.toContain(
        "m24.medicaid_claim.ready_for_submission",
      );
    });

    it("runMedicaidRevalidate: a DRAFT claim (not revalidate-eligible) is silently skipped", async () => {
      const claim = await seedClaim({ orgId: ORG_A, providerEntityId: peA, state: "DRAFT" });
      const outbox = fakeOutbox();

      await withTx(ORG_A, async (tx) => {
        await runMedicaidRevalidate(
          tx,
          { connection: {} as never, db: handle.db, outbox: outbox.port },
          {
            organizationId: ORG_A,
            eventId: randomUUID(),
            eventName: "m8.encounter.signed",
            patientId: claim.patientId,
          },
        );
      });

      const after = await loadClaim(claim.id);
      expect(after.state).toBe("DRAFT");
      expect(after.validation_run_id_latest).toBeNull();
      expect(outbox.published).toHaveLength(0);
      expect(await historyFor(claim.id)).toHaveLength(0);
    });

    it("medicare-primary-ack: a technical acknowledgment does not advance an awaiting Medicaid claim", async () => {
      const medicareClaimId = randomUUID();
      const claim = await seedClaim({
        orgId: ORG_A,
        providerEntityId: peA,
        state: "AWAITING_MEDICARE_PRIMARY",
        medicareClaimId,
      });
      const outbox = fakeOutbox();
      const consumer = buildM24MedicarePrimaryAckConsumer({ db: handle.db, outbox: outbox.port });

      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        eventType: "m23.claim.acknowledged",
        aggregateKind: "claim",
        aggregateId: medicareClaimId,
        payload: {
          claimId: medicareClaimId,
          acknowledgmentId: randomUUID(),
          payerClaimControlNumber: "PCCN-1",
        },
        attemptCount: 1,
        createdAt: new Date(),
      });

      const after = await loadClaim(claim.id);
      expect(after.state).toBe("AWAITING_MEDICARE_PRIMARY");
      expect(await historyFor(claim.id)).toHaveLength(0);
      expect(outbox.published).toHaveLength(0);
    });

    it("medicare-primary-ack: a technical acknowledgment does not clear FAILED_MEDICARE_PRIMARY", async () => {
      const medicareClaimId = randomUUID();
      const claim = await seedClaim({
        orgId: ORG_A,
        providerEntityId: peA,
        state: "FAILED_MEDICARE_PRIMARY",
        medicareClaimId,
      });
      const outbox = fakeOutbox();
      const consumer = buildM24MedicarePrimaryAckConsumer({ db: handle.db, outbox: outbox.port });

      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        eventType: "m23.claim.acknowledged",
        aggregateKind: "claim",
        aggregateId: medicareClaimId,
        payload: {
          claimId: medicareClaimId,
          acknowledgmentId: randomUUID(),
          payerClaimControlNumber: null,
        },
        attemptCount: 1,
        createdAt: new Date(),
      });

      expect((await loadClaim(claim.id)).state).toBe("FAILED_MEDICARE_PRIMARY");
      expect(outbox.published).toHaveLength(0);
      expect(await historyFor(claim.id)).toHaveLength(0);
    });

    it("medicare-primary-ack: a PAID claim sharing the same medicare_claim_id is left alone (not eligible)", async () => {
      const medicareClaimId = randomUUID();
      const claim = await seedClaim({
        orgId: ORG_A,
        providerEntityId: peA,
        state: "PAID",
        medicareClaimId,
      });
      const outbox = fakeOutbox();
      const consumer = buildM24MedicarePrimaryAckConsumer({ db: handle.db, outbox: outbox.port });

      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        eventType: "m23.claim.acknowledged",
        aggregateKind: "claim",
        aggregateId: medicareClaimId,
        payload: {
          claimId: medicareClaimId,
          acknowledgmentId: randomUUID(),
          payerClaimControlNumber: null,
        },
        attemptCount: 1,
        createdAt: new Date(),
      });

      expect((await loadClaim(claim.id)).state).toBe("PAID");
      expect(outbox.published).toHaveLength(0);
      expect(await historyFor(claim.id)).toHaveLength(0);
    });

    it("medicare-primary-ack: cross-tenant isolation — org B's held claim (same medicare_claim_id) is untouched by org A's event", async () => {
      const medicareClaimId = randomUUID();
      const claimA = await seedClaim({
        orgId: ORG_A,
        providerEntityId: peA,
        state: "AWAITING_MEDICARE_PRIMARY",
        medicareClaimId,
      });
      const claimB = await seedClaim({
        orgId: ORG_B,
        providerEntityId: peB,
        state: "AWAITING_MEDICARE_PRIMARY",
        medicareClaimId,
      });
      const outbox = fakeOutbox();
      const consumer = buildM24MedicarePrimaryAckConsumer({ db: handle.db, outbox: outbox.port });

      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        eventType: "m23.claim.acknowledged",
        aggregateKind: "claim",
        aggregateId: medicareClaimId,
        payload: {
          claimId: medicareClaimId,
          acknowledgmentId: randomUUID(),
          payerClaimControlNumber: null,
        },
        attemptCount: 1,
        createdAt: new Date(),
      });

      expect((await loadClaim(claimA.id)).state).toBe("AWAITING_MEDICARE_PRIMARY");
      expect((await loadClaim(claimB.id)).state).toBe("AWAITING_MEDICARE_PRIMARY");
      expect(outbox.published).toHaveLength(0);
      expect(await historyFor(claimA.id)).toHaveLength(0);
      expect(await historyFor(claimB.id)).toHaveLength(0);
    });

    /** Run `fn` inside a real `withOrgContext`-shaped transaction for the given org — `runMedicaidRevalidate`
     *  expects the tx it receives to already carry `app.org_id`. */
    async function withTx<T>(orgId: string, fn: (tx: never) => Promise<T>): Promise<T> {
      const { withOrgContext } = await import("@chartwarden/tenancy");
      return withOrgContext(handle.db, { organizationId: orgId, userId: "" }, (tx) =>
        fn(tx as never),
      );
    }
  },
);
