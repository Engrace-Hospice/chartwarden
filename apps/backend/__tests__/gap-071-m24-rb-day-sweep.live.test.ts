/**
 * GAP-071 — the M24 `rb-day-daily-sweep` store, LIVE Postgres. No production code inserted rb_day rows, so
 * Medicaid room-and-board could never be billed. This drives the production
 * `buildDrizzleRbDaySweepStore` over the REAL M6 org-explicit LOC reader as the NOBYPASSRLS `chartwarden_app`
 * role: an ACTIVE arrangement + a patient's LOC periods + one sweep produce the rb_day rows; a second sweep
 * is a no-op; a voided day is never regenerated; another tenant's arrangement is untouched. The sweep
 * publishes no outbox event (§2.2: rb_day writes are internal), so no publisher is involved.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m24:rb-day-sweep:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { levelOfCarePeriodsForPatientForOrg } from "../src/modules/06-admission/seams/loc-periods-for-patient";
import {
  buildDrizzleEligibilityWatchdogStore,
  buildDrizzleRbDaySweepStore,
} from "../src/modules/24-billing-medicaid/jobs/rb-day-sweep";
import { buildM24RbDayConsumers } from "../src/modules/24-billing-medicaid/outbox-consumers/m24-rb-day-consumers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT_A = "44444444-4444-4444-4444-444444444444";
const PATIENT_B = "55555555-5555-5555-5555-555555555555";
const NF = "66666666-6666-6666-6666-666666666666";

describe.skipIf(!DB_URL)("M24 rb-day-daily-sweep store — LIVE Postgres (GAP-071)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const peByOrg = new Map<string, string>();
  let arrangementA: string;
  let arrangementB: string;

  async function seedArrangement(orgId: string, patientId: string, from: string): Promise<string> {
    const r = await admin.query(
      `INSERT INTO rb_arrangement (organization_id, patient_id, provider_entity_id, nf_facility_mdm_id,
         nf_facility_name_snapshot, effective_from, nf_per_diem_routine_cents, nf_per_diem_resp_cents,
         nf_per_diem_gip_cents, pass_through_pct, retention_pct, state,
         created_by_membership_id, updated_by_membership_id)
       VALUES ($1,$2,$3,$4,'NF',$5,20000,25000,80000,95,5,'ACTIVE',$6,$6) RETURNING id`,
      [orgId, patientId, peByOrg.get(orgId), NF, from, USER],
    );
    return r.rows[0].id;
  }
  async function seedAdmissionWithLoc(
    orgId: string,
    patientId: string,
    periods: ReadonlyArray<[string, string, string | null]>,
  ): Promise<void> {
    const adm = await admin.query(
      "INSERT INTO admission (organization_id, patient_id) VALUES ($1,$2) RETURNING id",
      [orgId, patientId],
    );
    for (const [loc, from, to] of periods) {
      await admin.query(
        `INSERT INTO level_of_care_period (organization_id, admission_id, level_of_care, status, effective_at, ended_at)
         VALUES ($1,$2,$3,'active',$4,$5)`,
        [orgId, adm.rows[0].id, loc, from, to],
      );
    }
  }
  const sweepStore = () =>
    buildDrizzleRbDaySweepStore({
      db: handle.db,
      locPeriods: {
        periodsForPatient: (organizationId, patientId, range) =>
          levelOfCarePeriodsForPatientForOrg(handle.db, organizationId, patientId, range),
      },
    });
  const dayRows = async (orgId: string, patientId: string) =>
    (
      await admin.query(
        `SELECT to_char(service_date AT TIME ZONE 'UTC','YYYY-MM-DD') AS d, loc_of_day, status,
                per_diem_cents_snapshot AS cents, exclusion_reason AS reason, rb_arrangement_id AS arr
           FROM rb_day WHERE organization_id=$1 AND patient_id=$2 ORDER BY service_date`,
        [orgId, patientId],
      )
    ).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'gap071@x.test')`, [USER]);
    for (const [orgId, slug, ccn, npi] of [
      [ORG_A, "org-a", "111111", "1234567890"],
      [ORG_B, "org-b", "222222", "1234567891"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, slug],
      );
      const pe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'PE',$3,'enc','0930') RETURNING id`,
        [orgId, ccn, npi],
      );
      peByOrg.set(orgId, pe.rows[0].id);
    }
    // Org A: RHC 05-01..05-03, GIP 05-03..05-05, RHC from 05-05 (open). Arrangement from 05-01.
    await seedAdmissionWithLoc(ORG_A, PATIENT_A, [
      ["routine_home_care", "2026-05-01T08:00:00Z", "2026-05-03T08:00:00Z"],
      ["general_inpatient_care", "2026-05-03T08:00:00Z", "2026-05-05T08:00:00Z"],
      ["routine_home_care", "2026-05-05T08:00:00Z", null],
    ]);
    arrangementA = await seedArrangement(ORG_A, PATIENT_A, "2026-05-01");
    await seedAdmissionWithLoc(ORG_B, PATIENT_B, [
      ["routine_home_care", "2026-05-01T08:00:00Z", null],
    ]);
    arrangementB = await seedArrangement(ORG_B, PATIENT_B, "2026-05-01");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("one sweep tick over an ACTIVE arrangement creates the rb_day rows (billable vs GIP-excluded)", async () => {
    const swept = await sweepStore().sweepPendingDays(ORG_A, "2026-05-06");
    expect(swept).toBe(6);
    const rows = await dayRows(ORG_A, PATIENT_A);
    expect(rows.map((r) => [r.d, r.loc_of_day, r.status])).toEqual([
      ["2026-05-01", "RHC", "billable"],
      ["2026-05-02", "RHC", "billable"],
      ["2026-05-03", "GIP", "excluded"],
      ["2026-05-04", "GIP", "excluded"],
      ["2026-05-05", "RHC", "billable"],
      ["2026-05-06", "RHC", "billable"],
    ]);
    expect(rows[0]).toMatchObject({ cents: 20000, arr: arrangementA });
    expect(rows[2]?.reason).toMatch(/general inpatient/);
  });

  it("is idempotent: a second tick inserts nothing, and a later tick adds only the new day", async () => {
    expect(await sweepStore().sweepPendingDays(ORG_A, "2026-05-06")).toBe(0);
    expect(await sweepStore().sweepPendingDays(ORG_A, "2026-05-07")).toBe(1);
    expect(await dayRows(ORG_A, PATIENT_A)).toHaveLength(7);
  });

  it("never regenerates a voided day", async () => {
    await admin.query(
      "UPDATE rb_day SET status='voided' WHERE organization_id=$1 AND patient_id=$2 AND service_date='2026-05-02'",
      [ORG_A, PATIENT_A],
    );
    expect(await sweepStore().sweepPendingDays(ORG_A, "2026-05-07")).toBe(0);
    const voided = (await dayRows(ORG_A, PATIENT_A)).filter((r) => r.d === "2026-05-02");
    expect(voided).toHaveLength(1);
    expect(voided[0]?.status).toBe("voided");
  });

  it("is tenant-scoped: sweeping org A leaves org B untouched; sweeping org B writes only org B", async () => {
    expect(await dayRows(ORG_B, PATIENT_B)).toHaveLength(0);
    expect(await sweepStore().sweepPendingDays(ORG_B, "2026-05-02")).toBe(2);
    const rows = await dayRows(ORG_B, PATIENT_B);
    expect(rows.every((r) => r.arr === arrangementB)).toBe(true);
    expect(await dayRows(ORG_A, PATIENT_A)).toHaveLength(7);
  });

  it("does not sweep a non-ACTIVE arrangement", async () => {
    await admin.query("UPDATE rb_arrangement SET state='TERMINATED' WHERE id=$1", [arrangementB]);
    expect(await sweepStore().sweepPendingDays(ORG_B, "2026-05-20")).toBe(0);
  });

  it("eligibility watchdog returns patients whose latest check is past stale_at (RLS-scoped)", async () => {
    await admin.query(
      `INSERT INTO medicaid_eligibility_check (organization_id, patient_id, patient_payer_id, service_state,
         as_of_service_date, outcome, checked_at, stale_at)
       VALUES ($1,$2,gen_random_uuid(),'OR','2026-04-01','active','2026-04-01','2026-05-01')`,
      [ORG_A, PATIENT_A],
    );
    const store = buildDrizzleEligibilityWatchdogStore(handle.db);
    const found = await store.staleEligibilityFindings(ORG_A, "2026-06-01");
    expect(found).toEqual([
      { patientId: PATIENT_A, lastCheckedAt: "2026-04-01T00:00:00.000Z", providerEntityId: null },
    ]);
    expect(await store.staleEligibilityCount(ORG_A, "2026-06-01")).toBe(1);
    expect(await store.staleEligibilityFindings(ORG_B, "2026-06-01")).toEqual([]);
  });

  describe("lifecycle consumers (m6.loc.changed re-evaluation, discharge/death void)", () => {
    const ADMISSION_OF = new Map<string, string>();
    const consumers = () =>
      buildM24RbDayConsumers({
        db: handle.db,
        locPeriods: {
          periodsForPatient: (organizationId, patientId, range) =>
            levelOfCarePeriodsForPatientForOrg(handle.db, organizationId, patientId, range),
        },
        admissions: { patientIdForAdmission: async (_o, a) => ADMISSION_OF.get(a) ?? null },
      });
    const handler = (eventType: string) => {
      const c = consumers().find((x) => x.eventTypes.includes(eventType));
      if (!c) throw new Error(`no consumer for ${eventType}`);
      return (organizationId: string, payload: Record<string, unknown>) =>
        c.handle({
          id: "00000000-0000-4000-8000-000000000001",
          organizationId,
          eventType,
          aggregateKind: "x",
          aggregateId: "00000000-0000-4000-8000-000000000002",
          payload,
          attemptCount: 0,
          createdAt: new Date(),
        });
    };

    it("m6.loc.changed flips a corrected day (GIP -> RHC) but leaves a manual override alone", async () => {
      ADMISSION_OF.set("adm-a", PATIENT_A);
      // Retroactive correction: the GIP period becomes routine home care.
      await admin.query(
        `UPDATE level_of_care_period SET level_of_care='routine_home_care'
          WHERE organization_id=$1 AND level_of_care='general_inpatient_care'`,
        [ORG_A],
      );
      await admin.query(
        "UPDATE rb_day SET status='excluded', exclusion_reason='manual: contract dispute' WHERE organization_id=$1 AND service_date='2026-05-04'",
        [ORG_A],
      );
      await handler("m6.loc.changed")(ORG_A, {
        admissionId: "adm-a",
        effectiveStart: "2026-05-03T08:00:00Z",
        levelOfCarePeriodId: "x",
        newLevel: "routine_home_care",
      });
      const rows = await dayRows(ORG_A, PATIENT_A);
      const by = (d: string) => rows.find((r) => r.d === d);
      expect(by("2026-05-03")).toMatchObject({ status: "billable", loc_of_day: "RHC" });
      expect(by("2026-05-04")).toMatchObject({
        status: "excluded",
        reason: "manual: contract dispute",
      });
      expect(by("2026-05-02")?.status).toBe("voided"); // earlier than effectiveStart, untouched
    });

    it("m5.patient.deceased voids later open days (day of death kept); redelivery is a no-op; never regenerated", async () => {
      await handler("m5.patient.deceased")(ORG_A, {
        patientId: PATIENT_A,
        deceasedDate: "2026-05-05",
      });
      await handler("m5.patient.deceased")(ORG_A, {
        patientId: PATIENT_A,
        deceasedDate: "2026-05-05",
      });
      const rows = await dayRows(ORG_A, PATIENT_A);
      expect(rows.find((r) => r.d === "2026-05-05")?.status).toBe("billable");
      expect(rows.find((r) => r.d === "2026-05-06")?.status).toBe("voided");
      expect(rows.find((r) => r.d === "2026-05-07")?.status).toBe("voided");
      expect(await sweepStore().sweepPendingDays(ORG_A, "2026-05-07")).toBe(0);
    });

    it("m6.admission.discharged voids open days from the discharge date; tenant comes from the envelope", async () => {
      // Another tenant's envelope must not touch org A's rows even with org A's patient id.
      await handler("m6.admission.discharged")(ORG_B, {
        admissionId: "adm-a",
        dischargeDate: "2026-05-01",
      });
      expect((await dayRows(ORG_A, PATIENT_A)).find((r) => r.d === "2026-05-05")?.status).toBe(
        "billable",
      );
      await handler("m6.admission.discharged")(ORG_A, {
        admissionId: "adm-a",
        dischargeDate: "2026-05-05",
      });
      expect((await dayRows(ORG_A, PATIENT_A)).find((r) => r.d === "2026-05-05")?.status).toBe(
        "voided",
      );
    });
  });
});
