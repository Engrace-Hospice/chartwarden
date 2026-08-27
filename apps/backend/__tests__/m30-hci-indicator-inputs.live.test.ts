/**
 * F-042 — the HCI indicator inputs, end to end over real Postgres.
 *
 * The issue is "hci_composite cannot compute: six indicators have no measure-input binding". Two things
 * had to be proven before any of it could be fixed, and both are asserted here rather than argued:
 *
 *  1. `election_period.effective_at` / `scheduled_end_at` / `actual_end_at` were READ in seven places and
 *     WRITTEN in none. The `setActive` transition returns a `set_timestamp effective_at` effect, but the
 *     write path stamps `status` directly and never ran it. So M6's own `ElectionPeriodReader` (which
 *     filters `isNotNull(effective_at)`) answered [] for every admission on the platform, and HCI
 *     indicator 1 — which the issue lists as BOUND AND COMPUTING — selected its denominator by
 *     `effective_at BETWEEN …` and was therefore permanently 0/0. Bound is not computing.
 *  2. Indicators 2, 8 and 9 need M6 day/election SPANS intersected with M8 per-day skilled-nursing
 *     totals. Neither read existed; both are added here and exercised against the real tables.
 *
 * Everything the production code touches is driven as the NOBYPASSRLS `wardenx_app` role. The admission
 * is ACTIVATED through the real M6 write service (referral → accept → NOR → election → CTI ×2 → activate),
 * not seeded, because the whole point of (1) is what that path does or does not write.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m30:hci-inputs:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import {
  HCI_SKILLED_NURSING_MINUTES_PER_DAY_FLOOR,
  computeHciIndicator02,
  computeHciIndicator08,
  computeHciIndicator09,
} from "@wardenx/quality";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { createLevelOfCarePeriodReader } from "../src/modules/06-admission/seams/level-of-care-period-reader";
import { createDrizzleEncounterReaderStore } from "../src/modules/08-encounters/seams/drizzle-store";
import { createSignedEncountersReader } from "../src/modules/08-encounters/seams/readers";
import {
  resolveHciIndicator01Input,
  resolveHciIndicator02Input,
  resolveHciSkilledNursingDayInput,
} from "../src/modules/30-quality/jobs/m30-jobs";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-1111111111f2";
const USER = "33333333-3333-3333-3333-3333333333f2";
const MD = "55555555-5555-5555-5555-5555555555f2";
const ATTENDING = "77777777-7777-7777-7777-777777777f72";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-888888888f82";

/** The reporting window every assertion below is scoped to (a January, so weekends are countable). */
const PERIOD = { start: "2026-01-01", end: "2026-02-01" } as const;

const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

const REQUEST = (code: string) => ({
  registration: { code } as never,
  organizationId: ORG_A,
  providerEntityId: PROVIDER_ENTITY,
  periodStart: PERIOD.start,
  periodEnd: PERIOD.end,
});

describe.skipIf(!DB_URL)("F-042 — HCI indicator inputs, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let seams: {
    levelOfCarePeriodReader: ReturnType<typeof createLevelOfCarePeriodReader>;
    encounters: ReturnType<typeof createSignedEncountersReader>;
  };
  let membershipId = "";
  /** The admission activated through the real write path — the subject of every assertion. */
  let activated = { admissionId: "", periodId: "" };

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS report_mv CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, "report_writer"])
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  /** Referral → triage → accept: a period-1 admission ready for the election/CTI ceremony. */
  async function admit(): Promise<{ admissionId: string; periodId: string; patientId: string }> {
    const patientId = randomUUID();
    const ref = await svc.createReferral(
      ORG_A,
      {
        source: "phone",
        receivedAt: new Date().toISOString(),
        receivingUserId: USER,
        patientNameAtReceipt: "P",
      },
      USER,
    );
    await svc.triageReferral(ORG_A, ref.id, "eligible", 0);
    const { admissionId } = await svc.acceptReferral(
      ORG_A,
      ref.id,
      { primaryDiagnosisIcd10: "C34.90", patientId },
      1,
      USER,
    );
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    return { admissionId, periodId: periods?.[0]?.id as string, patientId };
  }

  /** The FULL §418 activation ceremony, through production writes only. */
  async function activate(): Promise<{ admissionId: string; periodId: string; patientId: string }> {
    const a = await admit();
    const nor = await svc.acknowledgeNor(
      ORG_A,
      a.admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: a.periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    await svc.signCtiAttending(ORG_A, cti.id, cti.version + 1, ATTENDING);
    const active = await svc.activateAdmission(ORG_A, a.admissionId, nor.version);
    expect(active.state).toBe("active");
    return a;
  }

  /** A closed level-of-care span on an admission (`to` EXCLUSIVE, matching the reader's convention). */
  async function seedLoc(admissionId: string, level: string, from: string, to: string | null) {
    await admin.query(
      `INSERT INTO level_of_care_period (organization_id, admission_id, level_of_care, effective_at, ended_at, status)
       VALUES ($1,$2,$3,$4::date,$5::date,$6)`,
      [ORG_A, admissionId, level, from, to, to === null ? "active" : "ended"],
    );
  }

  /** A SIGNED encounter with a real start/end bracket, so it contributes both a visit and minutes. */
  async function seedEncounter(
    admissionId: string,
    patientId: string,
    day: string,
    discipline: string,
    minutes: number,
  ) {
    await admin.query(
      `INSERT INTO encounter (organization_id, patient_id, admission_id, authored_by_membership_id,
                              encounter_type, discipline, service_date, started_at, ended_at,
                              status, signed_at, vocab_version_id)
       VALUES ($1,$2,$3,$4,'routine_visit',$5,$6::date,
               ($6 || ' 09:00:00+00')::timestamptz,
               ($6 || ' 09:00:00+00')::timestamptz + ($7 || ' minutes')::interval,
               'signed', now(), gen_random_uuid())`,
      [ORG_A, patientId, admissionId, membershipId, discipline, day, String(minutes)],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-f042','A','A')",
      [ORG_A],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f042@x.test')`, [USER]);
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    svc = createDbAdmissionRouteService(handle.db, undefined, undefined, {
      async belongsToOrg(organizationId, providerEntityId) {
        const { rows } = await admin.query(
          "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
          [providerEntityId, organizationId],
        );
        return rows.length > 0;
      },
    });
    seams = {
      levelOfCarePeriodReader: createLevelOfCarePeriodReader(handle.db),
      encounters: createSignedEncountersReader(createDrizzleEncounterReaderStore(handle.db)),
    };
    activated = await activate();
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("the election-period window the write path never wrote", () => {
    it("stamps effective_at and scheduled_end_at when a period goes active", async () => {
      const { rows } = await admin.query(
        "SELECT effective_at, scheduled_end_at, actual_end_at, period_kind, status FROM election_period WHERE id=$1",
        [activated.periodId],
      );
      expect(rows[0].status).toBe("active");
      // Both columns were NULL on every row ever written before this change.
      expect(rows[0].effective_at).not.toBeNull();
      expect(rows[0].scheduled_end_at).not.toBeNull();
      expect(rows[0].actual_end_at).toBeNull(); // still running
      expect(rows[0].period_kind).toBe("ninety_day");
    });

    it("gives period 1 the 90 days 42 CFR 418.21(a) does, inclusive of the last day", async () => {
      const { rows } = await admin.query(
        "SELECT (scheduled_end_at - effective_at) AS span FROM election_period WHERE id=$1",
        [activated.periodId],
      );
      // 89 days BETWEEN the endpoints = 90 covered days, because the end is the last covered day.
      expect(Number(rows[0].span)).toBe(89);
    });

    it("anchors a TRANSFER-IN's inherited period on the sending hospice's start date", async () => {
      // The inherited period is inserted straight into `active` (the sending hospice's certification
      // carries it), so it never passes the `setActive` update. `priorElectionStartDate` is the input
      // documented as its anchor, and the Drizzle path discarded it.
      const a = await admit();
      await svc.transferIn(
        ORG_A,
        a.admissionId,
        {
          priorBenefitPeriodSequence: 3,
          priorElectionStartDate: "2026-01-05",
          hospiceMedicalDirectorId: MD,
          effectiveDate: "2026-01-20",
          otherHospiceName: "Sending Hospice",
          narrative: "transferred in mid-period",
        },
        USER,
      );
      const { rows } = await admin.query(
        `SELECT sequence_number, period_kind, status, effective_at, scheduled_end_at
           FROM election_period WHERE admission_id=$1 AND sequence_number=3`,
        [a.admissionId],
      );
      expect(rows[0].status).toBe("active");
      expect(rows[0].effective_at.toISOString().slice(0, 10)).toBe("2026-01-05");
      // Sequence 3 is a SIXTY-day period, not ninety — every insert site used to hard-code `ninety_day`.
      expect(rows[0].period_kind).toBe("sixty_day");
      expect(rows[0].scheduled_end_at.toISOString().slice(0, 10)).toBe("2026-03-05");
    });

    it("stamps actual_end_at when a discharge completes the period", async () => {
      const a = await activate();
      const res = await svc.discharge(
        ORG_A,
        a.admissionId,
        {
          reason: "moved_out_of_service_area",
          dischargeDate: "2026-01-20",
          narrative: "relocated out of the service area",
        },
        USER,
      );
      expect(res.state).toBe("completed");
      const { rows } = await admin.query(
        "SELECT status, actual_end_at FROM election_period WHERE id=$1",
        [a.periodId],
      );
      expect(rows[0].status).toBe("completed");
      expect(rows[0].actual_end_at).not.toBeNull();
    });
  });

  describe("HCI indicator 1 — bound the whole time, and permanently 0/0 until now", () => {
    it("finds the activated election period in its denominator", async () => {
      // The reader filters `effective_at >= from AND effective_at < to`. With the column NULL, that
      // predicate is NULL for every row and the denominator was zero for every org, forever — an
      // `insufficient_n` band indistinguishable from a hospice with no patients.
      const today = new Date().toISOString().slice(0, 10);
      const from = `${today.slice(0, 4)}-01-01`;
      const to = `${Number(today.slice(0, 4)) + 1}-01-01`;
      const counts = await seams.levelOfCarePeriodReader.chcOrGipCoverageCounts(ORG_A, {
        from,
        to,
      });
      expect(counts.denominator).toBeGreaterThan(0);
    });

    it("counts a period with a GIP day toward the numerator", async () => {
      const a = await activate();
      const { rows } = await admin.query("SELECT effective_at FROM election_period WHERE id=$1", [
        a.periodId,
      ]);
      const start = rows[0].effective_at.toISOString().slice(0, 10);
      await seedLoc(a.admissionId, "general_inpatient_care", start, null);
      const year = start.slice(0, 4);
      const before = await seams.levelOfCarePeriodReader.chcOrGipCoverageCounts(ORG_A, {
        from: `${year}-01-01`,
        to: `${Number(year) + 1}-01-01`,
      });
      expect(before.numerator).toBeGreaterThan(0);
      const input = await resolveHciIndicator01Input(
        {
          ...REQUEST("hci_indicator_01"),
          periodStart: `${year}-01-01`,
          periodEnd: `${Number(year) + 1}-01-01`,
        },
        seams,
      );
      expect((input as { totalElectionPeriods: number }).totalElectionPeriods).toBeGreaterThan(0);
    });
  });

  describe("the two new M6 span reads", () => {
    it("clips level-of-care spans to the requested window", async () => {
      const a = await activate();
      // Straddles both window edges: 2025-12-20 → 2026-02-10, clipped to the whole of January.
      await seedLoc(a.admissionId, "routine_home_care", "2025-12-20", "2026-02-10");
      const spans = await seams.levelOfCarePeriodReader.levelOfCareDaySpans(ORG_A, {
        from: PERIOD.start,
        to: PERIOD.end,
      });
      const mine = spans.filter((s) => s.admissionId === a.admissionId);
      expect(mine).toEqual([
        {
          admissionId: a.admissionId,
          levelOfCare: "routine_home_care",
          from: "2026-01-01",
          to: "2026-02-01",
        },
      ]);
    });

    it("treats an OPEN level-of-care span as running to the window end", async () => {
      const a = await activate();
      await seedLoc(a.admissionId, "routine_home_care", "2026-01-10", null);
      const spans = await seams.levelOfCarePeriodReader.levelOfCareDaySpans(ORG_A, {
        from: PERIOD.start,
        to: PERIOD.end,
      });
      expect(spans.find((s) => s.admissionId === a.admissionId)).toMatchObject({
        from: "2026-01-10",
        to: "2026-02-01",
      });
    });

    it("does not double-count the changeover day across two levels of care", async () => {
      const a = await activate();
      await seedLoc(a.admissionId, "routine_home_care", "2026-01-01", "2026-01-11");
      await seedLoc(a.admissionId, "general_inpatient_care", "2026-01-11", "2026-01-21");
      const spans = (
        await seams.levelOfCarePeriodReader.levelOfCareDaySpans(ORG_A, {
          from: PERIOD.start,
          to: PERIOD.end,
        })
      ).filter((s) => s.admissionId === a.admissionId);
      const days = spans.reduce(
        (n, s) =>
          n + (Date.parse(`${s.to}T00:00:00Z`) - Date.parse(`${s.from}T00:00:00Z`)) / 86_400_000,
        0,
      );
      expect(days).toBe(20); // 10 + 10, not 11 + 11
    });

    it("returns the activated election period as a clipped span", async () => {
      const spans = await seams.levelOfCarePeriodReader.electionPeriodSpans(ORG_A, {
        from: "2020-01-01",
        to: "2099-01-01",
      });
      const mine = spans.find((s) => s.electionPeriodId === activated.periodId);
      expect(mine).toBeDefined();
      expect(mine?.admissionId).toBe(activated.admissionId);
      // 90 covered days ⇒ a half-open span 90 days wide.
      const width =
        (Date.parse(`${mine?.to}T00:00:00Z`) - Date.parse(`${mine?.from}T00:00:00Z`)) / 86_400_000;
      expect(width).toBe(90);
    });

    it("returns NOTHING for an election period with no effective date — the pre-fix state", async () => {
      // A period seeded but never activated still has NULL dates, and must be absent rather than
      // defaulting to the window (which would give every un-started election a full-window gap).
      const pending = await admit();
      const spans = await seams.levelOfCarePeriodReader.electionPeriodSpans(ORG_A, {
        from: "2020-01-01",
        to: "2099-01-01",
      });
      expect(spans.find((s) => s.electionPeriodId === pending.periodId)).toBeUndefined();
    });
  });

  describe("the new M8 per-day skilled-nursing read", () => {
    it("groups signed rn/lpn encounters by (admission, service date) with summed minutes", async () => {
      const a = await activate();
      await seedEncounter(a.admissionId, a.patientId, "2026-01-05", "rn", 40);
      await seedEncounter(a.admissionId, a.patientId, "2026-01-05", "lpn", 20);
      const totals = await seams.encounters.skilledNursingDayTotalsForOrg(ORG_A, {
        from: PERIOD.start,
        to: PERIOD.end,
      });
      expect(totals.find((t) => t.admissionId === a.admissionId)).toEqual({
        admissionId: a.admissionId,
        serviceDate: "2026-01-05",
        visits: 2,
        minutes: 60,
      });
    });

    it("excludes non-nursing disciplines and unsigned encounters", async () => {
      const a = await activate();
      await seedEncounter(a.admissionId, a.patientId, "2026-01-06", "msw", 60);
      await admin.query(
        `INSERT INTO encounter (organization_id, patient_id, admission_id, authored_by_membership_id,
                                encounter_type, discipline, service_date, status)
         VALUES ($1,$2,$3,$4,'routine_visit','rn','2026-01-06','draft')`,
        [ORG_A, a.patientId, a.admissionId, membershipId],
      );
      const totals = await seams.encounters.skilledNursingDayTotalsForOrg(ORG_A, {
        from: PERIOD.start,
        to: PERIOD.end,
      });
      expect(totals.find((t) => t.admissionId === a.admissionId)).toBeUndefined();
    });

    it("counts a visit with no start/end bracket as a visit worth zero minutes", async () => {
      const a = await activate();
      await admin.query(
        `INSERT INTO encounter (organization_id, patient_id, admission_id, authored_by_membership_id,
                                encounter_type, discipline, service_date, status, signed_at, vocab_version_id)
         VALUES ($1,$2,$3,$4,'routine_visit','rn','2026-01-07','signed',now(),gen_random_uuid())`,
        [ORG_A, a.patientId, a.admissionId, membershipId],
      );
      const totals = await seams.encounters.skilledNursingDayTotalsForOrg(ORG_A, {
        from: PERIOD.start,
        to: PERIOD.end,
      });
      expect(totals.find((t) => t.admissionId === a.admissionId)).toMatchObject({
        visits: 1,
        minutes: 0,
      });
    });
  });

  describe("the three indicators, computed end to end over the real readers", () => {
    it("indicator 8 — RHC days meeting the SN-minutes floor", async () => {
      const a = await activate();
      // Ten routine-home-care days; two of them carry a qualifying nursing visit.
      await seedLoc(a.admissionId, "routine_home_care", "2026-01-01", "2026-01-11");
      await seedEncounter(a.admissionId, a.patientId, "2026-01-02", "rn", 45);
      await seedEncounter(a.admissionId, a.patientId, "2026-01-05", "rn", 30);
      // Under the floor — a visit, but not a qualifying day for this indicator.
      await seedEncounter(
        a.admissionId,
        a.patientId,
        "2026-01-08",
        "rn",
        HCI_SKILLED_NURSING_MINUTES_PER_DAY_FLOOR - 5,
      );

      const input = (await resolveHciSkilledNursingDayInput(
        REQUEST("hci_indicator_08"),
        seams,
      )) as { totalRhcDays: number; rhcDaysMeetingSnMinuteFloor: number };
      // Other tests in this suite seed their own spans into the same org, so assert this admission's
      // contribution through the deltas rather than the org totals.
      expect(input.totalRhcDays).toBeGreaterThanOrEqual(10);
      expect(input.rhcDaysMeetingSnMinuteFloor).toBeGreaterThanOrEqual(2);
      const result = computeHciIndicator08(input as never);
      expect(result.rate).not.toBeNull();
      expect(result.denominator).toBe(input.totalRhcDays);
    });

    it("indicator 9 — weekend care days meeting the floor", async () => {
      const a = await activate();
      // 2026-01-03 and 2026-01-04 are the Saturday/Sunday inside this span.
      await seedLoc(a.admissionId, "routine_home_care", "2026-01-02", "2026-01-06");
      await seedEncounter(a.admissionId, a.patientId, "2026-01-03", "rn", 60);

      const input = (await resolveHciSkilledNursingDayInput(
        REQUEST("hci_indicator_09"),
        seams,
      )) as { totalWeekendCareDays: number; weekendDaysMeetingSnMinuteFloor: number };
      expect(input.totalWeekendCareDays).toBeGreaterThanOrEqual(2);
      expect(input.weekendDaysMeetingSnMinuteFloor).toBeGreaterThanOrEqual(1);
      expect(computeHciIndicator09(input as never).rate).not.toBeNull();
    });

    it("indicator 2 — an election with no skilled-nursing visit reads as a gap", async () => {
      const input = (await resolveHciIndicator02Input(
        {
          ...REQUEST("hci_indicator_02"),
          periodStart: "2020-01-01",
          periodEnd: "2099-01-01",
        },
        seams,
      )) as { totalElectionPeriods: number; periodsWithSkilledNursingGap: number };

      // Every activated period in this suite is 90 days long; most were never visited at all.
      expect(input.totalElectionPeriods).toBeGreaterThan(0);
      expect(input.periodsWithSkilledNursingGap).toBeGreaterThan(0);
      const result = computeHciIndicator02(input as never);
      expect(result.denominator).toBe(input.totalElectionPeriods);
      expect(result.rate).not.toBeNull();
    });

    it("indicator 2 SUPPRESSES when there are no election periods in the window at all", async () => {
      const input = (await resolveHciIndicator02Input(
        {
          ...REQUEST("hci_indicator_02"),
          periodStart: "1990-01-01",
          periodEnd: "1991-01-01",
        },
        seams,
      )) as { totalElectionPeriods: number };
      expect(input.totalElectionPeriods).toBe(0);
      const result = computeHciIndicator02(input as never);
      expect(result.rate).toBeNull();
      expect(result.bandColor).toBe("insufficient_n");
    });
  });
});
