/**
 * F-120 (#248) — M21's live binding for two of the three M11 cascade deciders in `consumers/m11-orders.ts`,
 * over real Postgres.
 *
 * `decideSupplyCancellationCascade` (§7.7) and `decideOrderDiscontinued` (§2.2 DME monthly-rental
 * close-out) have been complete, exported and unit-tested since M21-T04, and their own file's header says
 * "the live outbox binding + the transactional insert land with the §4.6 workers alongside the M21-T05
 * service layer" — the service layer landed; nothing ever bound them. `m11.order.supply_cancellation_
 * requested` and `m11.order.discontinued` are ALREADY EMITTED in production by the M11 discharge cascade
 * (F-102), so every discharge/death on an admission with an open `supply_request` has been cancelling the
 * M11 order while leaving the DME rental or comfort-kit request standing.
 *
 * Nothing is stubbed: the REAL M6 write service discharges / the REAL M11 write service discontinues as the
 * NOBYPASSRLS `wardenx_app` role → the REAL catalog-validating publisher writes the outbox rows → the REAL
 * `createOutboxDispatcher` claims and delivers them → M11's discharge-cascade consumer AND M21's two new
 * consumers read their own tables under RLS and write the transitions.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m21:order-cascade:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import {
  M11_OUTBOX_EVENTS,
  type OrderWriteOutboxPort,
  buildM11DischargeCascadeConsumer,
  createDbOrderBackend,
} from "../src/modules/11-orders/index";
import { SYSTEM_ORDER_ACTOR } from "../src/modules/11-orders/routes/service";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import {
  M21_OUTBOX_EVENTS,
  buildM21OrderDiscontinuedConsumer,
  buildM21SupplyCancellationConsumer,
} from "../src/modules/21-supplies/index";
import { M22_OUTBOX_EVENTS } from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";

const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";

const DRAFT = {
  electedProviderEntityId: "",
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
};
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)("F-120 — M21's M11 order cascade, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let admissionSvc: ReturnType<typeof createDbAdmissionRouteService>;
  let orderSvc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let providerEntityId: string;
  let locationId: string;
  let memberId: string;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  async function seedOrder(
    admissionId: string,
    patientId: string,
    kind: string,
    status: string,
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO order_record (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, kind, kind_version, data, status, drafter_membership_id, drafter_discipline,
         ordering_physician_mdm_id)
       VALUES ($1,$2,$3,$4,$5,$6,'v1','{}'::jsonb,$7,$8,'rn_case_manager',$9) RETURNING id`,
      [
        ORG_A,
        providerEntityId,
        locationId,
        patientId,
        admissionId,
        kind,
        status,
        memberId,
        PHYSICIAN_MDM,
      ],
    );
    return rows[0].id as string;
  }

  async function seedSupplyRequest(
    orderId: string,
    admissionId: string,
    patientId: string,
    kind: string,
    status: string,
    data: Record<string, unknown> = {},
  ): Promise<string> {
    const needsRouting = !["requested", "cancelled", "cancellation_pending"].includes(status);
    const { rows } = await admin.query(
      `INSERT INTO supply_request (organization_id, patient_id, admission_id, location_id,
         provider_entity_id, source_order_id, kind, data, status, routing_rule_resolved_jsonb)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        ORG_A,
        patientId,
        admissionId,
        locationId,
        providerEntityId,
        orderId,
        kind,
        JSON.stringify(data),
        status,
        needsRouting
          ? JSON.stringify({
              assignedFulfillmentMode: "internal_hub",
              assignedVendorId: null,
              candidatesConsidered: [],
              routingPolicyDigest: "test",
            })
          : null,
      ],
    );
    return rows[0].id as string;
  }

  async function supplyRequestRow(id: string) {
    const { rows } = await admin.query(
      "SELECT status, cancellation_reason, cancelled_at, completed_at FROM supply_request WHERE id=$1",
      [id],
    );
    return rows[0] as {
      status: string;
      cancellation_reason: string | null;
      cancelled_at: Date | null;
      completed_at: Date | null;
    };
  }
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  async function activeAdmission(patientId: string): Promise<string> {
    const { admissionId } = await admitViaQualifiedReferral(admissionSvc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periods = await admissionSvc.listElectionPeriods(ORG_A, admissionId);
    const periodId = periods?.[0]?.id as string;
    const nor = await admissionSvc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await admissionSvc.draftElectionStatement(ORG_A, admissionId, periodId, {
      ...DRAFT,
      electedProviderEntityId: providerEntityId,
    });
    await admissionSvc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await admissionSvc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await admissionSvc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    await admissionSvc.activateAdmission(ORG_A, admissionId, nor.version);
    return admissionId;
  }

  async function discharge(admissionId: string): Promise<void> {
    const adm = await admissionSvc.getAdmission(ORG_A, admissionId);
    await admissionSvc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "moved_out_of_service_area",
        dischargeDate: new Date().toISOString().slice(0, 10),
        narrative: "The patient relocated out of the service area and elects another hospice.",
        ifVersion: adm?.version,
      } as never,
      USER,
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG_A],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f120a@x.test'),($2,'f120md@x.test'),($3,'f120at@x.test')`,
      [USER, MD, ATTENDING],
    );
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-A','Hospice A','NPI-A','\\x00','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    locationId = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id as string;
    memberId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);

    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M20_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
    ]);
    const publisher = buildTxOutboxPublisher(catalog);
    const bind = (module: string) => ({
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: module } as never),
    });

    admissionSvc = createDbAdmissionRouteService(handle.db, bind("m6") as never, undefined, {
      async belongsToOrg(organizationId: string, pe: string) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [pe, organizationId],
        );
        return rows.length > 0;
      },
    });
    orderSvc = createDbOrderBackend(handle.db, bind("m11") as OrderWriteOutboxPort);

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM11DischargeCascadeConsumer({ db: handle.db, outbox: bind("m11") as never }),
        buildM21SupplyCancellationConsumer({ db: handle.db, outbox: bind("m21") as never }),
        buildM21OrderDiscontinuedConsumer({ db: handle.db, outbox: bind("m21") as never }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("cancels a pre-ordered supply_request immediately when the source order is discharge-cascaded", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const order = await seedOrder(admissionId, patientId, "dme", "active");
    const request = await seedSupplyRequest(order, admissionId, patientId, "dme", "requested");

    await discharge(admissionId);
    await dispatcher.tick(); // m6.admission.discharged -> m11 discharge cascade
    await dispatcher.tick(); // m11.order.supply_cancellation_requested / .discontinued -> m21

    const row = await supplyRequestRow(request);
    expect(row.status).toBe("cancelled");
    expect(row.cancellation_reason).toBe("m11_cancellation_cascade");
    expect(row.cancelled_at).not.toBeNull();
    const events = await eventsFor(request);
    expect(events).toContain("m21.supply_request.status_changed");
    expect(events).toContain("m21.supply_request.cancelled");
  });

  it("moves a post-ordered supply_request to cancellation_pending, with no `cancelled` event yet", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const order = await seedOrder(admissionId, patientId, "dme", "active");
    const request = await seedSupplyRequest(order, admissionId, patientId, "dme", "ordered");

    await discharge(admissionId);
    await dispatcher.tick(); // m6.admission.discharged -> m11 discharge cascade
    await dispatcher.tick(); // m11.order.supply_cancellation_requested / .discontinued -> m21

    const row = await supplyRequestRow(request);
    expect(row.status).toBe("cancellation_pending");
    const events = await eventsFor(request);
    expect(events).toContain("m21.supply_request.status_changed");
    expect(events).not.toContain("m21.supply_request.cancelled");
  });

  it("emits cancel_no_op for a request that already reached a terminal state — M11 learns the cascade arrived", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const order = await seedOrder(admissionId, patientId, "dme", "active");
    const request = await seedSupplyRequest(order, admissionId, patientId, "dme", "completed");

    await discharge(admissionId);
    await dispatcher.tick(); // m6.admission.discharged -> m11 discharge cascade
    await dispatcher.tick(); // m11.order.supply_cancellation_requested / .discontinued -> m21

    const row = await supplyRequestRow(request);
    expect(row.status).toBe("completed"); // untouched
    expect(await eventsFor(request)).toEqual(["m21.supply_request.cancel_no_op"]);
  });

  it("is a silent no-op when no supply_request was ever opened for the order (no_match)", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const order = await seedOrder(admissionId, patientId, "dme", "active");

    await discharge(admissionId);
    await expect(dispatcher.tick()).resolves.not.toThrow();
    expect(await eventsFor(order)).toContain("m11.order.discontinued");
  });

  it("completes a monthly DME rental when M11 discontinues the order directly (no discharge involved)", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const order = await seedOrder(admissionId, patientId, "dme", "active");
    // `completeRequest` (packages/supplies/src/lifecycle.ts) is legal only from `received_confirmed` — a
    // rental waits there indefinitely (autoCompletesOnReceipt is false for a monthly cadence) until this
    // consumer's `m11.order.discontinued` binding moves it to `completed`.
    const request = await seedSupplyRequest(
      order,
      admissionId,
      patientId,
      "dme",
      "received_confirmed",
      {
        rentalCadence: "monthly",
      },
    );

    await orderSvc.discontinueOrder(
      ORG_A,
      memberId,
      order,
      {
        reason: "clinical_judgement",
        effectiveAt: new Date().toISOString(),
      } as never,
      SYSTEM_ORDER_ACTOR,
    );
    await dispatcher.tick();

    const row = await supplyRequestRow(request);
    expect(row.status).toBe("completed");
    expect(row.completed_at).not.toBeNull();
    expect(await eventsFor(request)).toContain("m21.supply_request.status_changed");
  });

  it("leaves a one-shot supply request alone on discontinuation — it self-completes on receipt, not on M11's say-so", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(patientId);
    const order = await seedOrder(admissionId, patientId, "supply", "active");
    const request = await seedSupplyRequest(order, admissionId, patientId, "supply", "delivered");

    await orderSvc.discontinueOrder(
      ORG_A,
      memberId,
      order,
      {
        reason: "clinical_judgement",
        effectiveAt: new Date().toISOString(),
      } as never,
      SYSTEM_ORDER_ACTOR,
    );
    await dispatcher.tick();

    const row = await supplyRequestRow(request);
    expect(row.status).toBe("delivered"); // untouched — no_op
  });
});
