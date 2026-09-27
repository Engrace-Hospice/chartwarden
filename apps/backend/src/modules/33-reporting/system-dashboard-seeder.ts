// apps/backend/src/modules/33-reporting/system-dashboard-seeder.ts — the M33 §1 "day-one dashboards"
// differentiator, built (#138 / F-060 / F-116).
//
// The spec's own claim: a hospice agency gets platform-shipped dashboards "without the agency
// authoring a single definition." Nothing did this — `find . -name "system-definitions-seed*"` found
// nothing, and a freshly provisioned tenant's `/reports` was empty until someone authored a report.
//
// WHY THIS RUNS AT INVITATION-ACCEPT, NOT AT M34 TENANT-PROVISION. A dashboard here is a `report_view`
// with `share_scope='org'` (`DashboardCatalogProviderImpl.listDashboardsForOrg` reads exactly those),
// and `report_view.owner_membership_id` is NOT NULL — a saved view is always owned by a real membership.
// `packages/saas-tenant-platform/src/services/provision-worker.ts` (the `tenant.provision` job) runs
// BEFORE any membership exists: it creates the org, the key ring, storage prefixes, the onboarding
// tasks, and the first-admin INVITATION — not a membership. The earliest point an owner membership
// exists is `POST /api/v1/invitations/accept`, which is also where M2→M3's role-attach handshake runs
// (F-097, `03-authorization/proposed-role-attacher.ts`) for the identical reason. This binds the same
// way, at the same hook, for the same reason.
//
// SCOPE, stated honestly. Only the bases `report_base_catalog.status = 'active'` today get a system
// dashboard — 3 of ~36 registered MV keys (`census_org_daily`, `encounter_productivity_membership_day`,
// `evv_compliance_org_week`; migration 0061). The other 33 are `registered` placeholders whose upstream
// producers have not landed; shipping a dashboard over one would render an empty tile and misrepresent
// the honest scope. The base list is read from the catalog, not hardcoded, so a base going `active`
// later needs no code change here — only a re-run of the backfill (idempotent; see
// `scripts/backfill-system-dashboards.ts`) for orgs provisioned before it went active.
//
// Each dashboard's dimensions/measures are the base's OWN full `dimensions`/`measures` arrays
// (`report_base_catalog`), not a hand-picked subset — the same "read the existing decision instead of
// re-deciding it" rule this repo applies to HearthNote's `vitals_review` sections (F-112) and the M23
// active-base check: the base catalog already says what it exposes, and a second, hand-maintained list
// would just be another thing to keep in sync.
//
// IDEMPOTENCY. `ensureSystemDashboards` is invoked on EVERY accepted invitation for an org (cheap once a
// definition already exists — a `listDefinitions` read plus zero-to-few no-op inserts). The actual guard
// against a genuine race (two admins accepting the first two invitations for the same brand-new org at
// once) is the DATABASE: `report_definition_system_org_base_uq` (migration 0248), a partial unique index
// on `(organization_id, base_key) WHERE authorship = 'system'`. `.onConflictDoNothing()` against it
// mirrors the `elevated-approvals.ts` `grant()` precedent — a concurrent second writer gets zero rows
// back rather than a duplicate dashboard.
import { type DbClient, schema } from "@wardenx/db";
import {
  ReportCatalogRepository,
  ReportDefinitionRepository,
  ReportViewRepository,
} from "@wardenx/reporting";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";

/** What the seeder reports (assertable in tests; also useful for a one-off backfill's own log line). */
export interface SystemDashboardSeedResult {
  /** `base_key`s a NEW system-authored dashboard was created for this call (empty on a full no-op). */
  readonly created: readonly string[];
  /** `base_key`s that already had a system-authored dashboard (the steady-state case after the first). */
  readonly alreadyPresent: readonly string[];
}

export interface DashboardSeeder {
  /**
   * Ensure the org has a system-authored, org-shared dashboard for every currently-active report base.
   * `ownerMembershipId` is the membership that triggered this call (the invitation-accepting user) —
   * whichever member happens to accept first becomes the dashboards' nominal owner; the dashboards
   * remain visible to the whole org regardless (`share_scope='org'`), and the `authorship='system'`
   * column is what a UI should read to say "platform-shipped" rather than the owner field.
   */
  ensureSystemDashboards(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly ownerMembershipId: string;
  }): Promise<SystemDashboardSeedResult>;
}

/** One dashboard's full spec, derived from the base catalog row rather than hand-duplicated. */
function specFor(base: schema.ReportBaseCatalog): schema.ReportDefinitionSpec {
  return {
    dimensions: base.dimensions.map((d) => ({ dimensionKey: d.dimensionKey })),
    measures: base.measures.map((m) => ({ measureKey: m.measureKey })),
    filters: [],
  };
}

export function createDbSystemDashboardSeeder(db: DbClient): DashboardSeeder {
  return {
    async ensureSystemDashboards({ organizationId, userId, ownerMembershipId }) {
      return withOrgContext(db, { organizationId, userId }, async (tx) => {
        const catalog = new ReportCatalogRepository(tx);
        const definitions = new ReportDefinitionRepository(tx);
        const views = new ReportViewRepository(tx);

        const activeBases = await catalog.listBases("active");
        const created: string[] = [];
        const alreadyPresent: string[] = [];
        const now = new Date();

        for (const base of activeBases) {
          const [inserted] = await tx
            .insert(schema.reportDefinition)
            .values({
              organizationId,
              authorship: "system",
              baseKey: base.baseKey,
              ownerMembershipId: null,
              displayName: base.displayName,
              description: base.description,
              versionSeq: 0,
              status: "draft",
            })
            .onConflictDoNothing()
            .returning();

          if (!inserted) {
            alreadyPresent.push(base.baseKey);
            continue;
          }

          const version = await definitions.createVersion({
            definitionId: inserted.id,
            organizationId,
            versionNumber: 1,
            spec: specFor(base),
            status: "published",
            publishedAt: now,
            publishedByMembershipId: ownerMembershipId,
            createdByMembershipId: ownerMembershipId,
          });

          await tx
            .update(schema.reportDefinition)
            .set({ status: "published", latestVersionId: version.id, versionSeq: 1 })
            .where(eq(schema.reportDefinition.id, inserted.id));

          await views.create({
            organizationId,
            definitionVersionId: version.id,
            ownerMembershipId,
            displayName: base.displayName,
            pinnedFilters: [],
            shareScope: "org",
            shareRoleKeys: null,
            isOrgDefault: false,
            status: "active",
          });

          created.push(base.baseKey);
        }

        return { created, alreadyPresent };
      });
    },
  };
}
