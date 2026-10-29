/**
 * S10 — the four terminal transitions (live discharge, revocation, transfer-out, death) driven through the
 * REAL M6 write service, then through the REAL outbox dispatcher with the REAL cascade consumers of M5, M7,
 * M10, M11, M12 and M17, over real Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Why this exists next to `m6-discharge-cascade.live`: that suite proves the M11/M12 order cascade on one
 * reason (a live discharge) and M5 on three. The M7, M10 and M17 consumer suites hand-build their event
 * payload with `reason: "death"`. Nothing proved that one real discharge per reason reaches EVERY consumer
 * with a payload they accept, or that the end state is the same whatever the reason. This does, in a table.
 *
 * Not repeated here: M16 (bereavement; death only) is driven by a real discharge in
 * `m16-bereavement-intake.live` and `m16-discharge-death-secondary.live`. M13 (doses, comfort kits; no
 * `reason` filter in the consumer) and M37 (IPU; skips `reason = "death"` on purpose) are covered only by
 * suites that hand-INSERT the `m6.admission.discharged` event, so a real per-reason payload reaching them is
 * NOT proved by anything yet.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:discharge-reason-matrix:live
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
import { applyAdmissionDischarged } from "../src/modules/05-patient/outbox-consumers/m6-admission-discharged";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  admissionSchedulingContextForOrg,
  createDrizzleAdmissionReaderStore,
  registerAdmissionSeams,
} from "../src/modules/06-admission/index";
import {
  M7_OUTBOX_EVENTS,
  buildM7AdmissionActivatedConsumer,
  buildM7AdmissionDischargedConsumer,
} from "../src/modules/07-care-plan/index";
import {
  M10_OUTBOX_EVENTS,
  buildM10AdmissionSchedulingConsumer,
} from "../src/modules/10-hope/index";
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
import {
  M17_OUTBOX_EVENTS,
  buildM17AdmissionLifecycleConsumer,
} from "../src/modules/17-scheduling/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import { M22_OUTBOX_EVENTS } from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { dischargeOrderBy, seedPhysicianRole } from "./_physician-signer";

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
const DAY_MS = 86_400_000;

const today = () => new Date().toISOString().slice(0, 10);

interface Transition {
  readonly name: string;
  /** The `reason` M6 puts on `m6.admission.discharged` for this ending. */
  readonly reason: string;
  /** What M5's consumer leaves the chart as. Death is `null`: M5 applies no edge on a death delivery (the
   *  chart stays `active` here; `m5.death-cascade` is not registered in this suite). M6 emits the separate
   *  `m6.discharge.death` hand-off, which `gap-004-death-cascade.live` consumes. */
  readonly patientEndsAs: "discharged" | null;
  readonly run: (org: string, admissionId: string) => Promise<void>;
}

describe.skipIf(!DB_URL)("S10 — terminal transitions reach every consumer, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
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

  async function one<T = string>(sql: string, params: unknown[]): Promise<T> {
    const { rows } = await admin.query(sql, params);
    return Object.values(rows[0] ?? {})[0] as T;
  }

  async function seedOrder(org: string, admissionId: string, patientId: string, status: string) {
    return one(
      `INSERT INTO order_record (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, kind, kind_version, data, status, drafter_membership_id, drafter_discipline,
         ordering_physician_mdm_id)
       VALUES ($1,$2,$3,$4,$5,'lab','v1','{}'::jsonb,$6,$7,'rn_case_manager',$8) RETURNING id`,
      [
        org,
        providerOf[org],
        locationOf[org],
        patientId,
        admissionId,
        status,
        memberOf[org],
        PHYSICIAN_MDM,
      ],
    );
  }
  async function seedMedOrder(org: string, admissionId: string, patientId: string, status: string) {
    return one(
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
  }
  /** A visit tomorrow in the given status, in its own slot (`visit_*_no_overlap` forbids two visits for one
   *  assignee at the same time). Purpose/setting take the first label of their enums. */
  let visitSlot = 0;
  async function seedVisit(org: string, admissionId: string, patientId: string, status: string) {
    visitSlot += 1;
    const start = new Date(Date.now() + DAY_MS + visitSlot * 2 * 3_600_000);
    return one(
      `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
         assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
         scheduled_started_at, scheduled_ended_at, service_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,'rn',(enum_range(NULL::visit_purpose))[1],(enum_range(NULL::visit_setting))[1],
               $7,$8,$9,$10::visit_status) RETURNING id`,
      [
        org,
        providerOf[org],
        locationOf[org],
        patientId,
        admissionId,
        memberOf[org],
        start,
        new Date(start.getTime() + 3_600_000),
        start.toISOString().slice(0, 10),
        status,
      ],
    );
  }

  const orderStatus = (id: string) => one("SELECT status FROM order_record WHERE id=$1", [id]);
  const medStatus = (id: string) => one("SELECT status FROM medication_order WHERE id=$1", [id]);
  const visitStatus = (id: string) => one("SELECT status FROM visit WHERE id=$1", [id]);
  const patientStatus = (id: string) => one("SELECT status FROM patient WHERE id=$1", [id]);
  const carePlanStatus = (admissionId: string) =>
    one("SELECT status FROM care_plan WHERE admission_id=$1", [admissionId]);
  const dischargeTimepoints = (admissionId: string) =>
    one<number>(
      "SELECT count(*)::int FROM hope_timepoint_schedule WHERE admission_id=$1 AND rfa_kind='05_discharge'",
      [admissionId],
    );
  const deathHandoffs = (admissionId: string) =>
    one<number>(
      "SELECT count(*)::int FROM outbox_event WHERE event_type='m6.discharge.death' AND payload->>'admissionId'=$1",
      [admissionId],
    );
  const dischargedReason = (admissionId: string) =>
    one<string>(
      "SELECT payload->>'reason' FROM outbox_event WHERE event_type='m6.admission.discharged' AND aggregate_id=$1",
      [admissionId],
    );

  async function activeAdmission(org: string, patientId: string): Promise<string> {
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: org,
      actorUserId: USER,
      patientId,
    });
    // `admission.location_id` is nullable and comes from the referral / patient / actor site; the M5-intake
    // helper supplies none. M10 refuses to plan a HOPE schedule for an unsited admission ("refusing to create
    // a HOPE timepoint schedule with a guessed provider entity or location"), so site it as a real intake does.
    await admin.query("UPDATE admission SET location_id=$2 WHERE id=$1 AND location_id IS NULL", [
      admissionId,
      locationOf[org],
    ]);
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

  const TRANSITIONS: readonly Transition[] = [
    {
      name: "live discharge",
      reason: "moved_out_of_service_area",
      patientEndsAs: "discharged",
      run: async (org, admissionId) => {
        const adm = await svc.getAdmission(org, admissionId);
        await svc.discharge(
          org,
          admissionId,
          {
            reason: "moved_out_of_service_area",
            dischargeDate: today(),
            narrative: "The patient relocated out of the service area and elects another hospice.",
            dischargeOrder: dischargeOrderBy(MD),
            ifVersion: adm?.version,
          } as never,
          USER,
        );
      },
    },
    {
      name: "revocation",
      reason: "revocation",
      patientEndsAs: "discharged",
      run: async (org, admissionId) => {
        await svc.createRevocation(
          org,
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
      },
    },
    {
      name: "transfer out",
      reason: "transfer",
      patientEndsAs: "discharged",
      run: async (org, admissionId) => {
        await svc.transferOut(
          org,
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
      },
    },
    {
      name: "death",
      reason: "death",
      patientEndsAs: null,
      run: async (org, admissionId) => {
        await svc.discharge(
          org,
          admissionId,
          {
            reason: "death",
            dischargeDate: today(),
            narrative: "expired peacefully",
            deathCertifierId: MD,
            placeOfDeath: "home",
          } as never,
          USER,
        );
      },
    },
  ];

  /** Tick the backlog out, then insist no row failed or was retried: a consumer that threw is dead-lettered
   *  or backed off, and the no-op dispatcher log would otherwise hide it. (Rows stay `pending` while a
   *  module this harness does not register has not consumed them, so status alone proves nothing.) */
  async function drain(): Promise<void> {
    for (let i = 0; i < 6; i += 1) await dispatcher.tick();
    const { rows } = await admin.query(
      "SELECT event_type, status, attempt_count, last_error FROM outbox_event WHERE status = 'failed' OR (last_error IS NOT NULL AND last_error NOT LIKE 'deferred:%')",
    );
    expect(rows).toEqual([]);
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
      `INSERT INTO "user" (id,email) VALUES ($1,'s10a@x.test'),($2,'s10md@x.test'),($3,'s10at@x.test')`,
      [USER, MD, ATTENDING],
    );
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
    registerM5IntakeSeams(handle.db);
    registerAdmissionSeams({ store: createDrizzleAdmissionReaderStore(handle.db) });

    const catalog = buildBootOutboxCatalog([
      M5_OUTBOX_EVENTS,
      M6_OUTBOX_EVENTS,
      M7_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M17_OUTBOX_EVENTS,
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

    const m5Deps = { db: handle.db, outbox: bind("m5") as never };
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    const consumers = [
      {
        consumerName: "m5.m6-admission-discharged",
        consumerModule: "m5",
        eventTypes: ["m6.admission.discharged"],
        async handle(event: { organizationId: string; payload: unknown }) {
          await applyAdmissionDischarged(m5Deps as never, {
            organizationId: event.organizationId,
            payload: event.payload,
          });
        },
      } as never,
      buildM7AdmissionActivatedConsumer({ db: handle.db, outbox: bind("m7") as never }),
      buildM7AdmissionDischargedConsumer({ db: handle.db, outbox: bind("m7") as never }),
      buildM10AdmissionSchedulingConsumer({
        db: handle.db,
        outbox: bind("m10") as never,
        resolveSiting: (organizationId: string, admissionId: string) =>
          admissionSchedulingContextForOrg(handle.db, organizationId, admissionId),
      } as never) as never,
      buildM11DischargeCascadeConsumer({ db: handle.db, outbox: bind("m11") as never }),
      buildM12DischargeCascadeConsumer({ db: handle.db, outbox: bind("m12") as never }),
      buildM17AdmissionLifecycleConsumer({ db: handle.db, outbox: bind("m17") as never }),
    ];
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers,
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe.each(TRANSITIONS)("$name", (t) => {
    it("emits m6.admission.discharged with its own reason, and nothing has cascaded yet", async () => {
      const patientId = randomUUID();
      const admissionId = await activeAdmission(ORG_A, patientId);
      const order = await seedOrder(ORG_A, admissionId, patientId, "pending_signature");
      const visit = await seedVisit(ORG_A, admissionId, patientId, "published");

      await t.run(ORG_A, admissionId);

      expect(await dischargedReason(admissionId)).toBe(t.reason);
      // The state every discharge sits in until the dispatcher ticks: open work still open.
      expect(await orderStatus(order)).toBe("pending_signature");
      expect(await visitStatus(visit)).toBe("published");
      expect(await patientStatus(patientId)).toBe("active");
    });

    it("one drain closes the chart, the plan, the orders and the future visits", async () => {
      const patientId = randomUUID();
      const admissionId = await activeAdmission(ORG_A, patientId);
      const lab = await seedOrder(ORG_A, admissionId, patientId, "pending_signature");
      const med = await seedMedOrder(ORG_A, admissionId, patientId, "active");
      const queued = await seedMedOrder(ORG_A, admissionId, patientId, "queued_for_transmission");
      const visit = await seedVisit(ORG_A, admissionId, patientId, "published");

      await t.run(ORG_A, admissionId);
      await drain();

      // M5. Death applies no edge here; M6 emits the `m6.discharge.death` hand-off for the death cascade.
      expect(await patientStatus(patientId)).toBe(t.patientEndsAs ?? "active");
      if (!t.patientEndsAs) expect(await deathHandoffs(admissionId)).toBe(1);
      expect(await carePlanStatus(admissionId)).toBe("discharged"); // M7
      expect(await dischargeTimepoints(admissionId)).toBe(1); // M10
      expect(await orderStatus(lab)).toBe("discontinued"); // M11
      for (const id of [med, queued]) expect(await medStatus(id)).toBe("discontinued"); // M12
      expect(await visitStatus(visit)).toBe("cancelled"); // M17
      const { rows } = await admin.query(
        "SELECT cancellation_reason_code, cancellation_reason FROM visit WHERE id=$1",
        [visit],
      );
      expect(rows[0].cancellation_reason_code).toBe("admission_lifecycle");
      expect(rows[0].cancellation_reason).toContain(t.reason);
    });

    it("does not reach into another tenant's admission", async () => {
      const patientId = randomUUID();
      const admissionId = await activeAdmission(ORG_A, patientId);
      const otherPatient = randomUUID();
      const otherAdmission = await activeAdmission(ORG_B, otherPatient);
      const otherOrder = await seedOrder(ORG_B, otherAdmission, otherPatient, "pending_signature");
      const otherVisit = await seedVisit(ORG_B, otherAdmission, otherPatient, "published");

      await t.run(ORG_A, admissionId);
      await drain();

      expect(await orderStatus(otherOrder)).toBe("pending_signature");
      expect(await visitStatus(otherVisit)).toBe("published");
      expect(await carePlanStatus(otherAdmission)).toBe("draft");
      expect(await patientStatus(otherPatient)).toBe("active");
    });
  });

  /**
   * M17's discharge handler (#912) also dismisses every `proposed` visit and discontinues every `active`
   * recurring-visit policy of the admission, for every ending including death. Before the fix both survived,
   * and `materializeRecurringVisitsForOrg` (which selects policies on `status = 'active'` alone) could have
   * kept creating visits for an ended admission.
   */
  describe("M17 closes the planning board and the recurrence for an ended admission", () => {
    it.each(TRANSITIONS)("$name: a proposed visit is dismissed", async (t) => {
      const patientId = randomUUID();
      const admissionId = await activeAdmission(ORG_A, patientId);
      const proposed = await seedVisit(ORG_A, admissionId, patientId, "proposed");
      const control = await seedVisit(ORG_A, admissionId, patientId, "published");

      await t.run(ORG_A, admissionId);
      await drain();

      expect(await visitStatus(control)).toBe("cancelled");
      expect(await visitStatus(proposed)).toBe("cancelled");
      const { rows } = await admin.query("SELECT cancellation_reason_code FROM visit WHERE id=$1", [
        proposed,
      ]);
      expect(rows[0].cancellation_reason_code).toBe("admission_lifecycle");
    });

    it.each(TRANSITIONS)("$name: an active recurring-visit policy is discontinued", async (t) => {
      const patientId = randomUUID();
      const admissionId = await activeAdmission(ORG_A, patientId);
      const policy = await one(
        `INSERT INTO recurring_visit (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, assigned_membership_id, visit_purpose, visit_setting, rrule, time_of_day_start,
           time_of_day_end, time_zone, start_date)
         VALUES ($1,$2,$3,$4,$5,$6,(enum_range(NULL::visit_purpose))[1],(enum_range(NULL::visit_setting))[1],
                 'FREQ=DAILY','09:00','10:00','America/Los_Angeles',$7) RETURNING id`,
        [
          ORG_A,
          providerOf[ORG_A],
          locationOf[ORG_A],
          patientId,
          admissionId,
          memberOf[ORG_A],
          today(),
        ],
      );

      const control = await seedVisit(ORG_A, admissionId, patientId, "published");

      await t.run(ORG_A, admissionId);
      await drain();

      expect(await visitStatus(control)).toBe("cancelled");
      expect(await one("SELECT status FROM recurring_visit WHERE id=$1", [policy])).toBe(
        "discontinued",
      );
      expect(
        await one(
          "SELECT count(*)::int FROM outbox_event WHERE event_type='m17.recurring_visit.discontinued' AND aggregate_id=$1",
          [policy],
        ),
      ).toBe(1);
    });
  });
});
