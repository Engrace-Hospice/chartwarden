/**
 * GAP-155 - the M30 CAP-overdue scan SQL (`incident_report.kind_data->'_m30'->'capPlan'` jsonb path + the
 * `m30_incident_lifecycle` enum cast) against a real partitioned `incident_report`, LIVE Postgres, as the
 * RLS-enforced `wardenx_app` role. Proves the scan picks only OPEN incidents of THIS org with incomplete past-due
 * actions, skips owners that do not resolve, and ignores another tenant's plans. Gated on a live DB:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:gap-155:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanOrgForOverdueCapActions } from "../src/modules/30-quality/jobs/cap-overdue-scan";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORG_A = "11111111-1111-4111-8111-111111115501";
const ORG_B = "22222222-2222-4222-8222-222222225502";
const MEMBER_OK = "a0000000-0000-4000-8000-000000005501";
const MEMBER_GONE = "a0000000-0000-4000-8000-000000005502";
const USER_OK = "b0000000-0000-4000-8000-000000005501";
const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const daysAhead = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

describe.skipIf(!DB_URL)("GAP-155 M30 CAP-overdue scan, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let peA = "";
  let peB = "";

  const seedIncident = async (
    org: string,
    pe: string,
    lifecycle: string,
    capPlan: unknown,
  ): Promise<string> =>
    (
      await admin.query(
        `INSERT INTO incident_report (organization_id, provider_entity_id, kind, kind_data, occurred_at, reported_by_membership_id, severity, lifecycle)
         VALUES ($1,$2,'fall',$3::jsonb, now(), $4, 'minor', $5::m30_incident_lifecycle) RETURNING id`,
        [
          org,
          pe,
          JSON.stringify(capPlan === null ? {} : { _m30: { capPlan } }),
          MEMBER_OK,
          lifecycle,
        ],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "g155a"],
      [ORG_B, "g155b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    const mkPe = async (org: string, ccn: string, npi: string) =>
      (
        await admin.query(
          "INSERT INTO provider_entity (organization_id, legal_name, ccn, npi, tax_id_encrypted, fiscal_year_end, status) VALUES ($1,'PE',$2,$3,'x','1231','active') RETURNING id",
          [org, ccn, npi],
        )
      ).rows[0].id as string;
    peA = await mkPe(ORG_A, "123456", "1234567893");
    peB = await mkPe(ORG_B, "654321", "1000000004");
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const resolver = async (_org: string, ids: readonly string[]) =>
    new Map(ids.filter((i) => i === MEMBER_OK).map((i) => [i, USER_OK]));

  it("returns only incomplete past-due actions on OPEN incidents of this org, with resolvable owners", async () => {
    const overdueOpen = await seedIncident(ORG_A, peA, "under_investigation", {
      actions: [
        { action: "retrain", ownerMembershipId: MEMBER_OK, dueAt: daysAgo(3), completedAt: null },
        {
          action: "done",
          ownerMembershipId: MEMBER_OK,
          dueAt: daysAgo(3),
          completedAt: daysAgo(1),
        },
        { action: "later", ownerMembershipId: MEMBER_OK, dueAt: daysAhead(5), completedAt: null },
        { action: "orphan", ownerMembershipId: MEMBER_GONE, dueAt: daysAgo(9), completedAt: null },
      ],
    });
    await seedIncident(ORG_A, peA, "closed_followup_complete", {
      actions: [
        { action: "x", ownerMembershipId: MEMBER_OK, dueAt: daysAgo(30), completedAt: null },
      ],
    });
    await seedIncident(ORG_A, peA, "triaged", null);
    await seedIncident(ORG_B, peB, "triaged", {
      actions: [
        { action: "b", ownerMembershipId: MEMBER_OK, dueAt: daysAgo(30), completedAt: null },
      ],
    });

    const result = await scanOrgForOverdueCapActions(app.db, ORG_A, NOW, resolver);
    expect(result).toEqual([
      { incidentId: overdueOpen, actionIndex: 0, dueAt: expect.any(String), ownerUserId: USER_OK },
    ]);
  });

  it("another tenant's plans are invisible under RLS (org B sees only its own)", async () => {
    const result = await scanOrgForOverdueCapActions(app.db, ORG_B, NOW, resolver);
    expect(result).toHaveLength(1);
    expect(result[0]?.actionIndex).toBe(0);
  });
});
