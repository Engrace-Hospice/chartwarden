// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/config-store.ts — `tenant_clearinghouse_config` over ONE
// open org-scoped transaction (the caller's `withOrgContext`; RLS scopes every statement to that tenant). The service
// takes a `ConfigStore` so its rules are tested without a database; this is the Drizzle implementation.
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";

const C = schema.tenantClearinghouseConfig;
const A = schema.clearinghouseSubmissionAttempts;
const R = schema.tenantClearinghouseCredentialReservation;

export type ConfigRow = schema.TenantClearinghouseConfigRow;

/** A fingerprint to reserve, with the public id of its key (null: recorded before migration 1405). */
export interface HeldFingerprint {
  readonly keyId: string | null;
  readonly fingerprint: string;
}
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
  /** How many unreleased reservations the org holds (each credential has one per fingerprint key it was saved under). */
  heldReservationCount(organizationId: string): Promise<number>;
  /**
   * Reserve the fingerprint to the org. False when an unreleased reservation of it already exists (another org's, which RLS hides,
   * or this org's from a concurrent save): `ON CONFLICT DO NOTHING` on the cross-organization index, so the transaction stays
   * usable for the caller to tell the two apart.
   */
  reserveCredential(
    organizationId: string,
    vendor: string,
    fingerprint: HeldFingerprint,
  ): Promise<boolean>;
  /** Release every reservation the org holds EXCEPT the `keep` fingerprints (its current credential's); how many were released. */
  releaseCredentials(
    organizationId: string,
    keep: readonly string[],
    release: { readonly userId: string; readonly reason: string; readonly at: Date },
  ): Promise<number>;
}

export const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The audited platform-context job the boot check runs as (registered at boot beside the other platform jobs). */
export const M23_PLATFORM_CREDENTIAL_CHECK_JOB_ID = "m23.clearinghouse.platform-credential-check";

/**
 * The boot check, on the platform carrier through the gated, audited `withPlatformContext` (migration 1405's column grant: id,
 * fingerprint, key id, released_at), across every organization:
 *   - `held`: how many unreleased reservations hold one of `fingerprints` (a platform vendor key changed to one a tenant sealed);
 *   - `keyIds`: the distinct key ids unreleased reservations were computed under, so a KEK change made without listing the old KEK
 *     as retired is caught (security review MEDIUM-1): such a key id is neither current nor retired, and its reservations no longer
 *     collide with anything.
 */
export async function checkHeldCredentials(
  deps: {
    readonly platformDb: DbClient;
    readonly auditBypass: PlatformBypassAuditor<DbClient>;
  },
  fingerprints: readonly string[],
): Promise<{ readonly held: number; readonly keyIds: readonly string[] }> {
  return withPlatformContext<DbClient, { held: number; keyIds: string[] }>(
    deps.platformDb,
    {
      jobId: M23_PLATFORM_CREDENTIAL_CHECK_JOB_ID,
      reason:
        "M23 boot check: no tenant holds the platform's own clearinghouse key, and every held fingerprint is under a configured key",
      crossTenant: true,
    },
    deps.auditBypass,
    async (tx) => {
      const held =
        fingerprints.length === 0
          ? []
          : await tx
              .select({ id: R.id })
              .from(R)
              .where(
                and(inArray(R.credentialFingerprint, [...fingerprints]), isNull(R.releasedAt)),
              );
      const keyIds = await tx
        .selectDistinct({ keyId: R.credentialFingerprintKeyId })
        .from(R)
        .where(and(isNull(R.releasedAt), isNotNull(R.credentialFingerprintKeyId)));
      return {
        held: held.length,
        keyIds: keyIds.flatMap((r) => (r.keyId === null ? [] : [r.keyId])),
      };
    },
  );
}

/** The held key ids that are neither the current fingerprint key nor a configured retired one (ids only, never keys). */
export const unknownFingerprintKeyIds = (
  held: readonly string[],
  configured: readonly string[],
): string[] => held.filter((id) => !configured.includes(id));

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
    async heldReservationCount(organizationId) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(R)
        .where(and(eq(R.organizationId, organizationId), isNull(R.releasedAt)));
      return Number(row?.n ?? 0);
    },
    async reserveCredential(organizationId, vendor, fingerprint) {
      const inserted = await tx
        .insert(R)
        .values({
          organizationId,
          vendor,
          credentialFingerprint: fingerprint.fingerprint,
          credentialFingerprintKeyId: fingerprint.keyId,
        })
        .onConflictDoNothing({ target: R.credentialFingerprint, where: sql`released_at IS NULL` })
        .returning({ id: R.id });
      return inserted.length > 0;
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
            keep.length === 0 ? sql`true` : notInArray(R.credentialFingerprint, [...keep]),
          ),
        )
        .returning({ id: R.id });
      return rows.length;
    },
  };
}
