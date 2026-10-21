#!/usr/bin/env bun
/**
 * ChartWarden — backfill the M33 day-one dashboards for orgs provisioned BEFORE the seeder existed
 * (#138 / F-060 / F-116).
 *
 * `apps/backend/src/modules/33-reporting/system-dashboard-seeder.ts` now runs on every accepted
 * invitation for an org, so every org provisioned from here on gets its system-authored, org-shared
 * dashboards automatically. This one-off script covers the gap: orgs that already exist and have
 * already had every invitation accepted, so the new hook never fires for them again.
 *
 * For each organization with at least one non-revoked membership, this picks the EARLIEST-invited
 * membership as the nominal dashboard owner (a stable, deterministic choice — not necessarily an
 * `org_admin`, since a system-authored, org-shared dashboard is visible to the whole org regardless of
 * whose membership id happens to own the row) and calls the same idempotent seeder the live route
 * calls. An org with ZERO non-revoked memberships (provisioned but the first-admin invitation was
 * never accepted) is skipped and reported — it needs no backfill, because the live hook will seed it
 * the moment that invitation IS accepted.
 *
 * Idempotent: safe to re-run (e.g. after a new base goes `active`) — `report_definition_system_org_base_uq`
 * (migration 0248) makes every already-seeded base a no-op.
 *
 * Run:   bun run scripts/backfill-system-dashboards.ts
 */
import { createDbClient, schema } from "@chartwarden/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { createDbSystemDashboardSeeder } from "../apps/backend/src/modules/33-reporting/index";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
    process.exit(1);
  }
  const { db, close } = createDbClient({ connectionString });
  const seeder = createDbSystemDashboardSeeder(db);

  try {
    const orgs = await db.select().from(schema.organizations);
    let seededOrgs = 0;
    let skippedNoMembership = 0;
    let dashboardsCreated = 0;

    for (const org of orgs) {
      const [owner] = await db
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.organizationId, org.id),
            ne(schema.memberships.status, "revoked"),
          ),
        )
        .orderBy(asc(schema.memberships.invitedAt))
        .limit(1);

      if (!owner) {
        skippedNoMembership += 1;
        console.log(`skip  ${org.id} — no non-revoked membership yet`);
        continue;
      }

      const result = await seeder.ensureSystemDashboards({
        organizationId: org.id,
        userId: owner.userId,
        ownerMembershipId: owner.id,
      });
      seededOrgs += 1;
      dashboardsCreated += result.created.length;
      if (result.created.length > 0) {
        console.log(`seed  ${org.id} — created [${result.created.join(", ")}]`);
      }
    }

    console.log(
      `\norgs=${orgs.length} processed=${seededOrgs} skippedNoMembership=${skippedNoMembership} dashboardsCreated=${dashboardsCreated}`,
    );
  } finally {
    await close();
  }
}

await main();
