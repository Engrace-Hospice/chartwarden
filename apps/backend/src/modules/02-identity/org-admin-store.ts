// apps/backend/src/modules/02-identity/org-admin-store.ts — the data port + Drizzle/in-memory implementations
// behind the GAP-115 org-admin routes.
//
// SPLIT BY OWNER. `organization` is M2's to manage (see `tenant-org-creation-provider.ts`), so its reads/writes
// are implemented here. `provider_entity` and `location` are M1-owned tables: M2 serves the routes but reaches
// them through M1's `SiteAdminRepository` (`bootstrap/site-admin-repository.ts`) rather than its Drizzle schema
// (arch:tables). {@link OrgAdminStore} is simply the two halves behind one port the routes depend on.
import { type DbClient, schema } from "@wardenx/db";
import { asc, eq, ilike, or } from "drizzle-orm";
import {
  type LocationDetail,
  type ProviderEntityDetail,
  type SiteAdminRepository,
  type UniqueConflict,
  createDrizzleSiteAdminRepository,
  createInMemorySiteAdminRepository,
  uniqueConflictOf,
} from "../../bootstrap/site-admin-repository";

export type {
  LifecycleStatus,
  LocationDetail,
  LocationPatch,
  NewLocation,
  NewProviderEntity,
  ProviderEntityDetail,
  ProviderEntityPatch,
  UniqueConflict,
} from "../../bootstrap/site-admin-repository";

export interface OrganizationView {
  readonly id: string;
  readonly slug: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrgAdminStore extends SiteAdminRepository {
  listOrganizations(q: { q?: string; limit: number; offset: number }): Promise<OrganizationView[]>;
  getOrganization(id: string): Promise<OrganizationView | null>;
  createOrganization(input: {
    slug: string;
    legalName: string;
    displayName: string;
    createdByUserId: string;
  }): Promise<OrganizationView | UniqueConflict>;
  updateOrganization(
    id: string,
    patch: { legalName?: string; displayName?: string },
  ): Promise<OrganizationView | null>;
}

const O = schema.organizations;

const toOrg = (r: typeof O.$inferSelect): OrganizationView => ({
  id: r.id,
  slug: r.slug,
  legalName: r.legalName,
  displayName: r.displayName,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** `organization` is the tenancy root (NON_ORG_SCOPED): a by-id lookup spans tenants on the plain handle. */
export function createDrizzleOrgAdminStore(
  db: DbClient,
  sites?: SiteAdminRepository,
): OrgAdminStore {
  const siteRepo = sites ?? createDrizzleSiteAdminRepository(db);
  return {
    ...siteRepo,
    async listOrganizations({ q, limit, offset }) {
      const rows = await db
        .select()
        .from(O)
        .where(
          q
            ? or(
                ilike(O.displayName, `%${q}%`),
                ilike(O.legalName, `%${q}%`),
                ilike(O.slug, `%${q}%`),
              )
            : undefined,
        )
        .orderBy(asc(O.displayName), asc(O.id))
        .limit(limit)
        .offset(offset);
      return rows.map(toOrg);
    },
    async getOrganization(id) {
      const [row] = await db.select().from(O).where(eq(O.id, id)).limit(1);
      return row ? toOrg(row) : null;
    },
    async createOrganization(input) {
      try {
        const [row] = await db
          .insert(O)
          .values({
            slug: input.slug,
            legalName: input.legalName,
            displayName: input.displayName,
            createdBy: input.createdByUserId,
          })
          .returning();
        return toOrg(row as typeof O.$inferSelect);
      } catch (err) {
        if (uniqueConflictOf(err) === "slug") return { conflict: "slug" };
        throw err;
      }
    },
    async updateOrganization(id, patch) {
      const [row] = await db
        .update(O)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(O.id, id))
        .returning();
      return row ? toOrg(row) : null;
    },
  };
}

/** In-memory store (route tests + a no-DB slice boot). Same contract; enforces the same unique keys. */
export function createInMemoryOrgAdminStore(
  seed: { organizations?: OrganizationView[]; providerEntities?: ProviderEntityDetail[] } = {},
): OrgAdminStore & {
  state: {
    orgs: Map<string, OrganizationView>;
    pes: Map<string, ProviderEntityDetail>;
    locs: Map<string, LocationDetail>;
  };
} {
  const orgs = new Map((seed.organizations ?? []).map((o) => [o.id, o]));
  const sites = createInMemorySiteAdminRepository(seed.providerEntities ?? []);
  const now = () => new Date().toISOString();
  return {
    ...sites,
    state: { orgs, pes: sites.pes, locs: sites.locs },
    async listOrganizations({ q, limit, offset }) {
      return [...orgs.values()]
        .filter(
          (o) =>
            !q ||
            `${o.displayName} ${o.legalName} ${o.slug}`.toLowerCase().includes(q.toLowerCase()),
        )
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .slice(offset, offset + limit);
    },
    async getOrganization(id) {
      return orgs.get(id) ?? null;
    },
    async createOrganization(input) {
      if ([...orgs.values()].some((o) => o.slug === input.slug)) return { conflict: "slug" };
      const org: OrganizationView = {
        id: crypto.randomUUID(),
        slug: input.slug,
        legalName: input.legalName,
        displayName: input.displayName,
        status: "created",
        createdAt: now(),
        updatedAt: now(),
      };
      orgs.set(org.id, org);
      return org;
    },
    async updateOrganization(id, patch) {
      const cur = orgs.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: now() };
      orgs.set(id, next);
      return next;
    },
  };
}
