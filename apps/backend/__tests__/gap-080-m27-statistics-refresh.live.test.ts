/**
 * GAP-080 — the M27 Worksheet S-3 statistics refresh, LIVE Postgres.
 *
 * `statistics-refresh` always failed (every `statisticsSeams.*` port threw `M27WorkerPortUnbound`) and
 * `statistic_data` could not be filled. This suite drives the real thing end to end as the NOBYPASSRLS
 * `chartwarden_app` role: the four org-explicit source seams (M6 service census, M5 payer program, M8 completed
 * visits, M16 bereavement census) each against real rows, then the whole `runStatisticsRefresh` job through the
 * production Drizzle repos, the catalog-validating outbox publisher and the real FTE source (M27's own wage import).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m27:statistics:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { payerProgramsForPatientsForOrg } from "../src/modules/05-patient/seams/payer-programs-for-patients";
import { serviceCensusForOrg } from "../src/modules/06-admission/seams/service-census-for-org";
import { visitCountsByDisciplineForOrg } from "../src/modules/08-encounters/seams/visit-counts-by-discipline-for-org";
import { bereavementCensusForOrg } from "../src/modules/16-bereavement/seams/bereavement-census-for-org";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { runStatisticsRefresh } from "../src/modules/27-cost-report/jobs/m27-jobs";
import { buildM27StatisticsSeams } from "../src/modules/27-cost-report/jobs/statistics-seams";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG = "11111111-1111-1111-1111-111111111080";
const OTHER_ORG = "11111111-1111-1111-1111-111111111081";
const PE = "00000000-0000-0000-0000-000000000a80";
const PE_SIBLING = "00000000-0000-0000-0000-000000000a81";
const OTHER_PE = "00000000-0000-0000-0000-000000000a82";
const USER = "00000000-0000-0000-0000-0000000ba080";
const P1 = "00000000-0000-0000-0000-0000000ee001";
const P2 = "00000000-0000-0000-0000-0000000ee002";
const P3 = "00000000-0000-0000-0000-0000000ee003";
const P_OTHER = "00000000-0000-0000-0000-0000000ee004";
const A1 = "00000000-0000-0000-0000-0000000aa001";
const A2 = "00000000-0000-0000-0000-0000000aa002";
const A3 = "00000000-0000-0000-0000-0000000aa003";
const A_OTHER = "00000000-0000-0000-0000-0000000aa004";
const REPORT = "00000000-0000-0000-0000-0000000cc080";
const AS_OF = new Date("2026-03-31T12:00:00.000Z");
const FY = { from: "2026-01-01", to: "2026-12-31" };

describe.skipIf(!DB_URL)("GAP-080 M27 statistics refresh — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let membershipId = "";

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);

  async function seedOrg(org: string, slug: string, pe: string, ccn: string, npi: string) {
    await q("INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)", [
      org,
      slug,
    ]);
    await q(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
       VALUES ($1,$2,'PE','${ccn}','${npi}','enc','12-31')`,
      [pe, org],
    );
  }
  async function seedPatient(org: string, id: string, n: number) {
    await q(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,$3,'Pat','Patient','1940-01-01','F')`,
      [id, org, `MRN-080-${n}`],
    );
  }
  async function seedAdmission(
    id: string,
    org: string,
    patient: string,
    pe: string,
    admissionAt: string,
  ) {
    await q(
      `INSERT INTO admission (id, organization_id, patient_id, provider_entity_id, status, admission_at, activated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [id, org, patient, pe, admissionAt],
    );
  }
  async function seedLoc(
    org: string,
    admission: string,
    level: string,
    from: string,
    to: string | null,
  ) {
    await q(
      `INSERT INTO level_of_care_period (organization_id, admission_id, level_of_care, effective_at, ended_at, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [org, admission, level, from, to, to ? "ended" : "active"],
    );
  }
  async function seedEncounter(
    org: string,
    pe: string,
    patient: string,
    admission: string,
    discipline: string,
    status: string,
    serviceDate: string,
  ) {
    const draft = status === "draft";
    const signedish = ["signed", "cosign_pending", "cosigned"].includes(status);
    const voided = status === "voided";
    await q(
      `INSERT INTO encounter (organization_id, provider_entity_id, patient_id, admission_id, encounter_type,
         discipline, authored_by_membership_id, service_date, status, vocab_version_id, signed_at,
         voided_at, voided_by, voided_reason)
       VALUES ($1,$2,$3,$4,'routine_visit',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        org,
        pe,
        patient,
        admission,
        discipline,
        membershipId,
        serviceDate,
        status,
        draft ? null : randomUUID(),
        signedish ? `${serviceDate}T12:00:00Z` : null,
        voided ? `${serviceDate}T13:00:00Z` : null,
        voided ? membershipId : null,
        voided ? "Entered against the wrong patient; recorded in error and replaced." : null,
      ],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await q("DROP SCHEMA IF EXISTS public CASCADE");
    await q("CREATE SCHEMA public");
    for (const r of ROLES) {
      await q(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await seedOrg(ORG, "org-080", PE, "080001", "1234567893");
    await q(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
       VALUES ($1,$2,'PE2','080002','1245319599','enc','12-31')`,
      [PE_SIBLING, ORG],
    );
    await seedOrg(OTHER_ORG, "org-081", OTHER_PE, "080003", "1003000126");
    await q(`INSERT INTO "user" (id,email) VALUES ($1,'gap080@x.test')`, [USER]);
    membershipId = (
      await q(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id;

    for (const [org, id, n] of [
      [ORG, P1, 1],
      [ORG, P2, 2],
      [ORG, P3, 3],
      [OTHER_ORG, P_OTHER, 4],
    ] as const)
      await seedPatient(org, id, n);
    // A1: RHC Jan 10 → Feb 12 (ended), then GIP Feb 12 → Mar 20 (death). A2: RHC Feb 5 → open.
    // A3: another entity's admission (excluded). A_OTHER: another tenant's (excluded).
    await seedAdmission(A1, ORG, P1, PE, "2026-01-10T09:00:00Z");
    await seedAdmission(A2, ORG, P2, PE, "2026-02-05T09:00:00Z");
    await seedAdmission(A3, ORG, P3, PE_SIBLING, "2026-01-15T09:00:00Z");
    await seedAdmission(A_OTHER, OTHER_ORG, P_OTHER, OTHER_PE, "2026-01-12T09:00:00Z");
    await seedLoc(ORG, A1, "routine_home_care", "2026-01-10T09:00:00Z", "2026-02-12T09:00:00Z");
    await seedLoc(
      ORG,
      A1,
      "general_inpatient_care",
      "2026-02-12T09:00:00Z",
      "2026-03-20T09:00:00Z",
    );
    await seedLoc(ORG, A2, "routine_home_care", "2026-02-05T09:00:00Z", null);
    await seedLoc(ORG, A3, "routine_home_care", "2026-01-15T09:00:00Z", null);
    await seedLoc(OTHER_ORG, A_OTHER, "routine_home_care", "2026-01-12T09:00:00Z", null);
    await q(
      `INSERT INTO discharge_event (organization_id, admission_id, discharge_type, effective_at, death_at, place_of_death)
       VALUES ($1,$2,'death','2026-03-20','2026-03-20T09:00:00Z','home')`,
      [ORG, A1],
    );
    // payer programs
    for (const [org, patient, kind] of [
      [ORG, P1, "medicare_ffs"],
      [ORG, P2, "medicaid"],
      [ORG, P3, "commercial"],
    ] as const)
      await q(
        `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from)
         VALUES ($1,$2,$3,1,$4,'SUB123','2025-01-01')`,
        [patient, org, randomUUID(), kind],
      );

    // M8 — completed visits at PE count; drafts, voids, other entity / tenant / year do not.
    await seedEncounter(ORG, PE, P1, A1, "rn", "signed", "2026-01-20");
    await seedEncounter(ORG, PE, P1, A1, "rn", "cosigned", "2026-02-02");
    await seedEncounter(ORG, PE, P2, A2, "rn", "finalized", "2026-02-20");
    await seedEncounter(ORG, PE, P2, A2, "msw", "cosign_pending", "2026-03-01");
    await seedEncounter(ORG, PE, P1, A1, "rn", "draft", "2026-03-02");
    await seedEncounter(ORG, PE, P1, A1, "rn", "voided", "2026-03-03");
    await seedEncounter(ORG, PE, P1, A1, "rn", "signed", "2025-12-31");
    await seedEncounter(ORG, PE_SIBLING, P3, A3, "rn", "signed", "2026-02-10");

    // M16 — one served contact, one merely proposed; two completed visit-kind touchpoints, one mailed.
    const plan = (
      await q(
        `INSERT INTO bereavement_plan (organization_id, patient_id, admission_id, provider_entity_id, death_date, opened_at, status, assigned_counselor_user_id)
         VALUES ($1,$2,$3,$4,'2026-03-20','2026-03-21T00:00:00Z','active',$5) RETURNING id`,
        [ORG, P1, A1, PE, USER],
      )
    ).rows[0].id as string;
    const contact = async (name: string, status: string) =>
      (
        await q(
          `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status)
           VALUES ($1,$2,$3,$4,'spouse',$5) RETURNING id`,
          [ORG, PE, plan, name, status],
        )
      ).rows[0].id as string;
    const served = await contact("Served", "active");
    await contact("Proposed", "proposed");
    const touch = (kind: string, status: string, completedAt: string | null) =>
      q(
        `INSERT INTO bereavement_outreach (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
           death_anchor_at, due_at, late_grace_until, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'2026-03-20T00:00:00Z','2026-04-01T00:00:00Z','2026-04-08T00:00:00Z',$7)`,
        [ORG, PE, plan, served, kind, status, completedAt],
      );
    await touch("phone_call", "completed", "2026-04-02T10:00:00Z");
    await touch("in_person_visit", "completed", "2026-05-02T10:00:00Z");
    await touch("sympathy_card", "completed", "2026-04-03T10:00:00Z");
    await touch("phone_call", "scheduled", null);
    await touch("in_person_visit", "completed", "2027-01-05T10:00:00Z"); // outside the fiscal year

    // M27 — the report + its completed wage import (the FTE source)
    await q(
      `INSERT INTO cost_report (id, organization_id, provider_entity_id, fiscal_year_start_date, fiscal_year_end_date)
       VALUES ($1,$2,$3,$4,$5)`,
      [REPORT, ORG, PE, FY.from, FY.to],
    );
    await q(
      `INSERT INTO wage_data_import (organization_id, cost_report_id, source, status, normalized_wage_rows)
       VALUES ($1,$2,'gusto','complete',$3::jsonb)`,
      [
        ORG,
        REPORT,
        JSON.stringify([
          { discipline: "Registered Nurse", paidHours: 3120, salaryCents: 1, fringeCents: 1 },
          { discipline: "RN", paidHours: 1040, salaryCents: 1, fringeCents: 1 },
          { discipline: "Home Health Aide", paidHours: 1040, salaryCents: 1, fringeCents: 1 },
        ]),
      ],
    );

    await q(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const seams = () =>
    buildM27StatisticsSeams({
      db: handle.db,
      serviceCensus: (org, w) => serviceCensusForOrg(handle.db, org, w),
      payerPrograms: (org, ids, asOf) => payerProgramsForPatientsForOrg(handle.db, org, ids, asOf),
      visitCounts: (org, w) => visitCountsByDisciplineForOrg(handle.db, org, w),
      bereavementCensus: (org, w) => bereavementCensusForOrg(handle.db, org, w),
      now: () => AS_OF,
    });
  const scope = (over: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    costReportId: REPORT,
    providerEntityId: PE,
    fiscalYearStartDate: FY.from,
    fiscalYearEndDate: FY.to,
    ...over,
  });

  it("M6 service census: per-patient days by month × level of care, this entity and tenant only", async () => {
    const census = await serviceCensusForOrg(handle.db, ORG, {
      providerEntityId: PE,
      ...FY,
      asOf: AS_OF,
    });
    const days = (patient: string, loc: string, month: string) =>
      census.days.find((d) => d.patientId === patient && d.levelOfCare === loc && d.month === month)
        ?.patientDays;
    // A1 RHC Jan 10 → Feb 12 (the change day counts under the NEW level)
    expect(days(P1, "routine_home_care", "2026-01")).toBe(22); // Jan 10..31
    expect(days(P1, "routine_home_care", "2026-02")).toBe(11); // Feb 1..11
    expect(days(P1, "general_inpatient_care", "2026-02")).toBe(17); // Feb 12..28
    expect(days(P1, "general_inpatient_care", "2026-03")).toBe(19); // Mar 1..19
    // A2's open period runs through asOf (Mar 31 inclusive)
    expect(days(P2, "routine_home_care", "2026-02")).toBe(24);
    expect(days(P2, "routine_home_care", "2026-03")).toBe(31);
    // nobody else's days leak in
    expect(census.days.some((d) => d.patientId === P3 || d.patientId === "x")).toBe(false);
    expect(census.days.some((d) => d.patientId === P_OTHER)).toBe(false);
    // events: two admissions with the level in force, and the death with its setting
    expect(census.events.filter((e) => e.kind === "admission")).toHaveLength(2);
    expect(census.events.find((e) => e.kind === "admission" && e.patientId === P1)).toMatchObject({
      month: "2026-01",
      levelOfCare: "routine_home_care",
    });
    expect(census.events.find((e) => e.kind === "discharge")).toMatchObject({
      patientId: P1,
      month: "2026-03",
      levelOfCare: "general_inpatient_care",
      deathSetting: "home",
    });
  });

  it("M6 census respects the window: a narrower fiscal window clips the days", async () => {
    const census = await serviceCensusForOrg(handle.db, ORG, {
      providerEntityId: PE,
      from: "2026-02-01",
      to: "2026-02-28",
      asOf: AS_OF,
    });
    expect(census.days.every((d) => d.month === "2026-02")).toBe(true);
    expect(census.events.filter((e) => e.kind === "admission")).toHaveLength(1); // only A2's Feb 5 admission
  });

  it("M5 payer programs: rank-1 coverage → medicare / medicaid / other; unknown ids read other", async () => {
    const programs = await payerProgramsForPatientsForOrg(
      handle.db,
      ORG,
      [P1, P2, P3, "00000000-0000-0000-0000-0000000ee999"],
      "2026-03-31",
    );
    expect(Object.fromEntries(programs)).toEqual({
      [P1]: "medicare",
      [P2]: "medicaid",
      [P3]: "other",
      "00000000-0000-0000-0000-0000000ee999": "other",
    });
    // another tenant's patient is invisible: it degrades to "other", never leaks its coverage
    const cross = await payerProgramsForPatientsForOrg(handle.db, OTHER_ORG, [P1], "2026-03-31");
    expect(cross.get(P1)).toBe("other");
  });

  it("M8 completed visits by discipline: drafts, voids, other entity and other year excluded", async () => {
    await expect(
      visitCountsByDisciplineForOrg(handle.db, ORG, { providerEntityId: PE, ...FY }),
    ).resolves.toEqual({
      rn: 3,
      msw: 1,
    });
    await expect(
      visitCountsByDisciplineForOrg(handle.db, OTHER_ORG, { providerEntityId: PE, ...FY }),
    ).resolves.toEqual({});
  });

  it("M16 bereavement census: served contacts, delivered visits, mailed contacts — in the fiscal window", async () => {
    await expect(
      bereavementCensusForOrg(handle.db, ORG, { providerEntityId: PE, ...FY }),
    ).resolves.toEqual({
      contactsCount: 1,
      visitsCount: 2,
      mailedContactsCount: 1,
    });
  });

  it("the assembled seams produce the S-3 breakdown, visits, FTE (from the wage import) and bereavement census", async () => {
    const s = seams();
    const breakdown = await s.serviceMonthlyBreakdown(scope());
    expect(breakdown["2026-01"]?.routine_home_care?.medicare).toMatchObject({
      patientDays: 22,
      uniqueBeneficiaries: 1,
      admissions: 1,
    });
    expect(breakdown["2026-03"]?.general_inpatient_care?.medicare).toMatchObject({
      patientDays: 19,
      discharges: 1,
      deathsBySetting: { home: 1 },
    });
    expect(breakdown["2026-03"]?.routine_home_care?.medicaid).toMatchObject({ patientDays: 31 });
    expect(breakdown["2026-02"]?.routine_home_care?.medicaid).toMatchObject({ admissions: 1 });
    await expect(s.visitCountsByDiscipline(scope())).resolves.toEqual({ rn: 3, msw: 1 });
    // 4,160 RN hours (the two spellings fold into one) over a 365-day year = 2.0 FTE; 1,040 aide hours = 0.5
    await expect(s.fteByDiscipline(scope())).resolves.toEqual({ rn: 2, chha: 0.5 });
    await expect(s.bereavementCensus(scope())).resolves.toMatchObject({
      contactsCount: 1,
      visitsCount: 2,
    });
  });

  it("FTE is empty — never fabricated — when the report has no completed wage import", async () => {
    await expect(
      seams().fteByDiscipline(scope({ costReportId: "00000000-0000-0000-0000-0000000cc999" })),
    ).resolves.toEqual({});
  });

  it("runStatisticsRefresh persists the aggregate-only statistic_data row (create, then update) and emits the event", async () => {
    const catalog = buildBootOutboxCatalog([M27_OUTBOX_EVENTS]);
    const outbox = buildTxOutboxPublisher(catalog);
    const deps = {
      connection: {} as never,
      db: handle.db,
      statisticsSeams: seams(),
      outbox: {
        publish: (tx: unknown, input: Record<string, unknown>) =>
          outbox.publish(
            tx as Parameters<typeof outbox.publish>[0],
            { ...input, callerModule: "m27" } as unknown as Parameters<typeof outbox.publish>[1],
          ),
      },
      capProviderBound: true,
      patientDaysProviderBound: false,
      now: () => AS_OF,
    };
    const run = () =>
      withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        runStatisticsRefresh(tx as never, deps as never, {
          organizationId: ORG,
          costReportId: REPORT,
        }),
      );
    await run();
    await run(); // idempotent: the second pass updates the one row (UNIQUE cost_report_id)

    const rows = (await q("SELECT * FROM statistic_data WHERE cost_report_id=$1", [REPORT])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].visit_counts_by_discipline).toEqual({ rn: 3, msw: 1 });
    expect(rows[0].fte_calculations).toEqual({ rn: 2, chha: 0.5 });
    expect(rows[0].bereavement_census).toMatchObject({ contactsCount: 1, visitsCount: 2 });
    expect(rows[0].monthly_breakdown["2026-01"].routine_home_care.medicare.patientDays).toBe(22);
    // AGGREGATE-ONLY (D18): no patient / admission identifier anywhere in the persisted jsonb
    const persisted = JSON.stringify([
      rows[0].monthly_breakdown,
      rows[0].visit_counts_by_discipline,
      rows[0].fte_calculations,
      rows[0].bereavement_census,
    ]);
    for (const id of [P1, P2, P3, A1, A2]) expect(persisted).not.toContain(id);

    const events = (
      await q(
        "SELECT payload FROM outbox_event WHERE event_type='m27.statistics.refreshed' AND organization_id=$1",
        [ORG],
      )
    ).rows;
    expect(events).toHaveLength(2);
    expect(events[0].payload).toMatchObject({
      costReportId: REPORT,
      monthCount: 3,
      totalVisits: 4,
      fteSourceMissing: false,
    });
  });
});
