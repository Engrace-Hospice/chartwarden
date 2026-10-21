/**
 * F-105 — M16's bereavement intake, END TO END over real Postgres.
 *
 * `decideEligibilityIntake` is M16's complete §4.3.1 intake decider and its own header says "the live
 * outbox binding + the transactional insert land with the §4.9 workers in M16-T06". They did not. There
 * was no binding for `m6.bereavement.eligible`, and — one layer below that — there was NO INSERT INTO
 * `bereavement_plan` ANYWHERE IN THE REPOSITORY. Nor a route that creates one: `POST
 * /api/v1/bereavement/plans` does not exist (the collection path is a GET worklist) and all fifteen plan
 * write routes are `/plans/:planId/…`, so this consumer is the only creation path by design.
 *
 * So no bereavement plan has ever existed in any deployment. CoP 418.64(d) requires thirteen months of
 * bereavement services to the decedent's family, and `bereavement_plan` is the root carrying that clock —
 * the contact roster, the D4 outreach schedule, the anniversary reminders, the risk scores and the closure
 * record all hang off `plan_id`. M6's side was never missing: `m6.bereavement.eligible` is catalogued,
 * emitted from the death-discharge transition, and declares exactly one consumer — `m16` — so every
 * emission has sat `pending`, re-claimed every thirty minutes, since M6 landed.
 *
 * Nothing is stubbed: the REAL M6 write service discharges by death as the NOBYPASSRLS `wardenx_app` role
 * → the REAL catalog-validating publisher writes the outbox row → the REAL dispatcher delivers it → M16's
 * real consumer resolves the death fact through M6's real `DeathDischargeReader` seam and its real
 * org-explicit admission reader, and inserts under RLS.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m16:bereavement-intake:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildProviderEntityLocationLister } from "../src/bootstrap/provider-entity-resolver";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  admissionSchedulingContextForOrg,
  createDeathDischargeReader,
} from "../src/modules/06-admission/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import {
  M16_OUTBOX_EVENTS,
  buildM16BereavementIntakeConsumer,
} from "../src/modules/16-bereavement/index";
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

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
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
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";

const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)("F-105 — M16 opens the bereavement plan, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};

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

  async function plansFor(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, patient_id, status, death_date::text AS death_date, death_time,
              provider_entity_id,
              location_id, external_source_metadata, opened_at, closed_at
         FROM bereavement_plan WHERE admission_id=$1`,
      [admissionId],
    );
    return rows;
  }
  async function eventRows(eventType: string, admissionId: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, payload, status FROM outbox_event
        WHERE event_type=$1 AND payload->>'admissionId'=$2`,
      [eventType, admissionId],
    );
    return rows as { organization_id: string; payload: Record<string, unknown>; status: string }[];
  }

  /** The §418.24 chain through the REAL write service, to an ACTIVE admission. */
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
      electedProviderEntityId: providerOf[org],
      electedAttendingPhysicianId: ATTENDING,
      waiverAcknowledged: true,
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

  /** A real death discharge through the real write service — the only producer of the intake event. */
  async function dischargeByDeath(org: string, admissionId: string, at: string) {
    return svc.discharge(
      org,
      admissionId,
      {
        reason: "death",
        dischargeDate: at,
        narrative: "Patient died at home, family present.",
        deathCertifierId: MD,
        placeOfDeath: "home",
      } as never,
      USER,
    );
  }

  /** An active admission discharged by death, ready for the dispatcher. */
  async function decedent(
    org: string,
    at: string,
  ): Promise<{ admissionId: string; patientId: string }> {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(org, patientId);
    await dischargeByDeath(org, admissionId, at);
    return { admissionId, patientId };
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
      `INSERT INTO "user" (id,email) VALUES ($1,'f105a@x.test'),($2,'f105md@x.test'),($3,'f105at@x.test')`,
      [USER, MD, ATTENDING],
    );
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
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles','active') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [USER, org],
      );
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult

    // M6's §4.11 census port — org-explicit and worker-callable, which is why the intake reads the death
    // instant through it rather than off the event (whose `eligibleAt` is when the RULE cleared).
    registerSeam("DeathDischargeReader", createDeathDischargeReader(handle.db));

    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
      M15_OUTBOX_EVENTS,
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

    svc = createDbAdmissionRouteService(
      handle.db,
      bind("m6") as never,
      undefined,
      {
        async belongsToOrg(organizationId: string, providerEntityId: string) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      },
      { activeLocationsFor: buildProviderEntityLocationLister(handle.db) },
    );

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM16BereavementIntakeConsumer({
          db: handle.db,
          outbox: bind("m16") as never,
          // M6's ORG-EXPLICIT reader. The §4.7 `AdmissionStatusReader` pins the tenant from the ambient
          // REQUEST scope, and a relay tick is not a request — binding that instead is how every one of
          // these deliveries dead-letters with `no ambient request context`.
          resolveAdmission: async (organizationId, admissionId) =>
            admissionSchedulingContextForOrg(handle.db, organizationId, admissionId),
        }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("opens the plan — `bereavement_plan`'s first row in any database", async () => {
    const at = "2026-03-01";
    const { admissionId, patientId } = await decedent(ORG_A, at);
    // The discharge alone creates nothing: the request is a real `pending` outbox row, which is the state
    // every death on the platform has left behind for the life of the deployment.
    expect(await plansFor(admissionId)).toHaveLength(0);

    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    expect(plans[0].organization_id).toBe(ORG_A);
    expect(plans[0].patient_id).toBe(patientId);
    // D1 — created `eligible`, NOT `active`: a counselor has not been assigned and no roster exists.
    expect(plans[0].status).toBe("eligible");
    expect(plans[0].opened_at).toBeNull();
  });

  it("anchors the 13-month clock on the DEATH, read through M6's census seam", async () => {
    const at = "2026-04-11";
    const { admissionId } = await decedent(ORG_A, at);
    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    // D4 — `death_date` is the anchor, and it comes from `discharge_event.death_at` via the seam, never
    // from the event's `eligibleAt` (the instant the RULE cleared, which a late W-DC-01 filing moves).
    expect(plans[0].death_date).toBe(at);
    expect(plans[0].death_time).not.toBeNull();
  });

  it("sites the plan from the admission — `provider_entity_id` is NOT NULL and drives §4.6", async () => {
    const { admissionId } = await decedent(ORG_A, "2026-04-12");
    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    expect(plans[0].provider_entity_id).toBe(providerOf[ORG_A]);
    expect(plans[0].location_id).toBe(locationOf[ORG_A]);
  });

  it("stamps NO external-source provenance on an INTERNAL (clinician-recorded) death", async () => {
    const { admissionId } = await decedent(ORG_A, "2026-04-13");
    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    // D16/D18 — an internal death is `internal_clinician_recorded` and never gated. (F-227: an HL7-external
    // death now carries real provenance + a cosign gate — see m6-m16-external-death-cosign.live.test.ts.)
    expect(plans[0].external_source_metadata).toBeNull();
  });

  it("is idempotent — a redelivery does not open a second program (D1)", async () => {
    const { admissionId } = await decedent(ORG_A, "2026-04-14");
    await dispatcher.tick();
    expect(await plansFor(admissionId)).toHaveLength(1);

    // Re-drive the same event: clear the consumer receipt so the handler runs again, which is what a
    // redelivery after a partial failure looks like. `berv_plan_unique_admission` is the backstop.
    await admin.query("DELETE FROM outbox_consumer_receipt");
    await admin.query(
      "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type='m6.bereavement.eligible'",
    );
    await dispatcher.tick();
    expect(await plansFor(admissionId)).toHaveLength(1);
  });

  it("does not leak across tenants — org B's death opens org B's plan only", async () => {
    const a = await decedent(ORG_A, "2026-04-15");
    const b = await decedent(ORG_B, "2026-04-15");
    await dispatcher.tick();

    const plansA = await plansFor(a.admissionId);
    const plansB = await plansFor(b.admissionId);
    expect(plansA).toHaveLength(1);
    expect(plansB).toHaveLength(1);
    expect(plansA[0].organization_id).toBe(ORG_A);
    expect(plansB[0].organization_id).toBe(ORG_B);
  });

  it("writes the intake event with its tenant — the F-105 organizationId fix", async () => {
    const { admissionId } = await decedent(ORG_A, "2026-04-16");
    await dispatcher.tick();

    // M6's own emission carries the org (it always did). The point of this assertion is the DISPATCH:
    // an `m6.bereavement.eligible` row is now `dispatched` rather than re-claimed forever, because m16
    // is the event's only declared consumer and it is finally bound.
    const rows = await eventRows("m6.bereavement.eligible", admissionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(ORG_A);
    expect(rows[0].status).toBe("dispatched");
  });

  it("a non-death discharge opens nothing — the rule is death-only (W-DC-01)", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    await svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "moved_out_of_service_area",
        dischargeDate: "2026-04-17",
        narrative: "Family relocated out of the service area.",
      } as never,
      USER,
    );
    await dispatcher.tick();
    // The control that must pass in BOTH directions: it passes against the pre-fix code too, which is
    // what makes the other seven meaningful.
    expect(await plansFor(admissionId)).toHaveLength(0);
  });
});
