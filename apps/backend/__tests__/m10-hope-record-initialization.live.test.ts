import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { createHopeSpecRegistry } from "../src/modules/10-hope/hope-spec-registry";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const PATIENT = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("M10 HOPE Phase 2A record initialization — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbHopeBackend>;
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
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- vector stripped");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- hnsw stripped");
      }
      await admin.query(sql);
    }
  }

  async function seedSchedule(rfaKind: string, admissionId = nextAdmission()): Promise<string> {
    await admin.query(
      `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'2025-10-01','2025-12-31','2026-01-15','{}'::jsonb,'manual_admin')`,
      [ORG, providerEntityId, locationId, PATIENT, admissionId, rfaKind],
    );
    return admissionId;
  }

  function nextAdmission(): string {
    seq += 1;
    return `44444444-4444-4444-8444-${seq.toString().padStart(12, "0")}`;
  }

  async function record(rfaKind: "01_admission" | "02_huv1" | "03_huv2" | "05_discharge") {
    const admissionId = await seedSchedule(rfaKind);
    return svc.recordTimepoint(ORG, membershipId, admissionId, {
      rfaKind,
      targetDate: "2025-10-15T00:00:00.000Z",
      authorDiscipline: "RN",
      data: {},
      dischargeReason: rfaKind === "05_discharge" ? "death" : undefined,
    });
  }

  async function controlAnswers(assessmentId: string) {
    const { rows } = await admin.query<{
      item_code: string;
      state: string;
      value: string;
      source: string;
    }>(
      `SELECT i.item_code, a.state, a.value #>> '{}' AS value, a.source
       FROM hope_assessment_answer a
       JOIN hope_spec_item i ON i.id = a.spec_item_id
       WHERE a.hope_assessment_id=$1 AND i.item_code IN ('A0050','A0250')
       ORDER BY i.item_code`,
      [assessmentId],
    );
    return Object.fromEntries(rows.map((r) => [r.item_code, r]));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await importHopeSpec({ databaseUrl: DB_URL });
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'hope2a','HOPE 2A','HOPE 2A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'hope2a@x.test')`, [USER]);
    membershipId = (
      await admin.query<{ id: string }>(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id;
    providerEntityId = (
      await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN2A','HOPE 2A Provider','NPI2A','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id;
    locationId = (
      await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'HOPE 2A Location','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    svc = createDbHopeBackend(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it.each([
    ["01_admission", "HA", "1"],
    ["02_huv1", "HUV", "2"],
    ["03_huv2", "HUV", "3"],
    ["05_discharge", "HD", "9"],
  ] as const)("initializes %s with frozen spec, ISC, A0050, and A0250", async (rfaKind, isc, a0250) => {
    const assessment = await record(rfaKind);
    expect(assessment.regulatory.isc).toBe(isc);
    expect(assessment.regulatory.specVersionId).toMatch(/^[0-9a-f-]{36}$/);
    const answers = await controlAnswers(assessment.id);
    expect(answers.A0050).toMatchObject({ state: "answered", value: "1", source: "derived" });
    expect(answers.A0250).toMatchObject({ state: "answered", value: a0250, source: "derived" });

    const registry = createHopeSpecRegistry(handle.db);
    await expect(registry.requireAllowedValue(assessment.regulatory.specVersionId!, "A0050", "1")).resolves.toBeUndefined();
    await expect(registry.requireAllowedValue(assessment.regulatory.specVersionId!, "A0250", a0250)).resolves.toBeUndefined();
    if (isc === "HA") {
      const active = await registry.getActiveItemsForAssessment(assessment.id);
      const sectionCounts = active
        .filter((item) => item.kind === "assessment")
        .reduce<Record<string, number>>((acc, item) => {
          acc[item.sectionLabel] = (acc[item.sectionLabel] ?? 0) + 1;
          return acc;
        }, {});
      expect(sectionCounts).toEqual({ A: 56, F: 8, I: 16, J: 43, M: 21, N: 6, Z: 1 });
    }
  });

  it("initializes an Admission correction as A0050=2, preserving original spec/ISC and target date", async () => {
    const draft = await record("01_admission");
    const signed = await svc.signTimepoint(ORG, membershipId, draft.id);
    const correction = await svc.correctTimepoint(ORG, membershipId, signed.id, {
      correctionReason: "fix control",
      targetDate: "2026-01-01T00:00:00.000Z",
      authorDiscipline: "RN",
      data: {},
    });

    expect(correction.correctsAssessmentId).toBe(signed.id);
    expect(correction.regulatory).toEqual(signed.regulatory);
    expect(correction.targetDate).toBe(signed.targetDate);
    const answers = await controlAnswers(correction.id);
    expect(answers.A0050).toMatchObject({ state: "answered", value: "2", source: "derived" });
    expect(answers.A0250).toMatchObject({ state: "answered", value: "1", source: "derived" });
  });
});
