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
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { calculateHipps } from "@wardenx/billing";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { createSandboxHetsTransport } from "@wardenx/x12-837-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildProviderEligibilityIdentityReader } from "../src/bootstrap/provider-entity-resolver";
import { buildMbiUnlockReader } from "../src/modules/05-patient/mbi-unlock-reader";
import { priorEpisodesForOrg } from "../src/modules/06-admission/seams/prior-episodes";
import {
  M23_OUTBOX_EVENTS,
  buildDrizzleM23ReadService,
} from "../src/modules/23-billing-medicare/index";
import { buildHetsEligibilityPort } from "../src/modules/23-billing-medicare/jobs/hets-eligibility";
import {
  type M23WorkerDeps,
  runEligibilityRefresh,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { readClaimRhcCarryOver } from "../src/modules/23-billing-medicare/services/rhc-carry-over";
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
  carry: "5EG4TE5MK77",
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
    patient.carry = await seedPatient(ORG_A, "Carryover", MBIS.carry);

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

    // SEC-H1: the HETS unlock is a disclosure too — one audit row naming THIS check's id. The audit commits in
    // the reader's own tx, so on a failed/retried job it could name a check that was never persisted (expected
    // over-audit); on this success path the id equals the appended row's.
    const checkId = events.rows[0].payload.checkId as string;
    const disclosed = await admin.query(
      `SELECT actor_kind, resource_kind, context::text AS ctx FROM audit_event
        WHERE event_type='patient_payer.mbi_disclosed' AND context->>'subjectId'=$1`,
      [checkId],
    );
    expect(disclosed.rows).toHaveLength(1);
    expect(disclosed.rows[0]).toMatchObject({
      actor_kind: "system",
      resource_kind: "patient_payer",
    });
    expect(JSON.parse(disclosed.rows[0].ctx as string)).toMatchObject({
      purpose: "hets_270_eligibility",
      patientId: patient.history,
    });
    expect(disclosed.rows[0].ctx).not.toContain(MBIS.history);
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

  it("RHC carry-over: another hospice's period from the sandbox HETS history carries into a new election (readmission read + claim HIPPS)", async () => {
    // Arrange: HETS reports a billed period at ANOTHER hospice, 08/01–08/21 (21 days, revoked), and the patient
    // elects with us on 09/07 — 17 days later, within 60 (Claims Processing Manual ch. 11 §30.2).
    const carryDeps = {
      ...deps,
      hets: buildHetsEligibilityPort({
        transport: createSandboxHetsTransport({
          hospiceHistory: [
            { kind: "noe", start: "20260801", revocation: "1", npi: "1649726464" },
            {
              kind: "billed",
              start: "20260801",
              end: "20260821",
              days: 21,
              revocation: "1",
              npi: "1649726464",
            },
          ],
        }),
        submitterId: "SANDBOX",
        usage: "T",
        mbiUnlock: () => buildMbiUnlockReader(handle.db),
        providers: buildProviderEligibilityIdentityReader(handle.db),
        now: () => new Date(`${AS_OF}T12:00:00.000Z`),
      }),
    } as M23WorkerDeps;
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      runEligibilityRefresh(tx as never, carryDeps, {
        organizationId: ORG_A,
        patientId: patient.carry as string,
        providerEntityId: providerOf[ORG_A] as string,
        asOfServiceDate: AS_OF,
      }),
    );
    const now = new Date(`${AS_OF}T13:00:00.000Z`);

    // Act 1: the readmission screen's read, with M6's real prior-stays reader (no stays with us here).
    const read = buildDrizzleM23ReadService(handle.db as never, {
      hetsConfigured: true,
      now: () => now,
      priorStays: {
        forPatient: async (org, pid) =>
          (await priorEpisodesForOrg(handle.db, org, pid)).map((e) => ({
            admissionId: e.admissionId,
            startedOn: e.startedOn,
            endedOn: e.endedOn,
          })),
      },
    });
    const view = await read.getHospicePeriods(
      actorFor(ORG_A),
      patient.carry as string,
      "2026-09-07",
    );
    expect(view.rhcCarryOver).toMatchObject({
      priorDays: 21,
      basis: "hets_merged",
      startsAtDay: 22,
      daysSinceLastCare: 17,
      chain: [{ source: "hets", hospiceNpi: "1649726464", countedDays: 21, start: "2026-08-01" }],
      hetsCheck: { stale: false, ageDays: 0 },
    });
    // Without an election date the read is unchanged (no carry-over computed).
    expect(
      (await read.getHospicePeriods(actorFor(ORG_A), patient.carry as string)).rhcCarryOver,
    ).toBeNull();

    // Act 2: the claim path — the same merge inside an org-scoped tx as wardenx_app, then the HIPPS split.
    const carry = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      readClaimRhcCarryOver(
        tx as never,
        ORG_A,
        patient.carry as string,
        { hospiceAdmissionDate: "2026-09-07", rhcPriorHospiceDays: 0, rhcPriorStays: [] },
        now,
      ),
    );
    expect(carry.priorDays).toBe(21);
    const hipps = calculateHipps({
      claimServiceFrom: "2026-10-01",
      claimServiceTo: "2026-10-31",
      hospiceAdmissionDate: "2026-09-07",
      priorHospiceDays: carry.priorDays,
      levelOfCarePeriods: [
        { levelOfCare: "routine_home_care", from: "2026-09-07", to: "2026-10-31" },
      ],
      rateTable: {
        rhcDays1to60PerDiemCents: 21_500,
        rhcDays61PlusPerDiemCents: 17_000,
        chcHourlyRateCents: 4_400,
        ircPerDiemCents: 49_000,
        gipPerDiemCents: 118_000,
        rhcLaborShare: "0.6600",
        chcLaborShare: "0.6800",
        ircLaborShare: "0.5400",
        gipLaborShare: "0.6400",
      },
      wageIndexCcn: "381240",
      wageIndexFiscalYear: 2026,
      wageIndexFactorDecimal: "1.0000",
    });
    // Day 22 on 09/07 → day 60 on 10/15: 10/01–10/15 high, 10/16–10/31 low (without HETS: all 31 high).
    expect(hipps.rhcDays1to60).toBe(15);
    expect(hipps.rhcDays61Plus).toBe(16);

    // Tenant isolation: org B never sees org A's check.
    const otherOrg = await buildDrizzleM23ReadService(handle.db as never, {
      hetsConfigured: true,
      now: () => now,
    }).getHospicePeriods(actorFor(ORG_B), patient.carry as string, "2026-09-07");
    expect(otherOrg.rhcCarryOver).toMatchObject({
      priorDays: 0,
      basis: "internal_only",
      chain: [],
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
        disclosure: { purpose: "hets_270_eligibility", subjectId: randomUUID() },
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
    // One check per scenario patient so far, the RHC carry-over patient included.
    const checks = await admin.query("SELECT count(*)::int AS n FROM eligibility_check");
    expect(checks.rows[0].n).toBe(6);
    const audits = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='eligibility_check'",
    );
    expect(audits.rows[0].n).toBe(6);
    for (const [name, sql] of Object.entries(tables)) {
      const { rows } = await admin.query(sql);
      const dump = rows.map((r) => r.j as string).join("\n");
      for (const mbi of Object.values(MBIS))
        expect(dump, `${name} carries an MBI`).not.toContain(mbi);
      expect(MBI_SHAPE.test(dump), `${name} carries an MBI-shaped token`).toBe(false);
    }
  });
  it("H1: an MBI unlock lands a patient_payer.mbi_disclosed audit (ids + purpose + actor, no MBI), scoped by its subject", async () => {
    const unlock = buildMbiUnlockReader(handle.db);
    const claimId = randomUUID();
    const identity = await unlock.unlockForEligibility({
      organizationId: ORG_A,
      patientId: patient.history as string,
      onDate: AS_OF,
      disclosure: { purpose: "claim_837i_submission", subjectId: claimId },
    });
    expect(identity?.mbi).toBe(MBIS.history);
    const { rows } = await admin.query(
      `SELECT actor_kind, actor_user_id, resource_kind, resource_id, severity, context::text AS ctx
         FROM audit_event WHERE event_type='patient_payer.mbi_disclosed' AND context->>'subjectId'=$1`,
      [claimId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "system",
      actor_user_id: null,
      resource_kind: "patient_payer",
      resource_id: identity?.patientPayerId,
      severity: "warn",
    });
    const ctx = JSON.parse(rows[0].ctx as string);
    expect(ctx).toMatchObject({
      purpose: "claim_837i_submission",
      subjectId: claimId,
      patientId: patient.history,
    });
    expect(rows[0].ctx).not.toContain(MBIS.history);
    // Org B cannot unlock (or audit a disclosure of) org A's patient.
    expect(
      await unlock.unlockForEligibility({
        organizationId: ORG_B,
        patientId: patient.history as string,
        onDate: AS_OF,
        disclosure: { purpose: "claim_837i_submission", subjectId: claimId },
      }),
    ).toBeNull();
  });

  it("M2: a user-triggered disclosure records who", async () => {
    const unlock = buildMbiUnlockReader(handle.db);
    const subjectId = randomUUID();
    await unlock.unlockForEligibility({
      organizationId: ORG_A,
      patientId: patient.history as string,
      onDate: AS_OF,
      disclosure: { purpose: "claim_837i_submission", subjectId, actorUserId: USER },
    });
    const { rows } = await admin.query(
      `SELECT actor_kind, actor_user_id FROM audit_event
        WHERE event_type='patient_payer.mbi_disclosed' AND context->>'subjectId'=$1`,
      [subjectId],
    );
    expect(rows).toEqual([{ actor_kind: "user", actor_user_id: USER }]);
  });

  it("M1: expectedPatientPayerId selects exactly that coverage; another patient's or an unknown id returns nothing and audits nothing", async () => {
    const unlock = buildMbiUnlockReader(handle.db);
    const own = (
      await admin.query("SELECT id FROM patient_payer WHERE patient_id=$1", [patient.history])
    ).rows[0].id as string;
    const other = (
      await admin.query("SELECT id FROM patient_payer WHERE patient_id=$1", [patient.open])
    ).rows[0].id as string;
    const base = {
      organizationId: ORG_A,
      patientId: patient.history as string,
      onDate: AS_OF,
    };
    const okSubject = randomUUID();
    const ok = await unlock.unlockForEligibility({
      ...base,
      expectedPatientPayerId: own,
      disclosure: { purpose: "claim_837i_submission", subjectId: okSubject },
    });
    expect(ok?.patientPayerId).toBe(own);
    for (const wrong of [other, randomUUID()]) {
      const subjectId = randomUUID();
      expect(
        await unlock.unlockForEligibility({
          ...base,
          expectedPatientPayerId: wrong,
          disclosure: { purpose: "claim_837i_submission", subjectId },
        }),
      ).toBeNull();
      const n = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type='patient_payer.mbi_disclosed' AND context->>'subjectId'=$1",
        [subjectId],
      );
      expect(n.rows[0].n).toBe(0);
    }
  });

  it("L1: a non-uuid subject or an unknown purpose is refused before anything is read or audited", async () => {
    const unlock = buildMbiUnlockReader(handle.db);
    const base = { organizationId: ORG_A, patientId: patient.history as string, onDate: AS_OF };
    await expect(
      unlock.unlockForEligibility({
        ...base,
        disclosure: { purpose: "claim_837i_submission", subjectId: MBIS.history },
      }),
    ).rejects.toThrow(/subjectId must be a uuid/);
    await expect(
      unlock.unlockForEligibility({
        ...base,
        disclosure: { purpose: "anything" as never, subjectId: randomUUID() },
      }),
    ).rejects.toThrow(/purpose/);
    const leaked = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE context::text LIKE $1",
      [`%${MBIS.history}%`],
    );
    expect(leaked.rows[0].n).toBe(0);
  });
});
