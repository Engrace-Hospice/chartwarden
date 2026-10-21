/**
 * M14 IDG read enrichment — the two org-explicit, BATCHED cross-module seam reads, proven against real
 * Postgres as the unprivileged NOBYPASSRLS `wardenx_app` role (never a superuser connection):
 *   • M5 `patientDisplayLabelsForOrg` — "First L." + MRN last-4 for a set of patient ids, ONE query, and a
 *     cross-tenant / unknown id is simply ABSENT (RLS + the explicit organization_id predicate);
 *   • M6 `idgRecertWindowsForOrg` — per-patient recert / face-to-face window over M6's own window math:
 *     current benefit period → next recert due date, F2F required from the 3rd period, window_open inside the
 *     CMS prior-to window, attested closes it, a patient with no live admission is absent, cross-tenant absent.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m14:enrichment:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { patientDisplayLabelsForOrg } from "../src/modules/05-patient/index";
import { idgRecertWindowsForOrg } from "../src/modules/06-admission/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PHYSICIAN = "55555555-5555-5555-5555-555555555555";

describe.skipIf(!DB_URL)("M14 read enrichment seams — LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const ids: Record<string, string> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  const one = async (sql: string, params: unknown[]): Promise<string> =>
    (await admin.query(sql, params)).rows[0].id as string;

  async function patient(org: string, mrn: string, first: string, last: string) {
    return one(
      `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
       VALUES ($1,$2,$3,$4,'1940-01-01','F','active') RETURNING id`,
      [org, mrn, first, last],
    );
  }

  /** An active admission for `patientId`; returns { admission, pe, loc }. */
  async function admissionFor(org: string, patientId: string, n: string) {
    const pe = await one(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
      [org, `CCN-ENR${n}`, `ENR ${n}`, `NPI-ENR${n}`],
    );
    const loc = await one(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
      [pe, `Loc-ENR${n}`],
    );
    const admission = await one(
      `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id,
         admitted_by_physician_id, status, admission_at, activated_at)
       VALUES ($1,$2,$3,$4,$5,'active', now() - interval '200 days', now() - interval '200 days') RETURNING id`,
      [org, pe, loc, patientId, PHYSICIAN],
    );
    return { admission, pe, loc };
  }

  const period = (
    org: string,
    admission: string,
    seq: number,
    kind: string,
    status: string,
    startOffset: number,
    endOffset: number,
  ) =>
    one(
      `INSERT INTO election_period (organization_id, admission_id, sequence_number, period_kind, status,
         effective_at, scheduled_end_at)
       VALUES ($1,$2,$3,$4,$5, current_date + $6::int, current_date + $7::int) RETURNING id`,
      [org, admission, seq, kind, status, startOffset, endOffset],
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'enr@x.test')`, [USER]);

    // Org A: P2 = on period 2 (next = #3 ⇒ F2F required, window open), P3 = on period 3 with the NEXT period's F2F
    // attested, P1 = period 1 (F2F not required), PX = no admission at all.
    ids.p2 = await patient(ORG_A, "MRN-0000-4242", "Ada", "Lovelace");
    ids.p3 = await patient(ORG_A, "MRN-0000-7777", "Bo", "Kim");
    ids.p1 = await patient(ORG_A, "MRN-0000-1111", "Cy", "Young");
    ids.px = await patient(ORG_A, "MRN-0000-9999", "Di", "Xu");
    ids.bPatient = await patient(ORG_B, "MRN-B-0001", "Eve", "Bee");

    const a2 = await admissionFor(ORG_A, ids.p2, "2");
    await period(ORG_A, a2.admission, 1, "ninety_day", "completed", -190, -101);
    await period(ORG_A, a2.admission, 2, "ninety_day", "active", -100, 10); // ends in 10 days
    await period(ORG_A, a2.admission, 3, "sixty_day", "pending", 11, 70);

    const a3 = await admissionFor(ORG_A, ids.p3, "3");
    await period(ORG_A, a3.admission, 3, "sixty_day", "active", -50, 10);
    const next = await period(ORG_A, a3.admission, 4, "sixty_day", "pending", 11, 70);
    await admin.query(
      `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
         performer_role, encounter_date, status)
       VALUES ($1,$2,$3,'hospice_md', current_date - 3, 'attested')`,
      [ORG_A, next, USER],
    );

    const a1 = await admissionFor(ORG_A, ids.p1, "1");
    await period(ORG_A, a1.admission, 1, "ninety_day", "active", -30, 60);

    const b = await admissionFor(ORG_B, ids.bPatient, "B");
    await period(ORG_B, b.admission, 2, "ninety_day", "active", -100, 10);

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("M5: resolves 'First L.' + MRN last-4 in one batched read; unknown and cross-tenant ids are absent", async () => {
    const map = await patientDisplayLabelsForOrg(handle.db, ORG_A, [
      ids.p2,
      ids.p3,
      ids.bPatient, // another tenant's patient — must NOT resolve for org A
      "99999999-9999-4999-8999-999999999999", // unknown
    ]);
    expect(map.get(ids.p2)).toEqual({
      patientId: ids.p2,
      displayName: "Ada L.",
      mrnSuffix: "4242",
    });
    expect(map.get(ids.p3)?.displayName).toBe("Bo K.");
    expect(map.has(ids.bPatient)).toBe(false);
    expect(map.size).toBe(2);
    // minimum necessary: nothing else crosses
    expect(JSON.stringify([...map.values()])).not.toMatch(/Lovelace|1940|MRN-0000/);
    expect((await patientDisplayLabelsForOrg(handle.db, ORG_B, [ids.bPatient])).size).toBe(1);
    expect((await patientDisplayLabelsForOrg(handle.db, ORG_A, [])).size).toBe(0);
  });

  it("M6: period 2 active → next recert due in 11 days, F2F required + window_open (CMS window through the first day)", async () => {
    const map = await idgRecertWindowsForOrg(handle.db, ORG_A, [
      ids.p2,
      ids.p3,
      ids.p1,
      ids.px,
      ids.bPatient,
    ]);
    const w = map.get(ids.p2);
    expect(w).toBeDefined();
    const expectedNext = (
      await admin.query("SELECT (current_date + 11)::text AS d, (current_date + 10)::text AS e")
    ).rows[0];
    expect(w).toMatchObject({
      currentPeriodSequence: 2,
      benefitPeriodEnd: expectedNext.e,
      nextRecertDueDate: expectedNext.d,
      nextPeriodSequence: 3,
      f2fRequired: true,
      // the window runs through the next period's FIRST day (MBPM ch. 9 §20.1(5)(a))
      f2fWindowEnd: expectedNext.d,
      f2fStatus: "window_open",
      f2fWindowState: "window_open",
    });
    expect(Math.abs((w?.daysUntilNextRecert ?? 99) - 11)).toBeLessThanOrEqual(1); // org-TZ vs UTC "today"
  });

  it("M6: an attested F2F for the next period closes the window; period 1 → F2F not required", async () => {
    const map = await idgRecertWindowsForOrg(handle.db, ORG_A, [ids.p3, ids.p1]);
    expect(map.get(ids.p3)).toMatchObject({
      currentPeriodSequence: 3,
      nextPeriodSequence: 4,
      f2fStatus: "attested",
      f2fWindowState: "not_due",
    });
    expect(map.get(ids.p1)).toMatchObject({
      currentPeriodSequence: 1,
      f2fRequired: false,
      f2fStatus: "not_required",
      f2fWindowState: "not_due",
    });
  });

  it("M6: a patient with no live admission and a cross-tenant patient are ABSENT (RLS, wardenx_app)", async () => {
    const map = await idgRecertWindowsForOrg(handle.db, ORG_A, [ids.px, ids.bPatient]);
    expect(map.size).toBe(0);
    const b = await idgRecertWindowsForOrg(handle.db, ORG_B, [ids.bPatient, ids.p2]);
    expect([...b.keys()]).toEqual([ids.bPatient]);
  });
});
