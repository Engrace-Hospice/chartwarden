// apps/backend/src/modules/29-external-interfaces/listener/feed-loader.ts — GAP-086. The supervisor's two feed reads
// (§4.11.1 step 1 + the `activated` hot-reload), over Drizzle.
//
// `external_feed` is tenant-scoped under FORCEd RLS, so a cross-tenant "every active inbound feed" read cannot run on
// the tenant pool without an org context. Rather than widen the platform login role's grants, the active ORG list comes
// from the allowlisted platform enumerator (`M29_PLATFORM_JOB_ID`) and each org's feeds are then read on the TENANT pool
// inside that org's own `withOrgContext` — the same shape the outbound retry-sweep fan-out uses.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray } from "drizzle-orm";

import { type SupervisorFeedDescriptor, feedBindsInboundListener } from "./supervisor";

const FEED = schema.externalFeed;
const SYSTEM_USER_ID = "";

export interface FeedLoaderDeps {
  readonly db: DbClient;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
}

type FeedRow = typeof FEED.$inferSelect;

export function toDescriptor(row: FeedRow): SupervisorFeedDescriptor {
  return {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    displayName: row.displayName,
    port: row.port,
    protocol: row.protocol,
    status: row.status,
    baaContractRef: row.baaContractRef,
    sendingFacilityAllowlist: row.sendingFacilityAllowlist,
  };
}

export function createDrizzleFeedLoader(deps: FeedLoaderDeps): {
  loadActiveInboundFeeds(): Promise<readonly SupervisorFeedDescriptor[]>;
  loadFeedById(feedId: string, organizationId?: string): Promise<SupervisorFeedDescriptor | null>;
} {
  const readOrg = (organizationId: string, where: ReturnType<typeof and>) =>
    withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
      (tx as DbClient).select().from(FEED).where(where),
    );

  return {
    async loadActiveInboundFeeds() {
      const orgs = await deps.activeOrgs.listActiveOrgs();
      const feeds: SupervisorFeedDescriptor[] = [];
      for (const { organizationId } of orgs) {
        const rows = await readOrg(
          organizationId,
          and(
            eq(FEED.organizationId, organizationId),
            eq(FEED.status, "active"),
            inArray(FEED.kind, ["adt_inbound", "lab_inbound"]),
          ),
        );
        feeds.push(...rows.map(toDescriptor).filter((f) => feedBindsInboundListener(f.kind)));
      }
      return feeds;
    },

    async loadFeedById(feedId, organizationId) {
      const orgs = organizationId ? [{ organizationId }] : await deps.activeOrgs.listActiveOrgs();
      for (const { organizationId: orgId } of orgs) {
        const rows = await readOrg(orgId, and(eq(FEED.organizationId, orgId), eq(FEED.id, feedId)));
        if (rows[0]) return toDescriptor(rows[0]);
      }
      return null;
    },
  };
}
