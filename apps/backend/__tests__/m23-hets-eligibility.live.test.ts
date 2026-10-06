/**
 * M23 §4.4 HETS 270/271 eligibility — END TO END over real Postgres, as the NOBYPASSRLS `wardenx_app` role.
 *
 * The real M5 `MbiUnlockReader` reads the patient's Medicare FFS `patient_payer.subscriber_id` (the MBI) under
 * RLS → the real HETS port builds the 270 → the fixture-backed SANDBOX transport answers with a synthetic 271
 * (no network) → the real 271 parser derives the hospice election / benefit-period history → the real
 * `eligibility.refresh` worker body appends the append-only `eligibility_check` row and publishes
 * `m23.eligibility.checked` through the REAL catalog-validating outbox publisher → the real Drizzle read
 * service serves `GET /billing/eligibility/hospice-periods`.
 *
 * The D13 / §3.6 / §8.7 regression: after every scenario the MBI (and any MBI-shaped token) appears in NO
 * `eligibility_check` row, NO `audit_event` row and NO `outbox_event` payload.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:hets-eligibility:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { createSandboxHetsTransport } from "@wardenx/x12-837-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildProviderEligibilityIdentityReader } from "../src/bootstrap/provider-entity-resolver";
import { buildMbiUnlockReader } from "../src/modules/05-patient/mbi-unlock-reader";
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23ReadService,
} from "../src/modules/23-billing-medicare/index";
import { buildHetsEligibilityPort } from "../src/modules/23-billing-medicare/jobs/hets-eligibility";
import {
  type M23WorkerDeps,
  runEligibilityRefresh,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PAYER = "44444444-4444-4444-4444-444444444444";
const AS_OF = "2026-10-06";
const MBI_SHAPE =
  /[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y]{2}[0-9]{2}/;

/** Synthetic, CMS-format MBIs (one per scenario patient). */
const MBIS = {
  history: "1EG4TE5MK73",
  open: "2EG4TE5MK74",
  notFound: "3EG4TE5MK75",
  orgB: "4EG4TE5MK76",
} as const;

describe.skipIf(!DB_URL)("M23 HETS 270/271 eligibility — LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const providerOf: Record<string, string> = {};
  const patient: Record<string, string> = {};
  let deps: M23WorkerDeps;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }

  async function seedPatient(org: string, lastName: string, mbi: string | null): Promise<string> {
    const id = (
      await admin.query(
        `INSERT INTO patient (organization_id, provider_entity_id, mrn, legal_first_name, legal_last_name, dob,
                              sex_assigned_at_birth, status)
           VALUES ($1,$2,$3,'Jane',$4,'1940-04-01','F','active') RETURNING id`,
        [org, providerOf[org], `MRN-${lastName}`, lastName],
      )
    ).rows[0].id as string;
    if (mbi) {
      await admin.query(
        `INSERT INTO patient_payer (patient_id, organization_id, provider_entity_id, payer_id, rank, coverage_kind,
                                    subscriber_id, effective_from)
           VALUES ($1,$2,$3,$4,1,'medicare_ffs',$5,'2005-04-01')`,
        [id, org, providerOf[org], PAYER, mbi],
      );
    }
    return id;
  }

  /** Run the real worker body for one patient inside the worker's own org-context tx (as wardenx_app). */
  async function refresh(org: string, patientId: string): Promise<void> {
    await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      runEligibilityRefresh(tx as never, deps, {
        organizationId: org,
        patientId,
        providerEntityId: providerOf[org] as string,
        asOfServiceDate: AS_OF,
      }),
    );
  }

  const actorFor = (org: string) =>
    ({ organizationId: org, userId: USER, membershipId: USER }) as never;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'hets@x.test')`, [USER]);
    for (const [org, npi] of [
      [ORG_A, "1234567893"],
      [ORG_B, "1093817465"],
    ] as const) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
          [org, `H${org.slice(0, 5)}`, `Engrace Hospice ${org.slice(0, 1)}`, npi],
        )
      ).rows[0].id as string;
    }
    patient.history = await seedPatient(ORG_A, "Whitfield", MBIS.history);
    patient.open = await seedPatient(ORG_A, "Openelection", MBIS.open);
    patient.notFound = await seedPatient(ORG_A, "Notfound", MBIS.notFound);
    patient.noMbi = await seedPatient(ORG_A, "Nocoverage", null);
    patient.orgB = await seedPatient(ORG_B, "Bpatient", MBIS.orgB);

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
    deps = {
      connection: {},
      db: handle.db as never,
      outbox: {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m23" } as never),
      },
      hets: buildHetsEligibilityPort({
        transport: createSandboxHetsTransport(),
        submitterId: "SANDBOX",
        usage: "T",
        mbiUnlock: () => buildMbiUnlockReader(handle.db),
        providers: buildProviderEligibilityIdentityReader(handle.db),
        now: () => new Date(`${AS_OF}T12:00:00.000Z`),
      }),
    } as M23WorkerDeps;
  }, 180_000);

  afterAll(async () => {
    await handle?.pool.end();
    await admin?.end();
  });

  it("records an active Part A check with the cross-hospice history and computes period 4", async () => {
    await refresh(ORG_A, patient.history as string);
    const { rows } = await admin.query(
      "SELECT outcome::text, parsed_payload, raw_response_file_uri, worker_correlation_id FROM eligibility_check WHERE patient_id=$1",
      [patient.history],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("active_part_a");
    expect(rows[0].raw_response_file_uri).toBeNull();
    expect(rows[0].worker_correlation_id).toMatch(/^[0-9a-f]{30}$/);
    expect(rows[0].parsed_payload).toMatchObject({
      partAActive: true,
      hospiceElectionOpen: false,
      hospiceNextPeriodNumber: 4,
      transport: "sandbox",
    });

    const read = buildDrizzleM23ReadService(handle.db as never, {
      hetsConfigured: true,
      now: () => new Date(`${AS_OF}T13:00:00.000Z`),
    });
    const view = await read.getHospicePeriods(actorFor(ORG_A), patient.history as string);
    expect(view).toMatchObject({
      status: "available",
      outcome: "active_part_a",
      stale: false,
      synthetic: true,
      hospiceHistoryReturned: true,
      hospiceElectionOpen: false,
      nextPeriodNumber: 4,
      nextPeriodBasis: "computed",
      lastAttempt: null,
    });
    expect(
      view.hospicePeriods.filter((p) => p.kind === "benefit_period").map((p) => p.periodNumber),
    ).toEqual([1, 2, 3]);
    expect(view.hospicePeriods.at(-1)).toMatchObject({
      hospiceNpi: "1234567893",
      revocationCode: "2",
      revocationOrDischargeDate: "2023-08-20",
    });

    const events = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m23.eligibility.checked' AND payload->>'patientId'=$1",
      [patient.history],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("flags an open election at another hospice — no next period number", async () => {
    await refresh(ORG_A, patient.open as string);
    const view = await buildDrizzleM23ReadService(handle.db as never, {
      hetsConfigured: true,
    }).getHospicePeriods(actorFor(ORG_A), patient.open as string);
    expect(view).toMatchObject({
      status: "available",
      hospiceElectionOpen: true,
      nextPeriodNumber: null,
      nextPeriodBasis: "election_open",
    });
  });

  it("records mbi_invalid for a HETS AAA 72 and for a patient with no Medicare MBI on file", async () => {
    await refresh(ORG_A, patient.notFound as string);
    await refresh(ORG_A, patient.noMbi as string);
    const { rows } = await admin.query(
      `SELECT patient_id, outcome::text, parsed_payload->>'reason' AS reason, stale_at = checked_at AS stale_now
         FROM eligibility_check WHERE patient_id = ANY($1::uuid[]) ORDER BY patient_id`,
      [[patient.notFound, patient.noMbi]],
    );
    const byPatient = Object.fromEntries(rows.map((r) => [r.patient_id, r]));
    expect(byPatient[patient.notFound as string]).toMatchObject({
      outcome: "mbi_invalid",
      reason: "hets_271_mbi_invalid",
    });
    expect(byPatient[patient.noMbi as string]).toMatchObject({
      outcome: "mbi_invalid",
      reason: "mbi_not_on_file",
    });
    const view = await buildDrizzleM23ReadService(handle.db as never, {
      hetsConfigured: true,
    }).getHospicePeriods(actorFor(ORG_A), patient.notFound as string);
    expect(view.status).toBe("no_check_on_file");
    expect(view.lastAttempt).toMatchObject({
      outcome: "mbi_invalid",
      reason: "hets_271_mbi_invalid",
    });
  });

  it("keeps tenants apart: org B neither unlocks nor reads org A's patient", async () => {
    const unlock = buildMbiUnlockReader(handle.db);
    expect(
      await unlock.unlockForEligibility({
        organizationId: ORG_B,
        patientId: patient.history as string,
        onDate: AS_OF,
      }),
    ).toBeNull();
    const view = await buildDrizzleM23ReadService(handle.db as never, {
      hetsConfigured: false,
    }).getHospicePeriods(actorFor(ORG_B), patient.history as string);
    expect(view).toMatchObject({ status: "hets_not_configured", checkId: null, lastAttempt: null });
  });

  it("D13: no MBI (or MBI-shaped token) in eligibility_check, audit_event or outbox_event", async () => {
    await refresh(ORG_B, patient.orgB as string);
    const tables = {
      eligibility_check: "SELECT row_to_json(t)::text AS j FROM eligibility_check t",
      audit_event:
        "SELECT row_to_json(t)::text AS j FROM audit_event t WHERE resource_kind <> 'patient_payer' OR resource_kind IS NULL",
      patient_payer_audit:
        "SELECT row_to_json(t)::text AS j FROM audit_event t WHERE resource_kind = 'patient_payer'",
      outbox_event: "SELECT row_to_json(t)::text AS j FROM outbox_event t",
    };
    const checks = await admin.query("SELECT count(*)::int AS n FROM eligibility_check");
    expect(checks.rows[0].n).toBe(5);
    const audits = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='eligibility_check'",
    );
    expect(audits.rows[0].n).toBe(5);
    for (const [name, sql] of Object.entries(tables)) {
      const { rows } = await admin.query(sql);
      const dump = rows.map((r) => r.j as string).join("\n");
      for (const mbi of Object.values(MBIS))
        expect(dump, `${name} carries an MBI`).not.toContain(mbi);
      expect(MBI_SHAPE.test(dump), `${name} carries an MBI-shaped token`).toBe(false);
    }
  });
});
