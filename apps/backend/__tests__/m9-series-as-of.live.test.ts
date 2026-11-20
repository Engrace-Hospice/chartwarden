import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * VN-D11 - `ScaleSeriesProvider.series(from, to)` read as-of the visit time, proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role. There is no M9 as-of seam: the draft passes `to` = the visit time. This pins
 * what makes that sound in SQL, not only in the in-memory slice: `to` and `from` are INCLUSIVE, the window keys on
 * `captured_at` (the clinical capture instant), a reading captured after `to` is excluded however late it was
 * recorded (`created_at`), a correction keeps its target's `captured_at`, and the series is ascending.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m9:series-as-of:live
 */
import { createDrizzleAssessmentReaderStore } from "../src/modules/09-assessments/seams/drizzle-store";
import { createScaleSeriesProvider } from "../src/modules/09-assessments/seams/providers";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

const EPOCH = "1970-01-01T00:00:00.000Z";
const VISIT = "2026-03-10T09:00:00.000Z";

describe.skipIf(!DB_URL)(
  "M9 ScaleSeriesProvider.series as-of - LIVE Postgres as chartwarden_app",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let provider: ReturnType<typeof createScaleSeriesProvider>;
    let siting: { providerEntity: string; location: string; membership: string };
    const id: Record<string, string> = {};

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of LIVE_DROP_ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
    }

    /** One PPS reading captured at `capturedAt`, recorded (created_at) at `createdAt`. */
    async function seedReading(
      key: string,
      capturedAt: string,
      createdAt: string,
      score: number,
      status = "active",
    ) {
      id[key] = (
        await admin.query(
          `INSERT INTO clinical_assessment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, scale_type, scale_version, data, score, captured_at, created_at,
           captured_by_membership_id, captured_by_discipline, status)
         VALUES ($1,$2,$3,$4,$5,'pps','1.0','{}'::jsonb,$6,$7,$8,$9,'RN',$10) RETURNING id`,
          [
            ORG,
            siting.providerEntity,
            siting.location,
            PATIENT,
            ADMISSION,
            score,
            capturedAt,
            createdAt,
            siting.membership,
            status,
          ],
        )
      ).rows[0].id as string;
    }

    const series = (from: string, to: string) =>
      runWithRequestContext({ organizationId: ORG, userId: randomUUID() } as never, () =>
        provider.series(PATIENT as never, "pps", from, to),
      ).then((s) => s.points.map((p) => p.assessmentId));

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      }
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
        [ORG],
      );
      await admin.query(`INSERT INTO "user" (id, email) VALUES ($1,'asof@x.test')`, [USER]);
      const membership = (
        await admin.query(
          "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
          [USER, ORG],
        )
      ).rows[0].id as string;
      const providerEntity = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-AO1','AO Provider','NPI-AO1','enc','12-31') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc-AO1','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity],
        )
      ).rows[0].id as string;
      siting = { providerEntity, location, membership };

      await seedReading("early", "2026-03-01T09:00:00.000Z", "2026-03-01T09:05:00.000Z", 70);
      await seedReading("justBefore", "2026-03-10T08:59:59.999Z", "2026-03-10T09:30:00.000Z", 60);
      await seedReading("atVisit", VISIT, "2026-03-10T09:05:00.000Z", 50);
      await seedReading("justAfter", "2026-03-10T09:00:00.001Z", "2026-03-10T09:10:00.000Z", 40);
      // captured BEFORE the visit but recorded AFTER it (a late entry): by clinical time it belongs in the draft
      await seedReading("lateEntered", "2026-03-09T12:00:00.000Z", "2026-03-12T08:00:00.000Z", 55);
      // a reading that was corrected is no longer active: only its correction (same captured_at) is read
      await seedReading(
        "corrected",
        "2026-03-05T09:00:00.000Z",
        "2026-03-05T09:05:00.000Z",
        65,
        "superseded",
      );

      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      provider = createScaleSeriesProvider(createDrizzleAssessmentReaderStore(handle.db));
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("proves the connection is the NOBYPASSRLS app role", async () => {
      const probe = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await probe.connect();
      const { rows } = await probe.query(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
      );
      await probe.end();
      expect(rows[0]).toMatchObject({
        current_user: "chartwarden_app",
        rolsuper: false,
        rolbypassrls: false,
      });
    });

    it("includes a reading captured exactly at `to` and excludes one captured after it", async () => {
      const out = await series(EPOCH, VISIT);

      expect(out).toContain(id.atVisit);
      expect(out).not.toContain(id.justAfter);
    });

    it("includes a reading captured one millisecond before `to`", async () => {
      expect(await series(EPOCH, VISIT)).toContain(id.justBefore);
    });

    it("excludes the reading at `to` when `to` is one millisecond earlier (inclusive, not rounded)", async () => {
      expect(await series(EPOCH, "2026-03-10T08:59:59.999Z")).not.toContain(id.atVisit);
    });

    it("includes a reading captured exactly at `from`", async () => {
      expect(await series(VISIT, "2026-03-31T00:00:00.000Z")).toContain(id.atVisit);
    });

    it("keys on the capture instant: a reading captured before the visit but recorded after it is included", async () => {
      expect(await series(EPOCH, VISIT)).toContain(id.lateEntered);
    });

    it("returns the series ascending by capture time, so the last point is the latest as of `to`", async () => {
      expect(await series(EPOCH, VISIT)).toEqual([
        id.early,
        id.lateEntered,
        id.justBefore,
        id.atVisit,
      ]);
    });

    it("leaves out a reading that is no longer active (corrected)", async () => {
      expect(await series(EPOCH, VISIT)).not.toContain(id.corrected);
    });
  },
);
