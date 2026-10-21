/**
 * F-102 — the M6 discharge cascade, END TO END over real Postgres.
 *
 * When a patient is discharged — death, revocation, transfer, live discharge — every order still in flight
 * on that admission is supposed to be system-discontinued: §2.6 D13 / W-DC-02 for M11's orders, §2.2 D13
 * for M12's medication orders. Both deciders have been complete, exported and unit-tested since M11-T07 /
 * M12-T08, and the only caller either has ever had is its own test file.
 *
 * NEITHER COULD HAVE BEEN BOUND. `m6.admission.discharged` did not name m11 or m12 in its
 * `declaredConsumers`, and `assertBindableAgainstCatalog` refuses a binding whose module the catalog does
 * not declare — so the absence was two-sided, and each side made the other look like someone else's
 * problem. A pending-signature lab, a verbal-pending comfort kit, an active DME rental and a
 * `queued_for_transmission` medication order (one waiting to reach the e-prescribing vendor) all stayed in
 * flight on an admission that had ended.
 *
 * Nothing is stubbed: the REAL M6 write service discharges as the NOBYPASSRLS `chartwarden_app` role → the
 * REAL catalog-validating publisher writes the outbox row → the REAL `createOutboxDispatcher` claims and
 * delivers it → M11's and M12's real cascade consumers read their own tables under RLS and write the
 * discontinuations. The `order_discontinuation` assertions are the point of the suite: `actor_membership_id`
 * NULL and `source_outbox_event_id` set are two columns that have existed since M11's schema landed and
 * that NOTHING in the repository has ever written.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:discharge-cascade:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import {
  type AdmissionDischargedDeps,
  applyAdmissionDischarged,
} from "../src/modules/05-patient/outbox-consumers/m6-admission-discharged";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  createDrizzleAdmissionReaderStore,
  registerAdmissionSeams,
} from "../src/modules/06-admission/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import {
  M11_OUTBOX_EVENTS,
  buildM11DischargeCascadeConsumer,
} from "../src/modules/11-orders/index";
import {
  M12_OUTBOX_EVENTS,
  buildM12DischargeCascadeConsumer,
} from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import { M22_OUTBOX_EVENTS } from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { dischargeOrderBy, seedPhysicianRole } from "./_physician-signer";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
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

describe.skipIf(!DB_URL)("F-102 — the M6 discharge cascade, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let m5Discharged: AdmissionDischargedDeps;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};

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

  /** Seed one `order_record` in a given status directly — the lifecycle to reach each in-flight status is
   *  M11's own live suite's subject, and driving it here would test that instead of the cascade. */
  async function seedOrder(
    org: string,
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
        org,
        providerOf[org],
        locationOf[org],
        patientId,
        admissionId,
        kind,
        status,
        memberOf[org],
        PHYSICIAN_MDM,
      ],
    );
    return rows[0].id as string;
  }
  async function seedMedOrder(
    org: string,
    admissionId: string,
    patientId: string,
    status: string,
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, med_class, drug_name, strength, dose_form, route, data,
         prescriber_membership_id, prescribing_physician_mdm_id, status)
       VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,$8)
       RETURNING id`,
      [
        org,
        providerOf[org],
        locationOf[org],
        patientId,
        admissionId,
        memberOf[org],
        PHYSICIAN_MDM,
        status,
      ],
    );
    return rows[0].id as string;
  }

  async function orderStatus(id: string): Promise<string> {
    const { rows } = await admin.query("SELECT status FROM order_record WHERE id=$1", [id]);
    return rows[0]?.status as string;
  }
  async function medStatus(id: string): Promise<string> {
    const { rows } = await admin.query("SELECT status FROM medication_order WHERE id=$1", [id]);
    return rows[0]?.status as string;
  }
  async function discontinuationFor(orderId: string) {
    const { rows } = await admin.query(
      `SELECT actor_membership_id, reason, source_outbox_event_id, target_kind
         FROM order_discontinuation WHERE order_record_id=$1`,
      [orderId],
    );
    return rows;
  }
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }
  async function dischargeEventId(admissionId: string): Promise<string> {
    const { rows } = await admin.query(
      "SELECT id FROM outbox_event WHERE event_type='m6.admission.discharged' AND aggregate_id=$1",
      [admissionId],
    );
    return rows[0].id as string;
  }

  /** The §418.24 chain through the REAL write service, to an ACTIVE admission ready to be discharged. */
  async function activeAdmission(org: string, patientId: string): Promise<string> {
    // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: org,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(org, admissionId);
    const periodId = periods?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      org,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(org, admissionId, periodId, {
      ...DRAFT,
      electedProviderEntityId: providerOf[org],
    });
    await svc.signElection(org, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      org,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(org, cti.id, cti.version, USER);
    await svc.activateAdmission(org, admissionId, nor.version);
    return admissionId;
  }

  /** `moved_out_of_service_area` needs no medical-director cosign, so the admission discharges in one
   *  call and `m6.admission.discharged` is emitted immediately (the for-cause path parks in
   *  `pending_cosign` and would prove nothing about the cascade). */
  async function discharge(org: string, admissionId: string): Promise<void> {
    const adm = await svc.getAdmission(org, admissionId);
    await svc.discharge(
      org,
      admissionId,
      {
        reason: "moved_out_of_service_area",
        dischargeDate: new Date().toISOString().slice(0, 10),
        narrative: "The patient relocated out of the service area and elects another hospice.",
        dischargeOrder: dischargeOrderBy(MD),
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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f102a@x.test'),($2,'f102md@x.test'),($3,'f102at@x.test')`,
      [USER, MD, ATTENDING],
    );
    // 42 CFR 418.26(b) — the live discharges below are dated today, so they carry a physician order.
    await seedPhysicianRole(admin, ORG_A, MD);
    await seedPhysicianRole(admin, ORG_B, MD);
    for (const org of [ORG_A, ORG_B]) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
          [org, `CCN-${org.slice(0, 4)}`, `Hospice ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult

    // The BOOT catalog, not an M6+M11+M12 slice: `m6.admission.discharged` declares ten more consumer
    // modules, and `m11.order.discontinued` / `m12.medication_order.discontinued` declare their own. The
    // dispatcher refuses to construct on an event its catalog does not carry, so a narrowed catalog would
    // prove the cascade against a dispatcher production never builds.
    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
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

    svc = createDbAdmissionRouteService(handle.db, bind("m6") as never, undefined, {
      async belongsToOrg(organizationId: string, providerEntityId: string) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [providerEntityId, organizationId],
        );
        return rows.length > 0;
      },
    });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM11DischargeCascadeConsumer({ db: handle.db, outbox: bind("m11") as never }),
        buildM12DischargeCascadeConsumer({ db: handle.db, outbox: bind("m12") as never }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });

    // M5's live-discharge consumer, over the REAL M6 AdmissionStatusReader seam and M5's real
    // catalog-validating publisher (an `m5.patient.status_changed` payload drift throws).
    registerAdmissionSeams({ store: createDrizzleAdmissionReaderStore(handle.db) });
    const m5Publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS]));
    m5Discharged = {
      db: handle.db,
      outbox: {
        publish: (tx, input) => m5Publisher.publish(tx, { ...input, callerModule: "m5" }),
      },
    };
  }, 180_000);

  /** Tick until the backlog is claimed. Activation + discharge now also emit the FY2027 election-addendum
   *  rows (drafted, window opened/closed, not_required), so one 25-row batch no longer always reaches the
   *  discharge row in a suite that has built several admissions. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await dispatcher.tick();
  }

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("discontinues every in-flight order and medication order on the discharged admission", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    const lab = await seedOrder(ORG_A, admissionId, patientId, "lab", "pending_signature");
    const kit = await seedOrder(ORG_A, admissionId, patientId, "comfort_kit", "verbal_pending");
    const dme = await seedOrder(ORG_A, admissionId, patientId, "dme", "active");
    const med = await seedMedOrder(ORG_A, admissionId, patientId, "active");
    const queued = await seedMedOrder(ORG_A, admissionId, patientId, "queued_for_transmission");

    await discharge(ORG_A, admissionId);
    // Nothing has happened yet: the discharge row is a real `pending` outbox row, which is the state
    // every discharge on the platform has sat in for the life of the deployment.
    expect(await orderStatus(dme)).toBe("active");

    await drain();

    for (const id of [lab, kit, dme]) expect(await orderStatus(id)).toBe("discontinued");
    for (const id of [med, queued]) expect(await medStatus(id)).toBe("discontinued");
  });

  it("writes the ledger row with a NULL actor and the discharge event id — two columns nothing ever wrote", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    const dme = await seedOrder(ORG_A, admissionId, patientId, "dme", "active");

    await discharge(ORG_A, admissionId);
    await drain();

    const rows = await discontinuationFor(dme);
    expect(rows).toHaveLength(1);
    // §4.5 / W-DC-02 — the cascade is a system actor. `discontinueOrder` writes the CALLER here, which is
    // why the cascade cannot go through it: it would put a clinician's name on an act they did not do.
    expect(rows[0].actor_membership_id).toBeNull();
    expect(rows[0].reason).toBe("admission_discharged");
    expect(rows[0].target_kind).toBe("order");
    expect(rows[0].source_outbox_event_id).toBe(await dischargeEventId(admissionId));
  });

  it("emits supply_cancellation_requested for supply kinds only — M21 decides what is open", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    const dme = await seedOrder(ORG_A, admissionId, patientId, "dme", "active");
    const lab = await seedOrder(ORG_A, admissionId, patientId, "lab", "active");

    await discharge(ORG_A, admissionId);
    await drain();

    expect(await eventsFor(dme)).toEqual(
      expect.arrayContaining(["m11.order.discontinued", "m11.order.supply_cancellation_requested"]),
    );
    const labEvents = await eventsFor(lab);
    expect(labEvents).toContain("m11.order.discontinued");
    expect(labEvents).not.toContain("m11.order.supply_cancellation_requested");
  });

  it("leaves terminal orders alone — a completed order is not re-discontinued", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    const done = await seedOrder(ORG_A, admissionId, patientId, "lab", "completed");
    const draft = await seedOrder(ORG_A, admissionId, patientId, "lab", "draft");

    await discharge(ORG_A, admissionId);
    await drain();

    expect(await orderStatus(done)).toBe("completed");
    expect(await orderStatus(draft)).toBe("draft");
    expect(await discontinuationFor(done)).toHaveLength(0);
  });

  it("is idempotent — a second tick writes no second ledger row and emits no second event", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    const dme = await seedOrder(ORG_A, admissionId, patientId, "dme", "active");

    await discharge(ORG_A, admissionId);
    await drain();
    const after = (await eventsFor(dme)).length;
    // The dispatcher's `(eventId, consumerName)` receipt means the handler does not re-run at all; even
    // if it did, every order is already `discontinued`, which the decider counts as skipped.
    await drain();
    await drain();

    expect(await discontinuationFor(dme)).toHaveLength(1);
    expect((await eventsFor(dme)).length).toBe(after);
  });

  it("does not reach across tenants — org B's order on its own admission is untouched", async () => {
    const patientA = randomUUID();
    const patientB = randomUUID();
    const admissionA = await activeAdmission(ORG_A, patientA);
    const admissionB = await activeAdmission(ORG_B, patientB);
    const orderA = await seedOrder(ORG_A, admissionA, patientA, "dme", "active");
    const orderB = await seedOrder(ORG_B, admissionB, patientB, "dme", "active");

    await discharge(ORG_A, admissionA);
    await drain();

    expect(await orderStatus(orderA)).toBe("discontinued");
    expect(await orderStatus(orderB)).toBe("active");
    expect(await discontinuationFor(orderB)).toHaveLength(0);
  });

  // ── M5 §2.4.1 `active → discharged`: every LIVE M6 ending reaches the patient chart ──────────────────
  /** The `m6.admission.discharged` row M6 actually wrote for this admission, delivered to M5. */
  async function deliverDischargedToM5(org: string, admissionId: string) {
    const { rows } = await admin.query(
      "SELECT organization_id, payload FROM outbox_event WHERE event_type='m6.admission.discharged' AND aggregate_id=$1",
      [admissionId],
    );
    expect(rows).toHaveLength(1);
    const outcome = await applyAdmissionDischarged(m5Discharged, {
      organizationId: rows[0].organization_id as string,
      payload: rows[0].payload,
    });
    return { outcome, reason: (rows[0].payload as { reason: string }).reason, org };
  }
  async function patientStatus(patientId: string): Promise<string> {
    const { rows } = await admin.query("SELECT status FROM patient WHERE id=$1", [patientId]);
    return rows[0].status as string;
  }
  const today = () => new Date().toISOString().slice(0, 10);

  it("M5: a live discharge (moved out of the service area) moves the patient active → discharged", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    await discharge(ORG_A, admissionId);

    const { outcome, reason } = await deliverDischargedToM5(ORG_A, admissionId);
    expect(reason).toBe("moved_out_of_service_area");
    expect(outcome).toBe("discharged");
    expect(await patientStatus(patientId)).toBe("discharged");
  });

  it("M5: a revocation emits m6.admission.discharged (reason revocation) and discharges the patient", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    await svc.createRevocation(
      ORG_A,
      admissionId,
      {
        revocationDate: today(),
        narrative: "Beneficiary elected to revoke and pursue curative treatment.",
        signingPatientName: "Pat Patient",
        signingRole: "patient",
        revocationReason: "seek_curative_treatment",
      } as never,
      USER,
    );

    const { outcome, reason } = await deliverDischargedToM5(ORG_A, admissionId);
    expect(reason).toBe("revocation");
    expect(outcome).toBe("discharged");
    expect(await patientStatus(patientId)).toBe("discharged");
  });

  it("M5: a transfer out emits m6.admission.discharged (reason transfer) and discharges the patient", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    await svc.transferOut(
      ORG_A,
      admissionId,
      {
        effectiveDate: today(),
        otherHospiceName: "Sunrise Hospice",
        receivingCareSetting: "home",
        otherHospiceCcn: "391234",
        narrative: "patient relocated closer to family; care transferred by mutual agreement",
      } as never,
      USER,
    );

    const { outcome, reason } = await deliverDischargedToM5(ORG_A, admissionId);
    expect(reason).toBe("transfer");
    expect(outcome).toBe("discharged");
    expect(await patientStatus(patientId)).toBe("discharged");
  });
});
