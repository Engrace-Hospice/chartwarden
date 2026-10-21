/**
 * F-160-follow-up (#248) — LIVE Postgres proof that M30's `buildM30BereavementPlanClosedConsumer` (the
 * `m16.bereavement.plan_closed_completed` / `.plan_closed_declined` / `.plan_closed_early` binding)
 * resolves a real `bereavement_plan.provider_entity_id` via the new org-explicit
 * `bereavementPlanSitingForOrg` read and enqueues exactly one `bereavement_coverage_rate`
 * `measure_recompute_queue` row — never the whole `operational` family — under real RLS.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m30:bereavement-plan-closed-consumer:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bereavementPlanSitingForOrg } from "../src/modules/16-bereavement/seams/plan-provider-entity-for-org";
import { buildM30BereavementPlanClosedConsumer } from "../src/modules/30-quality/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "M30 m16.bereavement.plan_closed_* consumer — enqueueRecompute — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerEntityA: string;
    let planA: string;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
        );
      }
    }

    async function applyMigrations() {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((candidate) => candidate.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m30-plan-closed-a','M30 Plan Closed A','M30 Plan Closed A'),
                ($2,'m30-plan-closed-b','M30 Plan Closed B','M30 Plan Closed B')`,
        [ORG_A, ORG_B],
      );
      providerEntityA = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M30PC-A','Plan Closed Provider A','1000000003','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      planA = (
        await admin.query(
          // `berv_plan_opened_at_required`/`berv_plan_closed_at_required` — a closed_completed row
          // needs both non-null.
          `INSERT INTO bereavement_plan
             (organization_id,patient_id,admission_id,provider_entity_id,status,death_date,opened_at,closed_at)
           VALUES ($1,gen_random_uuid(),gen_random_uuid(),$2,'closed_completed','2026-01-01',now(),now())
           RETURNING id`,
          [ORG_A, providerEntityA],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("resolves providerEntityId via the plan and enqueues ONLY bereavement_coverage_rate, and a redelivery does not duplicate the row", async () => {
      const consumer = buildM30BereavementPlanClosedConsumer({
        db: handle.db,
        bereavementPlanSitingForOrg,
      });
      const event = {
        id: "88888888-8888-4888-8888-888888888888",
        organizationId: ORG_A,
        eventType: "m16.bereavement.plan_closed_completed",
        aggregateKind: "bereavement_plan",
        aggregateId: planA,
        attemptCount: 0,
        createdAt: new Date(),
        payload: { planId: planA, closedAt: "2026-01-01T00:00:00.000Z", outreachStats: {} },
      };
      await consumer.handle(event);
      await consumer.handle(event); // redelivery — must debounce onto the same pending row, not duplicate

      const rows = await admin.query(
        `SELECT measure_code, provider_entity_id, organization_id, requires_recompute,
                triggering_event_outbox_id, triggering_event_name
         FROM measure_recompute_queue WHERE organization_id = $1`,
        [ORG_A],
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.measure_code).toBe("bereavement_coverage_rate");
      expect(row.provider_entity_id).toBe(providerEntityA);
      expect(row.organization_id).toBe(ORG_A);
      expect(row.requires_recompute).toBe(true);
      expect(row.triggering_event_outbox_id).toBe(event.id);
      expect(row.triggering_event_name).toContain("m16.bereavement.plan_closed_completed");
    });

    it("a planId this org does not recognise (cross-tenant / stale redelivery) is a silent no-op", async () => {
      const consumer = buildM30BereavementPlanClosedConsumer({
        db: handle.db,
        bereavementPlanSitingForOrg,
      });
      const event = {
        id: "99999999-9999-4999-8999-999999999999",
        organizationId: ORG_B, // planA belongs to ORG_A
        eventType: "m16.bereavement.plan_closed_declined",
        aggregateKind: "bereavement_plan",
        aggregateId: planA,
        attemptCount: 0,
        createdAt: new Date(),
        payload: { planId: planA, closedAt: "2026-01-01T00:00:00.000Z" },
      };
      await expect(consumer.handle(event)).resolves.toBeUndefined();

      const rows = await admin.query(
        `SELECT count(*)::int AS n FROM measure_recompute_queue WHERE organization_id = $1`,
        [ORG_B],
      );
      expect(rows.rows[0].n).toBe(0);
    });
  },
);
