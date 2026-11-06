// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/config-store.ts — `tenant_clearinghouse_config` over ONE
// open org-scoped transaction (the caller's `withOrgContext`; RLS scopes every statement to that tenant). The service
// takes a `ConfigStore` so its rules are tested without a database; this is the Drizzle implementation.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";

const C = schema.tenantClearinghouseConfig;
const A = schema.clearinghouseSubmissionAttempts;

export type ConfigRow = schema.TenantClearinghouseConfigRow;
export type NewConfigRow = Omit<schema.NewTenantClearinghouseConfigRow, "id" | "createdAt">;
/** Every column an update may touch (the migration's column-level UPDATE grant). */
export type ConfigPatch = Partial<Omit<ConfigRow, "id" | "organizationId" | "createdAt">>;

export interface ConfigStore {
  /** The org's row, locked for the rest of the transaction; null when it has none. */
  findForUpdate(organizationId: string): Promise<ConfigRow | null>;
  find(organizationId: string): Promise<ConfigRow | null>;
  insert(row: NewConfigRow): Promise<ConfigRow>;
  /** Compare-and-set on `version`; null when another writer moved it first. */
  update(
    organizationId: string,
    expectedVersion: number,
    patch: ConfigPatch,
  ): Promise<ConfigRow | null>;
  /** True while the org has a production submission reserved or sent (its acknowledgments are still owed by the vendor). */
  hasProductionAttempts(organizationId: string): Promise<boolean>;
}

export const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The Drizzle store over a transaction already scoped to the org (the tenant's own, or a platform operator's on its behalf). */
export function createDrizzleConfigStore(tx: DbClient): ConfigStore {
  return {
    async findForUpdate(organizationId) {
      const [row] = await tx.select().from(C).where(eq(C.organizationId, organizationId)).for("update");
      return row ?? null;
    },
    async find(organizationId) {
      const [row] = await tx.select().from(C).where(eq(C.organizationId, organizationId)).limit(1);
      return row ?? null;
    },
    async insert(row) {
      const [created] = await tx.insert(C).values(row).returning();
      if (!created) throw new Error("tenant clearinghouse config insert returned no row");
      return created;
    },
    async update(organizationId, expectedVersion, patch) {
      const [row] = await tx
        .update(C)
        .set({ ...patch, version: expectedVersion + 1 })
        .where(and(eq(C.organizationId, organizationId), eq(C.version, expectedVersion)))
        .returning();
      return row ?? null;
    },
    async hasProductionAttempts(organizationId) {
      const [hit] = await tx
        .select({ id: A.id })
        .from(A)
        .where(
          and(
            eq(A.organizationId, organizationId),
            eq(A.usage, "production"),
            inArray(A.status, ["reserved", "sent"]),
          ),
        )
        .limit(1);
      return hit !== undefined;
    },
  };
}
