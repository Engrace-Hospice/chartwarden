import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  HopeInvalidAnswerValueError,
  HopeProtectedItemWriteError,
  createHopeAssessmentAnswerService,
} from "../src/modules/10-hope/hope-answer-service";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { answerHopeForSign } from "./_hope-sign-ready";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { seedM5Patient } from "./_m6-admit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "12121212-1212-1212-1212-121212121212";
const USER = "23232323-2323-2323-2323-232323232323";
const PATIENT = "34343434-3434-3434-3434-343434343434";
/** The drafts' target date, used for every date answer `answerForSign` fills. */
const ANSWER_DATE = "2025-10-15";
/** An RFA-04 SFV payload whose J2053 re-rating completes the regulatory SFV branch on the admission. */
const SFV_DATA = {
  J: {
    J2053: Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((suffix) => [`J2053${suffix}`, "1"]),
    ),
  },
};

describe.skipIf(!DB_URL)("M10 HOPE Phase 2B canonical answer engine — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbHopeBackend>;
  let answers: ReturnType<typeof createHopeAssessmentAnswerService>;
  let membershipId: string;
  let providerEntityId: string;
  let locationId: string;
  let seq = 0;

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
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- vector stripped");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- hnsw stripped");
      }
      await admin.query(sql);
    }
  }

  function nextAdmission(): string {
    seq += 1;
    return `54545454-5454-4454-8454-${seq.toString().padStart(12, "0")}`;
  }

  async function seedSchedule(admissionId: string, rfaKind = "01_admission") {
    await admin.query(
      `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'2025-10-01','2025-12-31','2026-01-15','{}'::jsonb,'manual_admin')`,
      [ORG, providerEntityId, locationId, PATIENT, admissionId, rfaKind],
    );
  }

  async function draft() {
    const admissionId = nextAdmission();
    await seedSchedule(admissionId);
    return svc.recordTimepoint(ORG, membershipId, admissionId, {
      rfaKind: "01_admission",
      targetDate: "2025-10-15T00:00:00.000Z",
      authorDiscipline: "RN",
      data: {},
    });
  }

  async function dbAnswer(assessmentId: string, itemCode: string) {
    const { rows } = await admin.query<{
      item_code: string;
      state: string;
      value: string | null;
      source: string;
      answered_by_membership_id: string | null;
    }>(
      `SELECT i.item_code, a.state, a.value #>> '{}' AS value, a.source, a.answered_by_membership_id
       FROM hope_assessment_answer a
       JOIN hope_spec_item i ON i.id = a.spec_item_id
       WHERE a.hope_assessment_id=$1 AND i.item_code=$2`,
      [assessmentId, itemCode],
    );
    return rows[0] ?? null;
  }

  /**
   * An item's workspace state. A patch result lists only the items whose answer rows it wrote
   * (`touched`); an item that merely becomes applicable with no row to write is read back through the
   * workspace, as the web client does after every save.
   */
  async function workspaceItem(assessmentId: string, itemCode: string) {
    const ws = await svc.getAssessmentWorkspace(ORG, assessmentId);
    return ws.sections.flatMap((s) => s.items).find((i) => i.itemCode === itemCode);
  }

  /** Complete a draft until sign-ready — shared helper (_hope-sign-ready.ts), incl. the A1005/A1010 checklists. */
  const answerForSign = (id: string): Promise<void> =>
    answerHopeForSign({ svc, orgId: ORG, membershipId: membershipId, answerDate: ANSWER_DATE }, id);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await importHopeSpec({ databaseUrl: DB_URL });
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'hope2b','HOPE 2B','HOPE 2B')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'hope2b@x.test')`, [USER]);
    // A real M5 patient, so the admission prefill has facts to copy (A0220 admission date, demographics).
    await seedM5Patient(admin, ORG, PATIENT);
    membershipId = (
      await admin.query<{ id: string }>(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0]!.id;
    providerEntityId = (
      await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN2B','HOPE 2B Provider','NPI2B','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0]!.id;
    locationId = (
      await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'HOPE 2B Location','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0]!.id;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // The seams production boot registers that `recordTimepoint` reads: M6's AdmissionStatusReader
    // (the 01/02/03/05 RFAs resolve the admission's patient, siting and admission date through it) and
    // M5's HOPE-admission prefill readers. This suite's admissions are synthetic ids backed only by
    // schedule rows, all for one PATIENT — which the one-open-admission index forbids as real admission
    // rows — so M6's reader is stood in for with the summary those schedule rows imply. M5's are the real
    // Drizzle adapters (PATIENT is a seeded M5 row, so prefill copies A0220 and the demographics).
    registerSeam("AdmissionStatusReader", {
      async getAdmissionSummary(organizationId, admissionId) {
        return {
          admissionId,
          organizationId,
          patientId: PATIENT,
          providerEntityId,
          locationId,
          status: "active",
          admissionAt: "2025-10-15",
          activatedAt: "2025-10-15",
          dischargedAt: null,
          currentElectionPeriodId: null,
          currentLevelOfCare: null,
        } as never;
      },
      async getAdmissionSiting() {
        return null;
      },
    });
    registerPatientSeams({ db: handle.db });
    svc = createDbHopeBackend(handle.db);
    answers = createHopeAssessmentAnswerService(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("writes a draft user answer and increments assessment version once", async () => {
    const a = await draft();
    const res = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [
        { itemCode: "J2050A", action: "set", value: "1" },
        { itemCode: "J2051A", action: "set", value: "2" },
      ],
    });
    expect(res.version).toBe(a.version + 1);
    expect(res.answers.find((x) => x.itemCode === "J2051A")).toMatchObject({
      itemCode: "J2051A",
      state: "answered",
      value: "2",
      source: "user",
    });
    expect(await dbAnswer(a.id, "J2051A")).toMatchObject({
      state: "answered",
      value: "2",
      source: "user",
      answered_by_membership_id: membershipId,
    });
  });

  it("rejects invalid coded values atomically and leaves version unchanged", async () => {
    const a = await draft();
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version,
        changes: [{ itemCode: "J2051A", action: "set", value: "7" }],
      }),
    ).rejects.toThrow(/allowed CMS value|Invalid HOPE answer value/);
    expect(await dbAnswer(a.id, "J2051A")).toBeNull();
  });

  it("stores CMS coded value 9 as answered, not skipped", async () => {
    const a = await draft();
    await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [
        { itemCode: "J2050A", action: "set", value: "1" },
        { itemCode: "J2051A", action: "set", value: "9" },
      ],
    });
    expect(await dbAnswer(a.id, "J2051A")).toMatchObject({ state: "answered", value: "9" });
  });

  it("rejects CMS caret as a public value because skipped is state+null", async () => {
    const a = await draft();
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version,
        changes: [{ itemCode: "J2051A", action: "set", value: "^" }],
      }),
    ).rejects.toMatchObject({
      name: HopeInvalidAnswerValueError.name,
      details: [{ field: "J2051A", message: expect.stringMatching(/skipped \+ null/) }],
    });
    expect(await dbAnswer(a.id, "J2051A")).toBeNull();
  });

  it("rejects inactive and protected public writes", async () => {
    const a = await draft();
    await expect(answers.setSkipped(ORG, a.id, "Z0350")).rejects.toThrow(/workflow|inactive/i);
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version,
        changes: [{ itemCode: "A0050", action: "set", value: "2" }],
      }),
    ).rejects.toThrow(HopeProtectedItemWriteError);
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version,
        changes: [{ itemCode: "Z0500B", action: "set", value: "2025-10-15" }],
      }),
    ).rejects.toThrow(HopeProtectedItemWriteError);
  });

  it("clears an answer back to unanswered by deleting the row", async () => {
    const a = await draft();
    const first = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [
        { itemCode: "J2050A", action: "set", value: "1" },
        { itemCode: "J2051A", action: "set", value: "2" },
      ],
    });
    const cleared = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: first.version,
      changes: [{ itemCode: "J2051A", action: "clear" }],
    });
    expect(cleared.answers.find((x) => x.itemCode === "J2051A")).toMatchObject({
      itemCode: "J2051A",
      state: "unanswered",
      value: null,
    });
    expect(await dbAnswer(a.id, "J2051A")).toBeNull();
  });

  it("supports internal skipped writes without storing the CMS caret as a normal value", async () => {
    const a = await draft();
    const skipped = await answers.setSkipped(ORG, a.id, "J2051A");
    expect(skipped).toMatchObject({ state: "skipped", value: null, source: "derived" });
    expect(await dbAnswer(a.id, "J2051A")).toMatchObject({ state: "skipped", value: null });
  });

  it("rejects null answered values, duplicate items, stale versions, and signed mutations", async () => {
    const a = await draft();
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version,
        changes: [{ itemCode: "J2051A", action: "set", value: null as never }],
      }),
    ).rejects.toMatchObject({
      name: HopeInvalidAnswerValueError.name,
      details: [{ field: "J2051A", message: expect.stringMatching(/null/) }],
    });
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version,
        changes: [
          { itemCode: "J2051A", action: "set", value: "1" },
          { itemCode: "J2051A", action: "clear" },
        ],
      }),
    ).rejects.toThrow(/Duplicate|appears more than once/);
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version - 1,
        changes: [{ itemCode: "J2051A", action: "set", value: "1" }],
      }),
    ).rejects.toThrow(/stale/);
    await answerForSign(a.id);
    await svc.signTimepoint(ORG, membershipId, a.id);
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version + 1,
        changes: [{ itemCode: "J2051A", action: "set", value: "1" }],
      }),
    ).rejects.toThrow(/only draft/i);
  });

  it("rolls back a multi-answer patch when any answer is invalid", async () => {
    const a = await draft();
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: a.version,
        changes: [
          { itemCode: "J2051A", action: "set", value: "2" },
          { itemCode: "J2051B", action: "set", value: "7" },
        ],
      }),
    ).rejects.toThrow(/allowed CMS value|Invalid HOPE answer value/);
    expect(await dbAnswer(a.id, "J2051A")).toBeNull();
    expect(await dbAnswer(a.id, "J2051B")).toBeNull();
  });

  it("returns Admission HA workspace items from the imported spec", async () => {
    const a = await draft();
    const workspace = await svc.getAssessmentWorkspace(ORG, a.id);
    const counts = Object.fromEntries(workspace.sections.map((s) => [s.code, s.items.length]));
    expect(counts).toEqual({ A: 56, F: 8, I: 16, J: 43, M: 21, N: 6, Z: 1 });
    expect(workspace.sections.reduce((sum, section) => sum + section.items.length, 0)).toBe(151);
  });

  it("uses canonical J2051 answers at sign time while preserving legacy data JSONB fallback", async () => {
    const a = await draft();
    const patched = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [
        { itemCode: "J2050A", action: "set", value: "1" },
        // On/after the admission date (A0220 = 2025-10-15): CMS edit -3032 refuses a sign otherwise.
        { itemCode: "J2050B", action: "set", value: "2025-10-15" },
        { itemCode: "J2051A", action: "set", value: "3" },
      ],
    });
    expect(patched.version).toBe(a.version + 1);
    // A fired trigger opens the SFV at patch time, and readiness refuses to sign it until the SFV's
    // regulatory J2052/J2053 branch is complete: answer → SFV open → RFA-04 completion → sign.
    await svc.recordSfv(ORG, membershipId, a.admissionId, {
      triggeringAssessmentId: a.id,
      targetDate: "2025-10-16T12:00:00.000Z", // inside the 2-day SFV window from J2050B
      authorDiscipline: "RN",
      data: SFV_DATA,
    });
    await answerForSign(a.id);
    const { assessmentId } = await svc.signTimepoint(ORG, membershipId, a.id);
    // The sign result is a receipt; the J2051 derivation lands on the signed record.
    const signed = await svc.getAssessment(ORG, assessmentId);
    expect(signed.j2051MaxSeverity).toBe("severe");
    expect(signed.j2051TriggerFired).toBe(true);
  });

  it("reconciles Section F skip branches and discards stale downstream dates", async () => {
    const a = await draft();
    const skipped = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [{ itemCode: "F2000A", action: "set", value: "0" }],
    });
    expect(skipped.answers.find((x) => x.itemCode === "F2000B")).toMatchObject({
      state: "skipped",
      value: null,
      applicability: "not_applicable",
    });

    const reopened = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: skipped.version,
      changes: [{ itemCode: "F2000A", action: "set", value: "1" }],
    });
    expect(reopened.answers.find((x) => x.itemCode === "F2000B")).toMatchObject({
      state: "unanswered",
      applicability: "applicable",
    });

    const withDate = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: reopened.version,
      changes: [{ itemCode: "F2000B", action: "set", value: "2025-10-15" }],
    });
    expect(withDate.answers.find((x) => x.itemCode === "F2000B")).toMatchObject({
      state: "answered",
      value: "2025-10-15",
    });

    await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: withDate.version,
      changes: [{ itemCode: "F2000A", action: "set", value: "0" }],
    });
    expect(await dbAnswer(a.id, "F2000B")).toMatchObject({ state: "skipped", value: null });
  });

  it("clears stale downstream answers when a parent becomes pending", async () => {
    const a = await draft();
    const opened = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [{ itemCode: "F2100A", action: "set", value: "1" }],
    });
    const dated = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: opened.version,
      changes: [{ itemCode: "F2100B", action: "set", value: "2025-10-15" }],
    });
    const pending = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: dated.version,
      changes: [{ itemCode: "F2100A", action: "clear" }],
    });
    expect(pending.answers.find((x) => x.itemCode === "F2100B")).toMatchObject({
      state: "unanswered",
      applicability: "pending",
    });
    expect(await dbAnswer(a.id, "F2100B")).toBeNull();
  });

  it("rejects direct writes to not-applicable or pending descendants", async () => {
    const a = await draft();
    const closed = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [{ itemCode: "F2200A", action: "set", value: "0" }],
    });
    await expect(
      answers.patchAnswers(ORG, membershipId, a.id, {
        ifVersion: closed.version,
        changes: [{ itemCode: "F2200B", action: "set", value: "2025-10-15" }],
      }),
    ).rejects.toThrow(/not currently applicable|not_applicable/i);

    const b = await draft();
    await expect(
      answers.patchAnswers(ORG, membershipId, b.id, {
        ifVersion: b.version,
        changes: [{ itemCode: "F3000B", action: "set", value: "2025-10-15" }],
      }),
    ).rejects.toThrow(/pending|not currently applicable/i);
  });

  it("reconciles J2051 false and true trigger branches", async () => {
    const falseDraft = await draft();
    const falseResult = await answers.patchAnswers(ORG, membershipId, falseDraft.id, {
      ifVersion: falseDraft.version,
      changes: [
        { itemCode: "J2050A", action: "set", value: "1" },
        ...["A", "B", "C", "D", "E", "F", "G", "H"].map((suffix) => ({
          itemCode: `J2051${suffix}`,
          action: "set" as const,
          value: "9",
        })),
      ],
    });
    expect(falseResult.answers.find((x) => x.itemCode === "J2052A")).toMatchObject({
      state: "skipped",
      applicability: "not_applicable",
    });

    const trueDraft = await draft();
    const trueResult = await answers.patchAnswers(ORG, membershipId, trueDraft.id, {
      ifVersion: trueDraft.version,
      changes: [
        { itemCode: "J2050A", action: "set", value: "1" },
        { itemCode: "J2050B", action: "set", value: "2025-10-02" },
        { itemCode: "J2051A", action: "set", value: "2" },
      ],
    });
    expect(await workspaceItem(trueDraft.id, "J2052A")).toMatchObject({
      state: "unanswered",
      applicability: "applicable",
    });
    const refreshed = await svc.getAssessment(ORG, trueDraft.id);
    expect(refreshed.j2051TriggerFired).toBe(true);
    expect(refreshed.j2051MaxSeverity).toBe("moderate");
    const { sfvs } = await svc.listSfv(ORG, "open");
    const sfv = sfvs.find((row) => row.triggeringAssessmentId === trueDraft.id);
    expect(sfv).toBeDefined();
    expect(sfv?.dueAt).toBe("2025-10-04T23:59:59.999Z");

    await answers.patchAnswers(ORG, membershipId, trueDraft.id, {
      ifVersion: trueResult.version,
      changes: [{ itemCode: "J2051A", action: "set", value: "1" }],
    });
    const withdrawn = await svc.getSfv(ORG, sfv!.id);
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("evaluates multiple opioid parent changes from the final patched answer set", async () => {
    const a = await draft();
    await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [
        { itemCode: "N0500A", action: "set", value: "0" },
        { itemCode: "N0510A", action: "set", value: "1" },
      ],
    });
    expect(await workspaceItem(a.id, "N0520A")).toMatchObject({
      state: "unanswered",
      applicability: "applicable",
    });
  });

  it("materializes validation findings by stable fingerprint and resolves absent findings", async () => {
    const a = await draft();
    const invalid = await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: a.version,
      changes: [
        { itemCode: "M1190", action: "set", value: "1" },
        { itemCode: "M1195A", action: "set", value: "1" },
        { itemCode: "M1195Z", action: "set", value: "1" },
      ],
    });
    const first = await svc.getValidation(ORG, a.id, { mode: "final" });
    expect(first.findings.find((finding) => finding.ruleId === "-3094")).toMatchObject({
      fingerprint: "-3094:M1195Z",
      resolved: false,
    });

    await answers.patchAnswers(ORG, membershipId, a.id, {
      ifVersion: invalid.version,
      changes: [{ itemCode: "M1195Z", action: "clear" }],
    });
    const second = await svc.getValidation(ORG, a.id, { mode: "final" });
    expect(second.findings.some((finding) => finding.fingerprint === "-3094:M1195Z")).toBe(false);
    const { rows } = await admin.query<{ resolved: boolean }>(
      "SELECT resolved FROM hope_validation_finding WHERE hope_assessment_id=$1 AND fingerprint='-3094:M1195Z'",
      [a.id],
    );
    expect(rows).toEqual([{ resolved: true }]);
  });
});
