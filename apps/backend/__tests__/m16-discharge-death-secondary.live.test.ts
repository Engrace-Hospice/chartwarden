/**
 * F-134 (#248) — M16's `m6.admission.discharged` secondary verifier, END TO END over real Postgres.
 *
 * `m6.bereavement.eligible` (F-105) is the ONLY creation path for a `bereavement_plan` row, and it is a
 * post-rule check M6 runs on its own `discharge.death` transition. M16's own §4.5 outbox-subscriptions
 * table also names `m6.admission.discharged` (filtered to `reason='death'`) as a deliberate "secondary
 * verifier (redundant safety net)" against that rule failing to fire. This suite proves the secondary
 * consumer (`buildM16DischargeDeathSecondaryConsumer`) reaches the SAME outcome the primary consumer does
 * when the primary is unavailable, and is a true no-op when the primary already ran.
 *
 * `m6.admission.discharged` already declares `m16` in `declaredConsumers` (F-134's own kept-pair finding —
 * this was never a catalog gap, only a missing binding), so this suite drives the real `M6_OUTBOX_EVENTS`
 * straight through the `Value.Check`-validated publisher with no fixture patching.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m16:discharge-death-secondary:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { registerSeam } from "../src/bootstrap/index";
import {
  type OutboxConsumerBinding,
  createOutboxDispatcher,
} from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildProviderEntityLocationLister } from "../src/bootstrap/provider-entity-resolver";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  admissionSchedulingContextForOrg,
  createDeathDischargeReader,
} from "../src/modules/06-admission/index";
import {
  M16_OUTBOX_EVENTS,
  buildM16BereavementIntakeConsumer,
  buildM16DischargeDeathSecondaryConsumer,
} from "../src/modules/16-bereavement/index";
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
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";

const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)("F-134 — M16's discharge-death secondary verifier, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
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
      `SELECT id, organization_id, patient_id, status, death_date::text AS death_date
         FROM bereavement_plan WHERE admission_id=$1`,
      [admissionId],
    );
    return rows;
  }

  async function activeAdmission(org: string, patientId: string): Promise<string> {
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

  async function decedent(
    org: string,
    at: string,
  ): Promise<{ admissionId: string; patientId: string }> {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(org, patientId);
    await dischargeByDeath(org, admissionId, at);
    return { admissionId, patientId };
  }

  const catalog = buildBootOutboxCatalog([M6_OUTBOX_EVENTS, M16_OUTBOX_EVENTS]);
  const publisher = buildTxOutboxPublisher(catalog);
  const bind = (callerModule: string) => ({
    publish: (tx: unknown, e: Record<string, unknown>) =>
      publisher.publish(tx as never, { ...e, callerModule } as never),
  });

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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f134a@x.test'),($2,'f134md@x.test'),($3,'f134at@x.test')`,
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
    registerM5IntakeSeams(handle.db);
    registerSeam("DeathDischargeReader", createDeathDischargeReader(handle.db));

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
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const resolveAdmission = (organizationId: string, admissionId: string) =>
    admissionSchedulingContextForOrg(handle.db, organizationId, admissionId);

  it("opens the plan on its own when the primary consumer is not bound", async () => {
    const { admissionId, patientId } = await decedent(ORG_A, "2026-05-01");
    const dispatcher = makeDispatcher([
      buildM16DischargeDeathSecondaryConsumer({
        db: handle.db,
        outbox: bind("m16") as never,
        resolveAdmission,
      }),
    ]);

    expect(await plansFor(admissionId)).toHaveLength(0);
    await dispatcher.tick();

    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    expect(plans[0].organization_id).toBe(ORG_A);
    expect(plans[0].patient_id).toBe(patientId);
    expect(plans[0].status).toBe("eligible");
    expect(plans[0].death_date).toBe("2026-05-01");
  });

  it("is a true no-op when the primary consumer already opened the plan", async () => {
    const { admissionId } = await decedent(ORG_A, "2026-05-02");
    const dispatcher = makeDispatcher([
      buildM16BereavementIntakeConsumer({
        db: handle.db,
        outbox: bind("m16") as never,
        resolveAdmission,
      }),
      buildM16DischargeDeathSecondaryConsumer({
        db: handle.db,
        outbox: bind("m16") as never,
        resolveAdmission,
      }),
    ]);

    await dispatcher.tick();
    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1); // never two, even though both consumers ran off the same death
  });

  it("a non-death discharge is a no-op with no seam read", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    await svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "moved_out_of_service_area",
        dischargeDate: "2026-05-03",
        narrative: "Family relocated out of the service area.",
      } as never,
      USER,
    );
    const dispatcher = makeDispatcher([
      buildM16DischargeDeathSecondaryConsumer({
        db: handle.db,
        outbox: bind("m16") as never,
        resolveAdmission,
      }),
    ]);
    await dispatcher.tick();
    expect(await plansFor(admissionId)).toHaveLength(0);
  });

  it("does not leak across tenants", async () => {
    const a = await decedent(ORG_A, "2026-05-04");
    const b = await decedent(ORG_B, "2026-05-04");
    const dispatcher = makeDispatcher([
      buildM16DischargeDeathSecondaryConsumer({
        db: handle.db,
        outbox: bind("m16") as never,
        resolveAdmission,
      }),
    ]);
    await dispatcher.tick();

    const plansA = await plansFor(a.admissionId);
    const plansB = await plansFor(b.admissionId);
    expect(plansA).toHaveLength(1);
    expect(plansB).toHaveLength(1);
    expect(plansA[0].organization_id).toBe(ORG_A);
    expect(plansB[0].organization_id).toBe(ORG_B);
  });

  it("is idempotent against a redelivery after the plan already opened", async () => {
    const { admissionId } = await decedent(ORG_A, "2026-05-05");
    const dispatcher = makeDispatcher([
      buildM16DischargeDeathSecondaryConsumer({
        db: handle.db,
        outbox: bind("m16") as never,
        resolveAdmission,
      }),
    ]);
    await dispatcher.tick();
    expect(await plansFor(admissionId)).toHaveLength(1);

    await admin.query("DELETE FROM outbox_consumer_receipt");
    await admin.query(
      "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type='m6.admission.discharged'",
    );
    await dispatcher.tick();
    expect(await plansFor(admissionId)).toHaveLength(1);
  });
});
