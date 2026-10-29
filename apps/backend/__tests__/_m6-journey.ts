// apps/backend/__tests__/_m6-journey.ts — shared boot + patient-journey steps for the S01/S02 clinical
// end-to-end live suites (docs/audits: ChartWarden_Clinical_Workflow_Audit_2026-10-28, section 5).
//
// Boots the production M5 patient + M6 admission write services over real Postgres as the NOBYPASSRLS
// `chartwarden_app` role with the catalog-validating outbox publisher (not NOOP_OUTBOX), and exposes the
// referral → NOR → election → CTI → activation ceremony as helpers. Synthetic identifiers only.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildProviderEntityLocationLister } from "../src/bootstrap/provider-entity-resolver";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  createDrizzleAdmissionReaderStore,
  registerAdmissionSeams,
} from "../src/modules/06-admission/index";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";
import { registerM5IntakeSeams, seedM5Patient } from "./_m6-admit";
import { dischargeOrderBy, seedPhysicianRole } from "./_physician-signer";

export const ORG = "11111111-1111-1111-1111-111111111111";
export const ORG_B = "22222222-2222-2222-2222-222222222222";
export const USER = "33333333-3333-3333-3333-333333333333";
export const MD = "66666666-6666-6666-6666-666666666666";
export const ATTENDING = "77777777-7777-7777-7777-777777777777";

const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

export const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export type AdmissionSvc = ReturnType<typeof createDbAdmissionRouteService>;

export interface Journey {
  readonly admin: Client;
  readonly handle: ReturnType<typeof createDbClient>;
  readonly svc: AdmissionSvc;
  readonly patients: ReturnType<typeof createDbPatientRouteService>;
  readonly providerId: string;
  close(): Promise<void>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Referral → triage → qualify (v2) for an existing M5 patient. Returns the referral id. */
  qualifiedReferral(patientId: string): Promise<string>;
  /** Referral → … → accept → admission details. Returns the (pending) admission id. */
  admit(patientId: string, admissionAt?: string): Promise<string>;
  /** NOR + signed election + hospice-MD-signed CTI (the §418.24 bundle), then activation. */
  completeAndActivate(admissionId: string): Promise<void>;
  /** A live discharge (`no_longer_terminal`) with the 418.26(b) physician order. */
  dischargeLive(admissionId: string, dischargeDate?: string): Promise<void>;
  /** A fresh M5 patient row, admitted active. */
  newPatient(): Promise<string>;
}

/** Boot the schema, tenants, staff and production services. Call from `beforeAll`. */
export async function bootJourney(dbUrl: string, tag: string): Promise<Journey> {
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  await resetPublicSchema(admin);
  await dropLiveRoles(admin);
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  await admin.query(
    "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
    [ORG, ORG_B],
  );
  await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$4),($2,$5),($3,$6)`, [
    USER,
    MD,
    ATTENDING,
    `${tag}@x.test`,
    `${tag}md@x.test`,
    `${tag}at@x.test`,
  ]);
  const providerId = (
    await admin.query<{ id: string }>(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,'H11111','Hospice A','NPI-1111','\\x00','12-31') RETURNING id`,
      [ORG],
    )
  ).rows[0]?.id as string;
  await admin.query(
    `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
     VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles','active')`,
    [providerId],
  );
  for (const org of [ORG, ORG_B])
    await admin.query(
      "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
      [USER, org],
    );
  await seedPhysicianRole(admin, ORG, MD);

  const handle = createDbClient({
    connectionString: await appRoleConnectionString(admin, dbUrl),
  });
  registerM5IntakeSeams(handle.db);
  registerAdmissionSeams({ store: createDrizzleAdmissionReaderStore(handle.db) });
  const publisher = buildTxOutboxPublisher(
    buildBootOutboxCatalog([M5_OUTBOX_EVENTS, M6_OUTBOX_EVENTS]),
  );
  const bind = (module: string) => ({
    publish: (tx: unknown, e: Record<string, unknown>) =>
      publisher.publish(tx as never, { ...e, callerModule: module } as never),
  });
  const svc = createDbAdmissionRouteService(
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
  const patients = createDbPatientRouteService(handle.db, bind("m5") as never);

  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    (await admin.query(sql, params)).rows[0] as T;
  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, params)).rows as T[];

  const qualifiedReferral = async (patientId: string): Promise<string> => {
    const ref = await svc.createReferral(
      ORG,
      {
        source: "phone",
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt: "P",
        patientId,
        referrerName: "Dr. Referrer",
        referringDxText: "Metastatic NSCLC",
      } as never,
      USER,
    );
    await svc.triageReferral(ORG, ref.id, "eligible", 0);
    await svc.qualifyReferral(ORG, ref.id, 1, USER);
    return ref.id;
  };

  const admit = async (
    patientId: string,
    admissionAt = `${daysAgo(1)}T00:00:00.000Z`,
  ): Promise<string> => {
    const refId = await qualifiedReferral(patientId);
    const { admissionId } = await svc.acceptReferral(
      ORG,
      refId,
      { primaryDiagnosisIcd10: "C34.90", patientId } as never,
      2,
      USER,
    );
    const { version } = await one<{ version: string }>(
      "SELECT version FROM admission WHERE id=$1",
      [admissionId],
    );
    await svc.updateAdmission(
      ORG,
      admissionId,
      { admissionAt, hospicePhysicianId: MD },
      Number(version),
    );
    return admissionId;
  };

  const completeAndActivate = async (admissionId: string): Promise<void> => {
    const period = await one<{ id: string }>(
      "SELECT id FROM election_period WHERE admission_id=$1 ORDER BY sequence_number LIMIT 1",
      [admissionId],
    );
    const nor = await svc.acknowledgeNor(
      ORG,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG, admissionId, period.id, {
      electedProviderEntityId: providerId,
      electedAttendingPhysicianId: ATTENDING,
      waiverAcknowledged: true,
    });
    await svc.signElection(ORG, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG,
      {
        electionPeriodId: period.id,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG, cti.id, cti.version, USER);
    await svc.activateAdmission(ORG, admissionId, nor.version);
  };

  const dischargeLive = async (admissionId: string, dischargeDate = daysAgo(0)): Promise<void> => {
    const adm = await svc.getAdmission(ORG, admissionId);
    await svc.discharge(
      ORG,
      admissionId,
      {
        reason: "no_longer_terminal",
        dischargeDate,
        narrative:
          "The patient's condition stabilized; no longer terminally ill per the IDG review.",
        dischargeOrder: dischargeOrderBy(MD, dischargeDate),
        ifVersion: adm?.version,
      } as never,
      USER,
    );
  };

  const newPatient = async (): Promise<string> => {
    const id = randomUUID();
    await seedM5Patient(admin, ORG, id);
    return id;
  };

  return {
    admin,
    handle,
    svc,
    patients,
    providerId,
    one,
    rows,
    qualifiedReferral,
    admit,
    completeAndActivate,
    dischargeLive,
    newPatient,
    async close() {
      await handle.close();
      await admin.end();
    },
  };
}
