/**
 * F-103 — M15's discipline-plan bootstrap, END TO END over real Postgres.
 *
 * `bootstrapDisciplinePlan` is M15's §2.2.1 `[*] → draft` factory and its own doc comment says it is
 * "called by the `m6.admission.activated` consumer for the three always-bootstrapped kinds". There was no
 * such consumer, m15 was not in that event's `declaredConsumers`, and — one layer below both — there was
 * NO INSERT INTO `discipline_care_plan` anywhere in the repository: not the write service, not a seed, not
 * a test. Nor a route that creates one; every M15 write route is `/discipline-plans/:planId/…`, so the
 * bootstrap consumer is the ONLY creation path by design.
 *
 * The aide plan of care (CoP 418.76), the MSW plan (418.64(c)) and the spiritual plan (418.64(d)) — and
 * every goal, intervention, discipline assessment and 14-day aide supervisory visit, all of which hang off
 * `plan_id` — were therefore unreachable in every deployment that has ever run, and the §7.1/§7.2/§7.3
 * clocks that count from `initial_assessment_clock_started_at` never started because nothing set it.
 *
 * Nothing is stubbed: the REAL M6 write service activates an admission as the NOBYPASSRLS `wardenx_app`
 * role → the REAL catalog-validating publisher writes the outbox row → the REAL dispatcher delivers it →
 * M15's real consumer resolves the siting through M6's real org-explicit reader and inserts under RLS.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m15:plan-bootstrap:live
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
import { buildProviderEntityLocationLister } from "../src/bootstrap/provider-entity-resolver";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  admissionSchedulingContextForOrg,
} from "../src/modules/06-admission/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import {
  M15_OUTBOX_EVENTS,
  buildM15PlanBootstrapConsumer,
} from "../src/modules/15-discipline-care-plans/index";
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

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";

const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

/** §1.1 D10 — the three bootstrapped eagerly. `volunteer_plan` is deliberately NOT among them. */
const COP_KINDS = ["aide_poc", "msw_plan", "spiritual_plan"] as const;

describe.skipIf(!DB_URL)("F-103 — M15 bootstraps the three CoP plans, LIVE Postgres", () => {
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
      `SELECT kind, status, organization_id, patient_id, provider_entity_id, location_id,
              initial_assessment_clock_started_at, next_supervisory_due_at
         FROM discipline_care_plan WHERE admission_id=$1 ORDER BY kind`,
      [admissionId],
    );
    return rows;
  }
  async function bootstrappedEvents(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, payload FROM outbox_event
        WHERE event_type='m15.plan.bootstrapped' AND payload->>'admissionId'=$1
        ORDER BY payload->>'kind'`,
      [admissionId],
    );
    return rows as { organization_id: string; payload: Record<string, unknown> }[];
  }

  /** The §418.24 chain through the REAL write service, to an ACTIVE admission. */
  async function activeAdmission(org: string, patientId: string): Promise<string> {
    const ref = await svc.createReferral(
      org,
      {
        source: "phone",
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt: "P",
      },
      USER,
    );
    await svc.triageReferral(org, ref.id, "eligible", 0);
    const { admissionId } = await svc.acceptReferral(
      org,
      ref.id,
      { primaryDiagnosisIcd10: "C34.90", patientId },
      1,
      USER,
    );
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
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(org, cti.id, cti.version, USER);
    await svc.signCtiAttending(org, cti.id, cti.version + 1, ATTENDING);
    await svc.activateAdmission(org, admissionId, nor.version);
    return admissionId;
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
      `INSERT INTO "user" (id,email) VALUES ($1,'f103a@x.test'),($2,'f103md@x.test'),($3,'f103at@x.test')`,
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
          // `status` defaults to 'created' and #50's lister counts only ACTIVE sites — a created one has
          // not opened, and siting a federal capture window there would be wrong undetectably.
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
      // #50 — the port that SITES the admission at a service location on activation. Production binds
      // exactly this; without it `resolveActivationLocation` returns null and `admission.location_id`
      // stays NULL, which is what the first run of this suite hit — the consumer refused every delivery
      // with "has no location to site the plan against". That refusal is the design (the plan's
      // `location_id` is NOT NULL and drives the §4.3 per-location rollups), so the harness binds the
      // real lister rather than the assertion being relaxed.
      { activeLocationsFor: buildProviderEntityLocationLister(handle.db) },
    );

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM15PlanBootstrapConsumer({
          db: handle.db,
          outbox: bind("m15") as never,
          // M6's ORG-EXPLICIT reader. The §4.7 seam pins the tenant from the ambient request scope and a
          // relay tick is not a request — binding that instead is how this delivery dead-letters.
          resolveSiting: (organizationId, admissionId) =>
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

  it("creates the three CoP plan stubs in draft — the table's first rows in any database", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    // Activation alone creates nothing: the request is a real `pending` outbox row, which is the state
    // every activation on the platform has sat in for the life of the deployment.
    expect(await plansFor(admissionId)).toHaveLength(0);

    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans.map((p) => p.kind)).toEqual([...COP_KINDS]);
    for (const p of plans) {
      expect(p.status).toBe("draft");
      expect(p.organization_id).toBe(ORG_A);
      expect(p.patient_id).toBe(patientId);
    }
  });

  it("sites every plan from the admission — both columns are NOT NULL and drive the §4.3 rollups", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(3); // a `for` over an empty list asserts nothing
    for (const p of plans) {
      expect(p.provider_entity_id).toBe(providerOf[ORG_A]);
      expect(p.location_id).toBe(locationOf[ORG_A]);
    }
  });

  it("starts the D10 clock — the anchor the §7.1/§7.2/§7.3 gates count from, never once set", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(3);
    for (const p of plans) {
      expect(p.initial_assessment_clock_started_at).not.toBeNull();
      // The supervisory clock is NOT started here: §7.1 sets `next_supervisory_due_at` when the first
      // version reaches `signed`, and a due date on a plan nobody has authored would page an RN about a
      // visit that is not yet owed.
      expect(p.next_supervisory_due_at).toBeNull();
    }
  });

  it("does NOT create a volunteer_plan — §1.1 D10 makes that one lazy on first assignment", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();

    const kinds = (await plansFor(admissionId)).map((p) => p.kind);
    expect(kinds).toHaveLength(3);
    expect(kinds).not.toContain("volunteer_plan");
  });

  it("announces each plan with the D11 quorum the first version will have to satisfy", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    await dispatcher.tick();

    const events = await bootstrappedEvents(admissionId);
    expect(events.map((e) => e.payload.kind)).toEqual([...COP_KINDS]);
    // F-103's second defect: `OutboxEmission` had NO `organizationId` field and none of M15's six emit
    // sites supplied one, so every `m15.*` row was written with a NULL org — which the `outbox_event`
    // RLS WITH CHECK refuses with 42501, rolling back the whole mutation. This assertion is the direct
    // evidence for that fix; the first run of this suite failed on exactly that error.
    for (const e of events) expect(e.organization_id).toBe(ORG_A);
    const aide = events.find((e) => e.payload.kind === "aide_poc");
    expect(aide?.payload.patientId).toBe(patientId);
    // §3.5 / D11 — the CHHA ACKNOWLEDGES rather than cosigning: CoP 418.76 gives the supervising RN
    // authorship of the aide's plan of care, and a cosignature would imply an authorship it does not.
    expect(aide?.payload.requiredSignerSet).toEqual([
      { role: "rn_case_manager", count: 1, isAcknowledgment: false },
      { role: "chha_acknowledgment", count: 1, isAcknowledgment: true },
    ]);
  });

  it("is idempotent — a redelivery adds no fourth plan and announces nothing twice", async () => {
    const admissionId = await activeAdmission(ORG_A, randomUUID());
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();

    expect(await plansFor(admissionId)).toHaveLength(3);
    // The §3.3 partial unique index absorbs the conflict; a row that did not insert emits nothing,
    // because `m15.plan.bootstrapped` is keyed on `planId` and announcing an uncreated plan would hand
    // M14's packet builder an id it cannot resolve.
    expect(await bootstrappedEvents(admissionId)).toHaveLength(3);
  });

  it("does not reach across tenants — org B's admission gets its own plans and org A's are untouched", async () => {
    const admissionA = await activeAdmission(ORG_A, randomUUID());
    const admissionB = await activeAdmission(ORG_B, randomUUID());
    await dispatcher.tick();

    expect(await plansFor(admissionA)).toHaveLength(3);
    const bPlans = await plansFor(admissionB);
    expect(bPlans).toHaveLength(3);
    for (const p of bPlans) {
      expect(p.organization_id).toBe(ORG_B);
      expect(p.provider_entity_id).toBe(providerOf[ORG_B]);
    }
  });
});
