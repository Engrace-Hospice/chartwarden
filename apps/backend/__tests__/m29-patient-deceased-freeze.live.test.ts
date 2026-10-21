/**
 * F-165 (#248) — M29's `m5.patient.deceased` freeze consumer, END TO END over real Postgres.
 *
 * M29's own spec text (dependsOn 5) reads: "`m5.patient.deceased` consumed via outbox to freeze inbound
 * ADT processing for the decedent and to refuse any post-death A01/A04 events with a typed
 * OperationOutcome." This suite proves the FIRST half — `buildM29PatientDeceasedConsumer` expiring every
 * still-`pending` `hl7_inbound_proposal` matched to the decedent via the (previously never-called)
 * `expireProposal` pure decider. The SECOND half (real-time refusal of a FUTURE post-death ADT) is not
 * built — see the consumer file's own header for why — and is not exercised here.
 *
 * `m5.patient.deceased` already declares `m29` in `declaredConsumers` (F-141's own kept-pair finding), and
 * `m29.hl7_inbound_proposal.expired` is newly catalogued in this same pass (it had no catalog entry at
 * all before F-165), so this suite drives the real `M5_OUTBOX_EVENTS` / `M29_OUTBOX_EVENTS` catalogs
 * straight through the `Value.Check`-validated publisher with no fixture patching.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m29:patient-deceased-freeze:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import {
  type OutboxConsumerBinding,
  createOutboxDispatcher,
} from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/index";
import {
  M29_OUTBOX_EVENTS,
  buildM29PatientDeceasedConsumer,
} from "../src/modules/29-external-interfaces/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-165 — M29's m5.patient.deceased proposal-freeze consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    async function seedProposal(opts: {
      organizationId: string;
      matchedPatientId: string | null;
      proposalStatus: "pending" | "accepted" | "rejected" | "expired";
    }): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO hl7_inbound_proposal
           (organization_id, source_message_id, resource_kind, proposed_patient_candidate,
            match_outcome, matched_patient_id, proposal_status, decided_by_membership_id, decided_at,
            expires_at)
         VALUES ($1, $2, 'patient_demographic_update', $3::jsonb,
                 $4, $5, $6, $7, $8, now() + interval '72 hours')
         RETURNING id`,
        [
          opts.organizationId,
          randomUUID(),
          JSON.stringify({ lastName: "Doe", firstName: "Jane" }),
          opts.matchedPatientId ? "matched_single" : "no_match",
          opts.matchedPatientId,
          opts.proposalStatus,
          opts.proposalStatus === "pending" ? null : randomUUID(),
          opts.proposalStatus === "pending" ? null : new Date().toISOString(),
        ],
      );
      return rows[0].id as string;
    }

    async function proposalRow(id: string) {
      const { rows } = await admin.query(
        `SELECT id, proposal_status, decided_by_membership_id, decision_rationale, decided_at
           FROM hl7_inbound_proposal WHERE id = $1`,
        [id],
      );
      return rows[0];
    }

    async function expiredEventCount(proposalId: string): Promise<number> {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM outbox_event
           WHERE event_type = 'm29.hl7_inbound_proposal.expired' AND aggregate_id = $1`,
        [proposalId],
      );
      return rows[0].n as number;
    }

    const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS, M29_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const bind = (callerModule: string) => ({
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule } as never),
    });

    async function publishDeceased(
      organizationId: string,
      patientId: string,
      deceasedDate: string,
    ) {
      await withOrgContext(handle.db, { organizationId, userId: "" }, async (tx) => {
        await bind("m5").publish(tx as never, {
          eventName: "m5.patient.deceased",
          payload: { patientId, organizationId, deceasedDate },
          organizationId,
          aggregateKind: "patient",
          aggregateId: patientId,
        });
      });
    }

    function makeDispatcher(consumers: readonly OutboxConsumerBinding[]) {
      const orgs: ActiveOrgEnumerator = {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      };
      return createOutboxDispatcher({
        db: handle.db,
        orgs,
        consumers,
        eventCatalog: catalog,
        options: { log: () => {} },
      });
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m29-deceased-freeze-a','M29 Deceased Freeze A','M29 Deceased Freeze A'),
                ($2,'m29-deceased-freeze-b','M29 Deceased Freeze B','M29 Deceased Freeze B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("expires a pending proposal matched to the decedent", async () => {
      const patientId = randomUUID();
      const proposalId = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: patientId,
        proposalStatus: "pending",
      });

      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, patientId, "2026-05-01");
      await dispatcher.tick();

      const row = await proposalRow(proposalId);
      expect(row.proposal_status).toBe("expired");
      expect(row.decided_by_membership_id).toBeNull();
      expect(row.decision_rationale).toBe("patient_deceased_freeze");
      expect(row.decided_at).not.toBeNull();
      expect(await expiredEventCount(proposalId)).toBe(1);
    });

    it("leaves a pending proposal matched to a DIFFERENT patient untouched", async () => {
      const deceasedPatientId = randomUUID();
      const otherPatientId = randomUUID();
      const otherProposalId = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: otherPatientId,
        proposalStatus: "pending",
      });

      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, deceasedPatientId, "2026-05-02");
      await dispatcher.tick();

      const row = await proposalRow(otherProposalId);
      expect(row.proposal_status).toBe("pending");
    });

    it("leaves an already-decided (accepted) proposal for the decedent untouched — decided-is-decided", async () => {
      const patientId = randomUUID();
      const acceptedProposalId = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: patientId,
        proposalStatus: "accepted",
      });
      const before = await proposalRow(acceptedProposalId);

      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, patientId, "2026-05-03");
      await dispatcher.tick();

      const after = await proposalRow(acceptedProposalId);
      expect(after.proposal_status).toBe("accepted");
      expect(after.decided_by_membership_id).toBe(before.decided_by_membership_id);
    });

    it("leaves an unmatched proposal (matched_patient_id IS NULL) untouched", async () => {
      const patientId = randomUUID();
      const unmatchedId = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: null,
        proposalStatus: "pending",
      });

      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, patientId, "2026-05-04");
      await dispatcher.tick();

      const row = await proposalRow(unmatchedId);
      expect(row.proposal_status).toBe("pending");
    });

    it("does not leak across tenants — org B's proposal for the same patient id is untouched", async () => {
      const patientId = randomUUID();
      const proposalA = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: patientId,
        proposalStatus: "pending",
      });
      const proposalB = await seedProposal({
        organizationId: ORG_B,
        matchedPatientId: patientId,
        proposalStatus: "pending",
      });

      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, patientId, "2026-05-05");
      await dispatcher.tick();

      expect((await proposalRow(proposalA)).proposal_status).toBe("expired");
      expect((await proposalRow(proposalB)).proposal_status).toBe("pending");
    });

    it("expires multiple pending proposals matched to the same decedent in one delivery", async () => {
      const patientId = randomUUID();
      const p1 = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: patientId,
        proposalStatus: "pending",
      });
      const p2 = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: patientId,
        proposalStatus: "pending",
      });

      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, patientId, "2026-05-06");
      await dispatcher.tick();

      expect((await proposalRow(p1)).proposal_status).toBe("expired");
      expect((await proposalRow(p2)).proposal_status).toBe("expired");
    });

    it("is idempotent against a redelivery — already-expired rows are not re-processed", async () => {
      const patientId = randomUUID();
      const proposalId = await seedProposal({
        organizationId: ORG_A,
        matchedPatientId: patientId,
        proposalStatus: "pending",
      });

      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, patientId, "2026-05-07");
      await dispatcher.tick();
      expect((await proposalRow(proposalId)).proposal_status).toBe("expired");
      expect(await expiredEventCount(proposalId)).toBe(1);

      await admin.query("DELETE FROM outbox_consumer_receipt");
      await admin.query(
        "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type='m5.patient.deceased'",
      );
      await dispatcher.tick();

      // Still exactly one expiry — the SELECT filters on proposal_status='pending', so an already-expired
      // row is invisible to the redelivered consumer and no second .expired event is published.
      expect((await proposalRow(proposalId)).proposal_status).toBe("expired");
      expect(await expiredEventCount(proposalId)).toBe(1);
    });

    it("is a true no-op when the decedent has no proposals at all", async () => {
      const dispatcher = makeDispatcher([
        buildM29PatientDeceasedConsumer({ db: handle.db, outbox: bind("m29") as never }),
      ]);
      await publishDeceased(ORG_A, randomUUID(), "2026-05-08");
      // No proposal matches this patient — the SELECT returns an empty set and the handler returns
      // cleanly with no UPDATE or publish attempted. A throw here would fail the test.
      await dispatcher.tick();
    });
  },
);
