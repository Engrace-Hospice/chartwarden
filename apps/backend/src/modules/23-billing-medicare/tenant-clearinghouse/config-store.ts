// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/config-store.ts — `tenant_clearinghouse_config` over ONE
// open org-scoped transaction (the caller's `withOrgContext`; RLS scopes every statement to that tenant). The service
// takes a `ConfigStore` so its rules are tested without a database; this is the Drizzle implementation.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";

const C = schema.tenantClearinghouseConfig;
const A = schema.clearinghouseSubmissionAttempts;
const R = schema.tenantClearinghouseCredentialReservation;

export type ConfigRow = schema.TenantClearinghouseConfigRow;
export type NewConfigRow = Omit<schema.NewTenantClearinghouseConfigRow, "id" | "createdAt">;
/** Every column an update may touch (the migration's column-level UPDATE grant). */
export type ConfigPatch = Partial<Omit<ConfigRow, "id" | "organizationId" | "createdAt">>;

export interface ConfigStore {
  /**
   * The open org-scoped transaction this store reads and writes on; absent on the in-memory store. A rule that must read another
   * table while the config row is locked reads it on THIS transaction, never on a second pooled connection (re-review L5: a pool
   * drained by requests that each hold one connection and wait for another deadlocks the service).
   */
  readonly tx?: DbClient;
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
  /**
   * True when the org's vendor responses may still be arriving: a production submission still `reserved`, or one reserved at or
   * after `since` (a `sent` attempt is final, so its reservation time is the only clock the attempt row carries).
   */
  hasRecentProductionAttempts(organizationId: string, since: Date): Promise<boolean>;
  /** True when THIS org already holds an unreleased reservation of the fingerprint (migration 1404). */
  holdsCredential(organizationId: string, fingerprint: string): Promise<boolean>;
  /** Reserve the fingerprint to the org; a unique violation when another org (or this one) already holds it. */
  reserveCredential(organizationId: string, vendor: string, fingerprint: string): Promise<void>;
  /** Release every reservation the org holds EXCEPT `keep` (its current credential); how many were released. */
  releaseCredentials(
    organizationId: string,
    keep: string | null,
    release: { readonly userId: string; readonly reason: string; readonly at: Date },
  ): Promise<number>;
}

export const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/**
 * How many unreleased reservations hold one of `fingerprints`, across every organization. Boot only, on the platform carrier
 * (BYPASSRLS): it detects a platform vendor key that was changed to one a tenant had already sealed.
 */
export async function countHeldCredentials(
  platformDb: DbClient,
  fingerprints: readonly string[],
): Promise<number> {
  if (fingerprints.length === 0) return 0;
  const rows = await platformDb
    .select({ id: R.id })
    .from(R)
    .where(and(inArray(R.credentialFingerprint, [...fingerprints]), isNull(R.releasedAt)));
  return rows.length;
}

/** The Drizzle store over a transaction already scoped to the org (the tenant's own, or a platform operator's on its behalf). */
export function createDrizzleConfigStore(tx: DbClient): ConfigStore {
  return {
    tx,
    async findForUpdate(organizationId) {
      const [row] = await tx
        .select()
        .from(C)
        .where(eq(C.organizationId, organizationId))
        .for("update");
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
    async hasRecentProductionAttempts(organizationId, since) {
      const [hit] = await tx
        .select({ id: A.id })
        .from(A)
        .where(
          and(
            eq(A.organizationId, organizationId),
            eq(A.usage, "production"),
            or(eq(A.status, "reserved"), and(eq(A.status, "sent"), gte(A.reservedAt, since))),
          ),
        )
        .limit(1);
      return hit !== undefined;
    },
    async holdsCredential(organizationId, fingerprint) {
      const [hit] = await tx
        .select({ id: R.id })
        .from(R)
        .where(
          and(
            eq(R.organizationId, organizationId),
            eq(R.credentialFingerprint, fingerprint),
            isNull(R.releasedAt),
          ),
        )
        .limit(1);
      return hit !== undefined;
    },
    async reserveCredential(organizationId, vendor, fingerprint) {
      await tx.insert(R).values({ organizationId, vendor, credentialFingerprint: fingerprint });
    },
    async releaseCredentials(organizationId, keep, release) {
      const rows = await tx
        .update(R)
        .set({
          releasedAt: release.at,
          releasedByUserId: release.userId,
          releaseReason: release.reason,
          updatedAt: release.at,
        })
        .where(
          and(
            eq(R.organizationId, organizationId),
            isNull(R.releasedAt),
            keep === null ? sql`true` : ne(R.credentialFingerprint, keep),
          ),
        )
        .returning({ id: R.id });
      return rows.length;
    },
  };
}
