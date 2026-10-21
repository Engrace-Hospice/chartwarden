/** Live persistence/idempotency proof for the M14/M17 downstream consumer reconciliation. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { activeAdmissionDraftContextForPatient } from "../src/modules/06-admission/index";
import { M11_OUTBOX_EVENTS, buildM11IdgDecisionConsumer } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS, buildM12IdgDecisionConsumer } from "../src/modules/12-dosespot/index";
import { buildM16IdgDecisionConsumer } from "../src/modules/16-bereavement/index";
import { buildM18VisitPublishedConsumer } from "../src/modules/18-evv/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PATIENT = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("M14/M17 clinical consumers — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let membershipId: string;
  let admissionId: string;
  let providerEntityId: string;
  let locationId: string;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((candidate) => candidate.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  function idgEnvelope(decisionId: string, payload: Record<string, unknown>) {
    return {
      decisionId,
      meetingId: "55555555-5555-4555-8555-555555555555",
      patientId: PATIENT,
      organizationId: ORG,
      decisionKind: payload.kind,
      payload,
      payloadSchemaVersion: "2026-01-v1",
      recordedByMembershipId: membershipId,
      recordedAt: "2026-08-04T18:00:00.000Z",
      meetingAdjournedAt: "2026-08-04T18:05:00.000Z",
      wasQuorate: true,
      quorumSnapshot: { met: true, presentDisciplines: ["rn", "md"], missingDisciplines: [] },
    };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'consumer-test','Consumer Test','Consumer Test')`,
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'consumer@x.test')`, [USER]);
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id,organization_id,status)
         VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'CONSUMER-CCN','Consumer Provider','CONSUMER-NPI','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    locationId = (
      await admin.query(
        `INSERT INTO location
           (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
         VALUES ($1,'Consumer Location','1 Main','Portland','OR','97000','America/Los_Angeles')
         RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id as string;
    admissionId = (
      await admin.query(
        `INSERT INTO admission (organization_id,provider_entity_id,location_id,patient_id,status,
           attending_physician_id,activated_at)
         VALUES ($1,$2,$3,$4,'active',$5,now()) RETURNING id`,
        [ORG, providerEntityId, locationId, PATIENT, PHYSICIAN],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("creates idempotent M11 draft orders and M12 medication drafts", async () => {
    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M12_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const resolveAdmissionContext = (organizationId: string, patientId: string) =>
      activeAdmissionDraftContextForPatient(handle.db, organizationId, patientId);
    const m11 = buildM11IdgDecisionConsumer({
      db: handle.db,
      resolveAdmissionContext,
      outbox: {
        publish: (tx, event) => publisher.publish(tx, { ...event, callerModule: "m11" }),
      },
    });
    const m12 = buildM12IdgDecisionConsumer({
      db: handle.db,
      resolveAdmissionContext,
      outbox: {
        publish: (tx, event) => publisher.publish(tx, { ...event, callerModule: "m12" }),
      },
    });

    const orderEvent = {
      organizationId: ORG,
      payload: idgEnvelope("66666666-6666-4666-8666-666666666666", {
        kind: "order_request",
        requestedOrders: [
          {
            kindHint: "dme",
            narrative: "Pressure-relief mattress review",
            recommendedTimeframe: "within 24 hours",
            // M14 allows null here; the M11 `idg_requested.v1` registry types it `Optional(uuid)`, so the
            // consumer must leave a null out of the order payload rather than fail the registry check.
            triggeringProblemId: null,
          },
        ],
      }),
    };
    await m11.handle(orderEvent);
    await m11.handle(orderEvent);

    const medicationEvent = {
      organizationId: ORG,
      payload: idgEnvelope("77777777-7777-4777-8777-777777777777", {
        kind: "medication_recommendation",
        recommendations: [
          {
            recommendationKind: "add",
            drugLabel: "Comfort medication",
            proposedStrength: "5 mg",
            proposedRoute: "oral",
            proposedFrequency: "as reviewed by prescriber",
            triggeringProblemId: null,
            rationaleText: "IDG symptom review",
          },
        ],
      }),
    };
    await m12.handle(medicationEvent);
    await m12.handle(medicationEvent);

    const orders = await admin.query(
      `SELECT kind,status,triggering_idg_decision_id,admission_id FROM order_record
       WHERE triggering_idg_decision_id=$1`,
      ["66666666-6666-4666-8666-666666666666"],
    );
    expect(orders.rows).toEqual([
      expect.objectContaining({
        kind: "idg_requested",
        status: "draft",
        admission_id: admissionId,
      }),
    ]);
    const medications = await admin.query(
      `SELECT status,is_controlled_substance,triggering_idg_decision_id,admission_id
       FROM medication_order WHERE triggering_idg_decision_id=$1`,
      ["77777777-7777-4777-8777-777777777777"],
    );
    expect(medications.rows).toEqual([
      expect.objectContaining({
        status: "draft",
        is_controlled_substance: false,
        admission_id: admissionId,
      }),
    ]);
  });

  it("persists an idempotent M16 reassessment flag with audit redaction", async () => {
    const consumer = buildM16IdgDecisionConsumer({ db: handle.db });
    const event = {
      organizationId: ORG,
      payload: idgEnvelope("88888888-8888-4888-8888-888888888888", {
        kind: "bereavement_risk_flag",
        riskLevel: "high",
        rationaleText: "Sensitive family rationale",
      }),
    };
    await consumer.handle(event);
    await consumer.handle(event);
    const flags = await admin.query(
      "SELECT status,risk_level FROM bereavement_idg_risk_flag WHERE idg_decision_id=$1",
      ["88888888-8888-4888-8888-888888888888"],
    );
    expect(flags.rows).toEqual([{ status: "pending_assessment", risk_level: "high" }]);
    const audit = await admin.query(
      `SELECT after::text AS after_text FROM audit_event
       WHERE resource_kind='bereavement_idg_risk_flag' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.after_text).not.toContain("Sensitive family rationale");
  });

  it("upserts the M18-owned visit publication snapshot", async () => {
    const consumer = buildM18VisitPublishedConsumer({ db: handle.db });
    const event = {
      id: "99999999-9999-4999-8999-999999999999",
      organizationId: ORG,
      payload: {
        organizationId: ORG,
        visitId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        patientId: PATIENT,
        admissionId,
        assignedMembershipId: membershipId,
        assignedDiscipline: "rn",
        encounterType: "routine_visit",
        serviceDate: "2026-08-05",
        providerEntityId,
        locationId,
        visitPurpose: "routine_visit",
        visitSetting: "home",
        scheduledStartedAt: "2026-08-05T16:00:00.000Z",
        scheduledEndedAt: "2026-08-05T17:00:00.000Z",
        patientAddressId: null,
        externalFacilityId: null,
        parentRecurringVisitId: null,
        parentProposalId: null,
      },
    };
    await consumer.handle(event);
    await consumer.handle(event);
    const registrations = await admin.query(
      `SELECT admission_id,service_type_code,source_outbox_event_id
       FROM evv_visit_registration WHERE visit_id=$1`,
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    );
    expect(registrations.rows).toEqual([
      {
        admission_id: admissionId,
        service_type_code: "routine_visit",
        source_outbox_event_id: event.id,
      },
    ]);
  });
});
