/**
 * M9L — the Drizzle `createDbAssessmentRouteService` READ paths, proven against real Postgres.
 *
 * The unit suites exercise M9's pure slice (correction-supersede, scoring, the scale registry) but never
 * touch a database; this drives the PRODUCTION read service (the one the composition root mounts) over the
 * real M9 tables under `withOrgContext` — proving the org license catalog and the patient assessment list
 * return the right rows/shape, RLS scopes every read by tenant, and every write fail-closes 501.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m9-assessments-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAssessmentRouteService } from "../src/modules/09-assessments/assessments-route-service-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `membership.user_id` carries a real FK to `user`, so a single seeded user backs every org's membership. */
const USER = "33333333-3333-3333-3333-333333333333";
/** patient_id / admission_id are NOT NULL but carry no FK — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

// `seedOrg` returns five ids and this named two, so the three the ABAC assertions read back —
// providerEntity, location, membership — were invisible to every consumer of the seed.
type SeedIds = {
  scaleLicense: string;
  clinicalAssessment: string;
  providerEntity: string;
  location: string;
  membership: string;
};

describe.skipIf(!DB_URL)("M9 Drizzle read service — LIVE Postgres (M9L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbAssessmentRouteService>;
  const seeded: Record<string, SeedIds> = {};

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

  /** Seed one M9 chain for `org` as superuser (RLS + grants bypassed): a pps license + a scored pps assessment. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M9R${n}`, `M9R Provider ${n}`, `NPI-M9R${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M9R${n}`],
      )
    ).rows[0].id as string;
    const clinicalAssessment = (
      await admin.query(
        `INSERT INTO clinical_assessment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, scale_type, scale_version, data, score, score_interpretation, captured_at,
           captured_by_membership_id, captured_by_discipline)
         VALUES ($1,$2,$3,$4,$5,'pps','1.0','{"notes":"seed"}'::jsonb, 60, 'PPS 60%', now(), $6, 'RN')
         RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership],
      )
    ).rows[0].id as string;
    // GAP-086 — effective_date is TWO DAYS BACK, not today. The read service derives the license status in
    // the ORG's timezone (todayForOrganization) while this seed stamps the DB server's UTC date, so a
    // same-day effective_date reads as not-yet-in-force ("pending_renewal") for the ~8 hours a day the two
    // calendars disagree — a test that passes two thirds of the day. The margin makes it time-of-day
    // independent in either direction.
    const scaleLicense = (
      await admin.query(
        `INSERT INTO scale_license (organization_id, scale_type, license_holder, license_number,
           effective_date, expires_at, status, recorded_by_membership_id)
         VALUES ($1,'pps','Palliative Perf Scale','LIC-1', now()::date - 2, now()::date + 365, 'active', $2)
         RETURNING id`,
        [org, membership],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO scale_policy (organization_id, scale_type, enabled, updated_by_membership_id)
       VALUES ($1,'pps', true, $2)`,
      [org, membership],
    );
    return { scaleLicense, clinicalAssessment, providerEntity, location, membership };
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m9r@x.test')`, [USER]);
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role; `withOrgContext` deliberately does NOT SET ROLE.
    // To exercise RLS faithfully, connect AS chartwarden_app — NOLOGIN in the migrations, so grant LOGIN here.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbAssessmentRouteService(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("listLicenses returns the org's seeded pps scale license (RLS-scoped org catalog)", async () => {
    const { licenses } = await service.listLicenses(ORG_A);
    expect(licenses.length).toBe(1);
    expect(licenses[0].id).toBe(seeded[ORG_A].scaleLicense);
    expect(licenses[0].scaleType).toBe("pps");
    expect(licenses[0].vendor).toBe("Palliative Perf Scale"); // ScaleLicenseView.vendor <= license_holder
    expect(licenses[0].status).toBe("active");
  });

  it("listAssessments returns the patient's seeded assessment with the scored shape", async () => {
    const { assessments } = await service.listAssessments(ORG_A, PATIENT);
    expect(assessments.length).toBe(1);
    expect(assessments[0].id).toBe(seeded[ORG_A].clinicalAssessment);
    expect(assessments[0].scaleType).toBe("pps");
    expect(assessments[0].score).toBe(60);
    expect(assessments[0].redacted).toBe(false);
  });

  // ── GAP-017 — the D10 / M09-F05 SUD chart-read disclosure gate ────────────────────────────────
  //
  // The AIMS gate was `scaleType === "aims" && sudContext` with NO consent read anywhere, so a
  // SUD-context AIMS row was redacted for every caller forever and an active 42 CFR Part 2 release
  // changed nothing. These cases drive the PRODUCTION read paths with the consent decision injected
  // both ways, which is the only way to see that the decision is now actually consulted.
  describe("SUD-context AIMS redaction is consent-driven (GAP-017)", () => {
    let aimsId: string;

    beforeAll(async () => {
      aimsId = (
        await admin.query(
          `INSERT INTO clinical_assessment (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, scale_type, scale_version, data, score, score_interpretation, captured_at,
             captured_by_membership_id, captured_by_discipline, sud_context)
           VALUES ($1,$2,$3,$4,$5,'aims','1.0','{"notes":"aims seed"}'::jsonb, 12, 'AIMS 12', now(), $6, 'RN', true)
           RETURNING id`,
          [
            ORG_A,
            seeded[ORG_A].providerEntity,
            seeded[ORG_A].location,
            PATIENT,
            ADMISSION,
            seeded[ORG_A].membership,
          ],
        )
      ).rows[0].id as string;
    });

    /** The production service with the M39 decision injected (undefined ⇒ the real seam defaults). */
    const serviceWithConsent = (redact: boolean) =>
      createDbAssessmentRouteService(
        handle.db,
        undefined,
        undefined,
        undefined,
        async () => redact,
      );

    it("redacts the AIMS row when no Part 2 release is on file", async () => {
      const { assessments } = await serviceWithConsent(true).listAssessments(ORG_A, PATIENT);
      const aims = assessments.find((a) => a.id === aimsId);
      expect(aims).toBeDefined();
      expect(aims!.redacted).toBe(true);
      expect(aims!.score).toBeNull();
      expect(aims!.data).toEqual({});
    });

    it("UN-redacts the same row when M39 reports an active Part 2 release", async () => {
      const { assessments } = await serviceWithConsent(false).listAssessments(ORG_A, PATIENT);
      const aims = assessments.find((a) => a.id === aimsId);
      expect(aims!.redacted).toBe(false);
      expect(aims!.score).toBe(12);
      expect(aims!.data).toEqual({ notes: "aims seed" });
    });

    it("never redacts a NON-SUD row, whatever the consent decision says", async () => {
      const { assessments } = await serviceWithConsent(true).listAssessments(ORG_A, PATIENT);
      const pps = assessments.find((a) => a.id === seeded[ORG_A].clinicalAssessment);
      expect(pps!.redacted).toBe(false);
      expect(pps!.score).toBe(60);
    });

    it("applies the same decision on the single-row read and the series read", async () => {
      const one = await serviceWithConsent(true).getAssessment(ORG_A, PATIENT, aimsId);
      expect(one.redacted).toBe(true);
      const open = await serviceWithConsent(false).getAssessment(ORG_A, PATIENT, aimsId);
      expect(open.redacted).toBe(false);

      const today = new Date().toISOString().slice(0, 10);
      const closed = await serviceWithConsent(true).seriesScale(
        ORG_A,
        PATIENT,
        "aims",
        today,
        today,
      );
      expect(closed.points.every((pt) => pt.score === null)).toBe(true);
      const shown = await serviceWithConsent(false).seriesScale(
        ORG_A,
        PATIENT,
        "aims",
        today,
        today,
      );
      expect(shown.points.some((pt) => pt.score === 12)).toBe(true);
    });

    it("does not consult M39 at all when the result set holds no SUD-context AIMS row", async () => {
      // One consent read per request is already cheap, but zero for the overwhelmingly common case is
      // the point: this must not put an M39 round trip on every chart read in the product.
      let calls = 0;
      const svc = createDbAssessmentRouteService(
        handle.db,
        undefined,
        undefined,
        undefined,
        async () => {
          calls += 1;
          return true;
        },
      );
      await svc.latestScale(ORG_A, PATIENT, "pps");
      expect(calls).toBe(0);
      await svc.listAssessments(ORG_A, PATIENT); // contains the AIMS row
      expect(calls).toBe(1);
    });
  });

  it("RLS: org B cannot see org A's license or assessment through the read service", async () => {
    const { licenses } = await service.listLicenses(ORG_B);
    expect(licenses.every((l) => l.id !== seeded[ORG_A].scaleLicense)).toBe(true);
    expect(licenses[0]?.id).toBe(seeded[ORG_B].scaleLicense);
    const { assessments } = await service.listAssessments(ORG_B, PATIENT);
    expect(assessments.every((r) => r.id !== seeded[ORG_A].clinicalAssessment)).toBe(true);
    expect(assessments[0]?.id).toBe(seeded[ORG_B].clinicalAssessment);
  });

  it("createLicense now persists a real license (the M9L write pipeline; full coverage in the write suite)", async () => {
    const created = await service.createLicense(ORG_A, {
      scaleType: "morse",
      vendor: "New Vendor",
      // Two days back for the same org-timezone-vs-UTC reason as the seed above.
      effectiveDate: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
    });
    expect(created.vendor).toBe("New Vendor");
    expect(created.status).toBe("active");
    const { licenses } = await service.listLicenses(ORG_A);
    expect(licenses.some((l) => l.scaleType === "morse" && l.vendor === "New Vendor")).toBe(true);
  });
});
