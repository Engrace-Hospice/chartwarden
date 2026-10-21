// apps/backend/src/bootstrap/site-admin-repository.ts — M1's repository over the tenancy-spine tables it owns
// that a tenant administrator manages: `provider_entity` and `location` (GAP-115; M2 §4.1 routes
// `/provider-entities` and `/locations`). M2 serves the routes but M1 owns the tables (arch:tables), so the
// writes live here and M2 reaches them through this port — the same split as `registerProviderEntityLookupRoutes`.
//
// TENANCY. `provider_entity` carries `organization_id`; `location` carries NO organization column and hangs off
// `provider_entity`. So every provider-entity statement names its `organization_id` and every location
// statement joins through its provider entity — the explicit predicate is the wall (the same posture as the
// read-only `/locations` lookup), run inside `withOrgContext` as the belt. The tax id is only ever WRITTEN
// here, already enveloped by the caller's cipher, and is never selected back.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

export type LifecycleStatus = "created" | "active" | "suspended" | "closed";

export interface ProviderEntityDetail {
  readonly id: string;
  readonly organizationId: string;
  readonly ccn: string;
  readonly legalName: string;
  readonly doingBusinessAs: string | null;
  readonly fiscalIntermediary: string | null;
  readonly npi: string;
  readonly fiscalYearEnd: string;
  readonly iqiesFacilityId: string | null;
  readonly status: LifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocationDetail {
  readonly id: string;
  readonly providerEntityId: string;
  readonly name: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly phone: string | null;
  readonly fax: string | null;
  readonly timezone: string;
  readonly status: LifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export type NewProviderEntity = Omit<
  ProviderEntityDetail,
  "organizationId" | "status" | "createdAt" | "updatedAt"
> & { readonly taxIdEncrypted: string };

export type ProviderEntityPatch = Writable<
  Partial<
    Pick<
      ProviderEntityDetail,
      "legalName" | "doingBusinessAs" | "fiscalIntermediary" | "iqiesFacilityId" | "status"
    >
  >
>;

export type NewLocation = Omit<LocationDetail, "id" | "status" | "createdAt" | "updatedAt">;
export type LocationPatch = Writable<
  Partial<Omit<NewLocation, "providerEntityId"> & { status: LifecycleStatus }>
>;

/** A unique-key collision, named so the route answers 409 with a specific code. */
export type UniqueConflict = { readonly conflict: "slug" | "ccn" | "npi" };

export interface SiteAdminRepository {
  getProviderEntity(organizationId: string, id: string): Promise<ProviderEntityDetail | null>;
  createProviderEntity(
    organizationId: string,
    input: NewProviderEntity,
  ): Promise<ProviderEntityDetail | UniqueConflict>;
  updateProviderEntity(
    organizationId: string,
    id: string,
    patch: ProviderEntityPatch,
  ): Promise<ProviderEntityDetail | null>;

  getLocation(organizationId: string, id: string): Promise<LocationDetail | null>;
  /** `null` when the provider entity is not this organization's. */
  createLocation(organizationId: string, input: NewLocation): Promise<LocationDetail | null>;
  updateLocation(
    organizationId: string,
    id: string,
    patch: LocationPatch,
  ): Promise<LocationDetail | null>;
}

const iso = (d: Date): string => d.toISOString();
const PE = schema.providerEntities;
const L = schema.locations;

const toPe = (r: typeof PE.$inferSelect): ProviderEntityDetail => ({
  id: r.id,
  organizationId: r.organizationId,
  ccn: r.ccn,
  legalName: r.legalName,
  doingBusinessAs: r.doingBusinessAs,
  fiscalIntermediary: r.fiscalIntermediary,
  npi: r.npi,
  fiscalYearEnd: r.fiscalYearEnd,
  iqiesFacilityId: r.iqiesFacilityId,
  status: r.status as LifecycleStatus,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const toLoc = (r: typeof L.$inferSelect): LocationDetail => ({
  id: r.id,
  providerEntityId: r.providerEntityId,
  name: r.name,
  addressLine1: r.addressLine1,
  addressLine2: r.addressLine2,
  city: r.city,
  state: r.state,
  postalCode: r.postalCode,
  phone: r.phone,
  fax: r.fax,
  timezone: r.timezone,
  status: r.status as LifecycleStatus,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

/** Which unique index a Postgres 23505 named. */
export function uniqueConflictOf(err: unknown): UniqueConflict["conflict"] | null {
  const e = err as {
    code?: string;
    constraint_name?: string;
    constraint?: string;
    message?: string;
  };
  if (e?.code !== "23505") return null;
  const name = `${e.constraint_name ?? e.constraint ?? ""} ${e.message ?? ""}`;
  if (name.includes("ccn")) return "ccn";
  if (name.includes("npi")) return "npi";
  if (name.includes("slug")) return "slug";
  return null;
}

export function createDrizzleSiteAdminRepository(db: DbClient): SiteAdminRepository {
  const scoped = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext<DbClient, T>(db, { organizationId, userId: "" }, fn);

  return {
    async getProviderEntity(organizationId, id) {
      return scoped(organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(PE)
          .where(and(eq(PE.id, id), eq(PE.organizationId, organizationId)))
          .limit(1);
        return row ? toPe(row) : null;
      });
    },
    async createProviderEntity(organizationId, input) {
      return scoped(organizationId, async (tx) => {
        try {
          const [row] = await tx
            .insert(PE)
            .values({
              id: input.id,
              organizationId,
              ccn: input.ccn,
              legalName: input.legalName,
              doingBusinessAs: input.doingBusinessAs,
              fiscalIntermediary: input.fiscalIntermediary,
              npi: input.npi,
              taxIdEncrypted: input.taxIdEncrypted,
              fiscalYearEnd: input.fiscalYearEnd,
              iqiesFacilityId: input.iqiesFacilityId,
            })
            .returning();
          return toPe(row as typeof PE.$inferSelect);
        } catch (err) {
          const conflict = uniqueConflictOf(err);
          if (conflict === "ccn" || conflict === "npi") return { conflict };
          throw err;
        }
      });
    },
    async updateProviderEntity(organizationId, id, patch) {
      return scoped(organizationId, async (tx) => {
        const [row] = await tx
          .update(PE)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(PE.id, id), eq(PE.organizationId, organizationId)))
          .returning();
        return row ? toPe(row) : null;
      });
    },

    async getLocation(organizationId, id) {
      return scoped(organizationId, async (tx) => {
        const [row] = await tx
          .select({ l: L })
          .from(L)
          .innerJoin(PE, eq(PE.id, L.providerEntityId))
          .where(and(eq(L.id, id), eq(PE.organizationId, organizationId)))
          .limit(1);
        return row ? toLoc(row.l) : null;
      });
    },
    async createLocation(organizationId, input) {
      return scoped(organizationId, async (tx) => {
        const [owner] = await tx
          .select({ id: PE.id })
          .from(PE)
          .where(and(eq(PE.id, input.providerEntityId), eq(PE.organizationId, organizationId)))
          .limit(1);
        if (!owner) return null;
        const [row] = await tx
          .insert(L)
          .values({ ...input })
          .returning();
        return toLoc(row as typeof L.$inferSelect);
      });
    },
    async updateLocation(organizationId, id, patch) {
      return scoped(organizationId, async (tx) => {
        const [owned] = await tx
          .select({ id: L.id })
          .from(L)
          .innerJoin(PE, eq(PE.id, L.providerEntityId))
          .where(and(eq(L.id, id), eq(PE.organizationId, organizationId)))
          .limit(1);
        if (!owned) return null;
        const [row] = await tx
          .update(L)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(L.id, id))
          .returning();
        return row ? toLoc(row) : null;
      });
    },
  };
}

/** In-memory repository (route tests + a no-DB slice boot). Same contract; enforces the same unique keys. */
export function createInMemorySiteAdminRepository(
  seed: ProviderEntityDetail[] = [],
): SiteAdminRepository & {
  pes: Map<string, ProviderEntityDetail>;
  locs: Map<string, LocationDetail>;
} {
  const pes = new Map(seed.map((p) => [p.id, p]));
  const locs = new Map<string, LocationDetail>();
  const now = () => new Date().toISOString();
  const repo: SiteAdminRepository & {
    pes: Map<string, ProviderEntityDetail>;
    locs: Map<string, LocationDetail>;
  } = {
    pes,
    locs,
    async getProviderEntity(organizationId, id) {
      const p = pes.get(id);
      return p && p.organizationId === organizationId ? p : null;
    },
    async createProviderEntity(organizationId, input) {
      const all = [...pes.values()];
      if (all.some((p) => p.ccn === input.ccn)) return { conflict: "ccn" };
      if (all.some((p) => p.npi === input.npi)) return { conflict: "npi" };
      const { taxIdEncrypted: _omitted, ...rest } = input;
      const pe: ProviderEntityDetail = {
        ...rest,
        organizationId,
        status: "created",
        createdAt: now(),
        updatedAt: now(),
      };
      pes.set(pe.id, pe);
      return pe;
    },
    async updateProviderEntity(organizationId, id, patch) {
      const cur = pes.get(id);
      if (!cur || cur.organizationId !== organizationId) return null;
      const next = { ...cur, ...patch, updatedAt: now() };
      pes.set(id, next);
      return next;
    },
    async getLocation(organizationId, id) {
      const l = locs.get(id);
      const p = l ? pes.get(l.providerEntityId) : undefined;
      return l && p && p.organizationId === organizationId ? l : null;
    },
    async createLocation(organizationId, input) {
      const p = pes.get(input.providerEntityId);
      if (!p || p.organizationId !== organizationId) return null;
      const loc: LocationDetail = {
        ...input,
        id: crypto.randomUUID(),
        status: "created",
        createdAt: now(),
        updatedAt: now(),
      };
      locs.set(loc.id, loc);
      return loc;
    },
    async updateLocation(organizationId, id, patch) {
      const cur = await repo.getLocation(organizationId, id);
      if (!cur) return null;
      const next = { ...cur, ...patch, updatedAt: now() } as LocationDetail;
      locs.set(id, next);
      return next;
    },
  };
  return repo;
}
