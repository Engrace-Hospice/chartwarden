/**
 * F-227 (#248) — the HL7-external death's medical-director cosign, END TO END over real Postgres:
 * M29-accepted proposal → M6 applier (provenance stamped) → M16 intake (real proposal id) → M6 route-40
 * cosign (attests) → `m6.discharge.cosigned` (enriched) → M16 releases the D18 first-contact gate.
 *
 * `m6.discharge.cosigned` was declared-but-unbound for the life of M16: its payload did not carry what
 * `decideCosignReceipt` needs and `discharge_event` had no source/cosign columns. M6 spec W-M6-31 records an
 * external death as `completed` IMMEDIATELY with `cosign_required` (NOT a `pending_cosign` state — that is the
 * for-cause path, D11) and opens a 7-day `external_discharge_notice` prompt; the cosign is an attestation.
 * This suite also proves the applier actually WORKS: before F-227 it threw `DEATH_CERTIFIER_INVALID` (it called
 * `discharge({reason:'death'})` with no certifier) and would have failed the catalog on `m6.discharge.death`.
 *
 * Nothing is stubbed: the REAL applier consumer and write service run as the NOBYPASSRLS `chartwarden_app` role,
 * the REAL catalog-validating publisher writes the outbox, the REAL dispatcher delivers to M16's real consumers.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6-m16:external-death-cosign:live
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
  buildM6ProposalAcceptedConsumer,
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
  buildM16DischargeCosignedConsumer,
} from "../src/modules/16-bereavement/index";
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
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";
const DIRECTOR = "88888888-8888-8888-8888-888888888888";
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;
const COSIGNER = {
  cosignerName: "Dr. Medical Director",
  cosignerNpi: "1234567893",
  actorRoleKeys: ["medical_director"],
};

describe.skipIf(!DB_URL)("F-227 — external death cosign M6 → M16, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let applier: ReturnType<typeof buildM6ProposalAcceptedConsumer>;
  let cosignConsumer: ReturnType<typeof buildM16DischargeCosignedConsumer>;
  const providerOf: Record<string, string> = {};

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
      `SELECT id, organization_id, status, version, external_source_metadata
         FROM bereavement_plan WHERE admission_id=$1`,
      [admissionId],
    );
    return rows;
  }
  async function dischargeRow(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT id, status, version, source, source_proposal_id, cosign_required, cosigned_at,
              medical_director_membership_id, death_certifier_id
         FROM discharge_event WHERE admission_id=$1`,
      [admissionId],
    );
    return rows[0] as Record<string, unknown> | undefined;
  }
  async function events(eventType: string, admissionId: string) {
    const { rows } = await admin.query(
      `SELECT organization_id, payload, status FROM outbox_event
        WHERE event_type=$1 AND payload->>'admissionId'=$2 ORDER BY created_at`,
      [eventType, admissionId],
    );
    return rows as { organization_id: string; payload: Record<string, unknown>; status: string }[];
  }
  async function noticeWindows(admissionId: string) {
    const { rows } = await admin.query(
      `SELECT id, status, payload, starts_at, must_complete_by, close_reason, closed_by
         FROM compliance_window WHERE admission_id=$1 AND window_kind='external_discharge_notice'`,
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

  /** An M29-accepted external death notice, through the REAL applier consumer. */
  async function externalDeath(org: string, deathDate: string) {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(org, patientId);
    const proposalId = randomUUID();
    await applier.handle({
      organizationId: org,
      payload: {
        proposalId,
        organizationId: org,
        sourceMessageId: `msg-${proposalId}`,
        resourceKind: "discharge_event",
        ownerModule: "m6",
        matchedPatientId: patientId,
        decidedByMembershipId: USER,
        decidedAt: new Date().toISOString(),
        proposedEventContext: {
          eventType: "ADT^A03",
          eventTimestamp: `${deathDate}T12:00:00.000Z`,
          messageControlId: `ctl-${proposalId}`,
          sendingFacility: "ST_MARYS_HOSPITAL",
          mappedDischargeReason: "death",
        },
      },
    });
    return { patientId, admissionId, proposalId };
  }

  async function cosign(org: string, admissionId: string, actor = DIRECTOR) {
    const row = await dischargeRow(admissionId);
    return svc.cosignDischarge(org, row?.id as string, COSIGNER, Number(row?.version), actor);
  }

  const today = () => new Date().toISOString().slice(0, 10);
  /** A tick claims at most 25 rows per org and the admission ceremony alone emits more than that. */
  async function drain() {
    for (let i = 0; i < 12; i++) await dispatcher.tick();
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
      `INSERT INTO "user" (id,email) VALUES ($1,'f227a@x.test'),($2,'f227md@x.test'),($3,'f227at@x.test'),($4,'f227dir@x.test')`,
      [USER, MD, ATTENDING, DIRECTOR],
    );
    for (const org of [ORG_A, ORG_B]) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
          [org, `CCN-${org.slice(0, 4)}`, `Hospice ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles','active')`,
        [providerOf[org]],
      );
      for (const u of [USER, DIRECTOR])
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
          [u, org],
        );
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db);
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
    applier = buildM6ProposalAcceptedConsumer({ db: handle.db, outbox: bind("m6") as never });
    cosignConsumer = buildM16DischargeCosignedConsumer({
      db: handle.db,
      outbox: bind("m16") as never,
    });
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
          resolveAdmission: async (organizationId, admissionId) =>
            admissionSchedulingContextForOrg(handle.db, organizationId, admissionId),
        }),
        cosignConsumer,
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("the applier records the death COMPLETED at once, stamped hl7_external + cosign_required (W-M6-31)", async () => {
    const { admissionId, proposalId } = await externalDeath(ORG_A, today());
    const d = await dischargeRow(admissionId);
    expect(d).toMatchObject({
      status: "completed", // NOT pending_cosign: the spec discharges immediately; cosign attests
      source: "hl7_external",
      source_proposal_id: proposalId,
      cosign_required: true,
      cosigned_at: null,
      medical_director_membership_id: null,
      death_certifier_id: null, // the sending facility pronounced; M6 names no physician
    });
    const adm = await admin.query("SELECT status FROM admission WHERE id=$1", [admissionId]);
    // §2.3.1: a death discharge lands the admission in `bereavement` (the discharged-by-death terminal).
    expect(adm.rows[0].status).toBe("bereavement");
    // the catalog-validated emissions the pre-F-227 applier could not produce
    expect(await events("m6.discharge.death", admissionId)).toHaveLength(1);
    expect(await events("m6.bereavement.eligible", admissionId)).toHaveLength(1);
    expect(await events("m6.admission.discharged", admissionId)).toHaveLength(1);
    // the 7-day prompt
    const w = await noticeWindows(admissionId);
    expect(w).toHaveLength(1);
    expect(w[0].status).not.toBe("closed");
    expect(w[0].payload.reason).toBe("external_death_notice_pending_cosign");
    expect(w[0].payload.dischargeEventId).toBe(d?.id);
    const days =
      (new Date(w[0].must_complete_by).getTime() - new Date(w[0].starts_at).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
  });

  it("a redelivered accept is an idempotent skip — one discharge, one window", async () => {
    const { admissionId, patientId, proposalId } = await externalDeath(ORG_A, today());
    await applier.handle({
      organizationId: ORG_A,
      payload: {
        proposalId,
        organizationId: ORG_A,
        sourceMessageId: `msg-${proposalId}`,
        resourceKind: "discharge_event",
        ownerModule: "m6",
        matchedPatientId: patientId,
        decidedByMembershipId: USER,
        decidedAt: new Date().toISOString(),
        proposedEventContext: {
          eventType: "ADT^A03",
          eventTimestamp: `${today()}T12:00:00.000Z`,
          messageControlId: `ctl-${proposalId}`,
          sendingFacility: "ST_MARYS_HOSPITAL",
          mappedDischargeReason: "death",
        },
      },
    });
    const c = await admin.query(
      "SELECT count(*)::int AS n FROM discharge_event WHERE admission_id=$1",
      [admissionId],
    );
    expect(c.rows[0].n).toBe(1);
    expect(await noticeWindows(admissionId)).toHaveLength(1);
    expect(await events("m6.discharge.death", admissionId)).toHaveLength(1);
  });

  it("M16 opens the plan with the REAL proposal id (not the admission id) and cosign pending", async () => {
    const { admissionId, proposalId } = await externalDeath(ORG_A, today());
    await drain();
    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    const meta = plans[0].external_source_metadata;
    expect(meta.cosignStatus).toBe("pending");
    expect(meta.sourceProposalId).toBe(proposalId);
    expect(meta.sourceProposalId).not.toBe(admissionId);
  });

  it("cosign by the director attests: sets facts, closes the notice, publishes the enriched event; M16 releases the gate ONCE", async () => {
    const { admissionId, proposalId } = await externalDeath(ORG_A, today());
    await drain(); // plan opens, pending
    const out = await cosign(ORG_A, admissionId);
    expect(out.state).toBe("completed");

    const d = await dischargeRow(admissionId);
    expect(d?.status).toBe("completed");
    expect(d?.medical_director_membership_id).toBe(DIRECTOR);
    expect(d?.cosigned_at).not.toBeNull();
    const w = await noticeWindows(admissionId);
    expect(w[0].status).toBe("closed");
    expect(w[0].close_reason).toBe("external_death_cosigned");
    expect(w[0].closed_by).toBe(DIRECTOR);

    const ev = await events("m6.discharge.cosigned", admissionId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({
      sourceProposalId: proposalId,
      medicalDirectorMembershipId: DIRECTOR,
      reason: "death",
    });

    await drain();
    const plans = await plansFor(admissionId);
    const meta = plans[0].external_source_metadata;
    expect(meta.cosignStatus).toBe("cosigned");
    expect(meta.medicalDirectorMembershipId).toBe(DIRECTOR);
    expect(meta.cosignedAt).toBeTruthy();
    expect(plans[0].status).toBe("eligible"); // D18: state-preserving
    const { rows: cr } = await admin.query(
      `SELECT count(*)::int AS n FROM outbox_event
        WHERE event_type='m16.bereavement.external_source_cosign_received' AND aggregate_id=$1`,
      [plans[0].id],
    );
    expect(cr[0].n).toBe(1);

    // Redelivery (receipt cleared + event re-pended): a NO-OP — same version, same attestation, no 2nd event.
    const before = plans[0];
    await admin.query("DELETE FROM outbox_consumer_receipt");
    await admin.query(
      "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type='m6.discharge.cosigned'",
    );
    await drain();
    const after = (await plansFor(admissionId))[0];
    expect(after.version).toBe(before.version);
    expect(after.external_source_metadata.cosignedAt).toBe(meta.cosignedAt);
    const { rows: cr2 } = await admin.query(
      `SELECT count(*)::int AS n FROM outbox_event
        WHERE event_type='m16.bereavement.external_source_cosign_received' AND aggregate_id=$1`,
      [plans[0].id],
    );
    expect(cr2[0].n).toBe(1);
  });

  it("cosign arriving BEFORE the plan exists is a no-op; the later intake reads the cosigned fact", async () => {
    const { admissionId, proposalId } = await externalDeath(ORG_A, today());
    await cosign(ORG_A, admissionId);
    const ev = (await events("m6.discharge.cosigned", admissionId))[0];
    await cosignConsumer.handle({ organizationId: ORG_A, payload: ev.payload });
    expect(await plansFor(admissionId)).toHaveLength(0); // nothing to release yet, nothing invented
    await drain();
    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    expect(plans[0].external_source_metadata).toMatchObject({
      cosignStatus: "cosigned",
      sourceProposalId: proposalId,
      medicalDirectorMembershipId: DIRECTOR,
    });
  });

  it("a second cosign, a stale version and another tenant are all refused", async () => {
    const { admissionId } = await externalDeath(ORG_A, today());
    const row = await dischargeRow(admissionId);
    // cross-tenant: org B's context cannot see org A's discharge (RLS as chartwarden_app) -> not found
    await expect(
      svc.cosignDischarge(ORG_B, row?.id as string, COSIGNER, Number(row?.version), DIRECTOR),
    ).rejects.toThrow();
    expect((await dischargeRow(admissionId))?.cosigned_at).toBeNull();
    // stale version
    await expect(
      svc.cosignDischarge(ORG_A, row?.id as string, COSIGNER, Number(row?.version) + 5, DIRECTOR),
    ).rejects.toThrow();
    await cosign(ORG_A, admissionId);
    // already cosigned (fresh version): refused, attestation not restamped
    const done = await dischargeRow(admissionId);
    await expect(
      svc.cosignDischarge(ORG_A, done?.id as string, COSIGNER, Number(done?.version), USER),
    ).rejects.toThrow(/already cosigned/);
    const again = await dischargeRow(admissionId);
    expect(again?.medical_director_membership_id).toBe(DIRECTOR);
    expect(again?.cosigned_at).toEqual(done?.cosigned_at);
  });

  it("an internal death is untouched: completed, internal source, not cosign-required, no window; cosign refused", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    const r = await svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "death",
        dischargeDate: today(),
        narrative: "Patient died at home, family present.",
        deathCertifierId: MD,
        placeOfDeath: "home",
      } as never,
      USER,
    );
    const d = await dischargeRow(admissionId);
    expect(d).toMatchObject({
      status: "completed",
      source: "internal_clinician_recorded",
      source_proposal_id: null,
      cosign_required: false,
      death_certifier_id: MD,
    });
    expect(await noticeWindows(admissionId)).toHaveLength(0);
    await expect(
      svc.cosignDischarge(ORG_A, r.id, COSIGNER, Number(d?.version), DIRECTOR),
    ).rejects.toThrow();
    // the HTTP death route still demands the certifier (R-DC-01 not weakened)
    const other = await activeAdmission(ORG_A, randomUUID());
    await expect(
      svc.discharge(
        ORG_A,
        other,
        { reason: "death", dischargeDate: today(), narrative: "Patient died at home." } as never,
        USER,
      ),
    ).rejects.toThrow(/certifier/i);
    // M16 intake still opens an UNGATED plan for the internal death
    await drain();
    const plans = await plansFor(admissionId);
    expect(plans).toHaveLength(1);
    expect(plans[0].external_source_metadata).toBeNull();
  });

  it("a for-cause cosign still completes the discharge, stamps the facts, and M16 no-ops it", async () => {
    const patientId = randomUUID();
    const admissionId = await activeAdmission(ORG_A, patientId);
    const filed = await svc.discharge(
      ORG_A,
      admissionId,
      {
        reason: "for_cause",
        dischargeDate: today(),
        narrative: "Repeated threats toward staff, documented.",
        forCauseReason: "Repeated documented threats toward field staff over three visits.",
      } as never,
      USER,
    );
    expect(filed.state).toBe("pending_cosign");
    const pending = await dischargeRow(admissionId);
    expect(pending?.cosign_required).toBe(true);
    const done = await svc.cosignDischarge(
      ORG_A,
      filed.id,
      COSIGNER,
      Number(pending?.version),
      DIRECTOR,
    );
    expect(done.state).toBe("completed");
    const d = await dischargeRow(admissionId);
    expect(d?.medical_director_membership_id).toBe(DIRECTOR);
    const ev = await events("m6.discharge.cosigned", admissionId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.sourceProposalId).toBeUndefined();
    await drain(); // M16's cosign consumer no-ops (no source proposal) and does not dead-letter
    expect(await plansFor(admissionId)).toHaveLength(0);
    const { rows } = await admin.query(
      `SELECT r.consumer_name FROM outbox_event e JOIN outbox_consumer_receipt r ON r.event_id=e.id
        WHERE e.event_type='m6.discharge.cosigned' AND e.payload->>'admissionId'=$1`,
      [admissionId],
    );
    expect(rows.map((r) => r.consumer_name)).toContain("m16.m6-discharge-cosigned");
  });

  it("does not leak across tenants — org B's external death never touches org A's plan", async () => {
    const a = await externalDeath(ORG_A, today());
    const b = await externalDeath(ORG_B, today());
    await drain();
    await cosign(ORG_A, a.admissionId);
    await drain();
    expect((await plansFor(a.admissionId))[0].external_source_metadata.cosignStatus).toBe(
      "cosigned",
    );
    const pb = (await plansFor(b.admissionId))[0];
    expect(pb.organization_id).toBe(ORG_B);
    expect(pb.external_source_metadata.cosignStatus).toBe("pending");
    expect(pb.external_source_metadata.sourceProposalId).toBe(b.proposalId);
  });
});
