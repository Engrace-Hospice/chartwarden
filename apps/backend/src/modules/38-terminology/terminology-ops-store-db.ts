// apps/backend/src/modules/38-terminology/terminology-ops-store-db.ts — the production
// {@link TerminologyOpsStore} over Drizzle (GAP-063).
//
// TENANCY, three shapes:
//   • The catalog / deprecation / load-history reads hit platform-shared reference tables whose 0015
//     policy is `FOR SELECT TO chartwarden_app USING (true)`. They run on the pooled handle with NO org
//     context — there is no tenant dimension to scope (`code_system_version` et al. carry no
//     organization_id), and wrapping them in `withOrgContext` would suggest one exists.
//   • The two WRITES call the migration-0206 `terminology_loader` SECURITY DEFINER functions.
//     `chartwarden_app` has no INSERT/UPDATE grant on any canonical table (§7.4) and must never get one,
//     so `db.execute(sql\`SELECT * FROM terminology_loader_…\`)` is the whole write surface.
//   • The governance view calls `terminology_admin_list_value_set_extensions`, a definer function, for
//     the same reason inverted: `value_set_tenant_extension` IS org-scoped, so a cross-tenant read on
//     the tenant pool would be silently narrowed to the operator's own org by the RLS policy.
//
// ⚠️ `db.execute` returns every timestamptz as a STRING, not a Date (WX-PR-024). The row mappers below
// therefore normalise with `String(...)` rather than calling `.toISOString()` on a value that is not a
// Date at runtime and only looks like one to the type-checker.
import { type DbClient, schema } from "@chartwarden/db";
import type { CodeSystemId } from "@chartwarden/terminology";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { rethrowRefusal } from "./db-errors";
import type {
  EmbeddingRefreshResult,
  LicenseAttestationEntry,
  RecordAttestationInput,
  RegisterVersionInput,
  RegisterVersionResult,
  SystemAttribution,
  SystemDeprecation,
  TenantExtensionGovernanceQuery,
  TenantExtensionGovernanceRow,
  TerminologyLoadHistoryEntry,
  TerminologyOpsStore,
  ValueSetCatalogEntry,
} from "./ops-store";

const VS = schema.valueSets;
const DEP = schema.deprecationMapping;
const LOG = schema.terminologyUpdateLog;
const VER = schema.codeSystemVersions;
const ATT = schema.terminologyLicenseAttestations;

/** Normalise a driver value that is a `timestamptz` (Date via the query builder, string via `execute`). */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
/** Same, nullable. */
const isoN = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

/** A `SELECT * FROM fn(...)` result row — `db.execute` hands back `{ rows: [...] }` on node-postgres. */
type ExecRow = Record<string, unknown>;
const rowsOf = (result: unknown): ExecRow[] => {
  const r = result as { rows?: ExecRow[] } | ExecRow[];
  return Array.isArray(r) ? r : (r.rows ?? []);
};

function toAttestationEntry(r: typeof ATT.$inferSelect): LicenseAttestationEntry {
  return {
    id: r.id,
    systemId: r.systemId,
    licensee: r.licensee,
    licenseReference: r.licenseReference,
    attestedBy: r.attestedBy,
    attestedAt: iso(r.attestedAt),
    effectiveFrom: String(r.effectiveFrom),
    effectiveTo: r.effectiveTo === null ? null : String(r.effectiveTo),
    attributionText: r.attributionText,
    revokedAt: isoN(r.revokedAt),
  };
}

/** Build the production {@link TerminologyOpsStore}. */
export function createDbTerminologyOpsStore(db: DbClient): TerminologyOpsStore {
  return {
    async listValueSets(): Promise<readonly ValueSetCatalogEntry[]> {
      const rows = await db
        .select({
          id: VS.id,
          name: VS.name,
          description: VS.description,
          scope: VS.scope,
          updatedAt: VS.updatedAt,
        })
        .from(VS)
        .orderBy(asc(VS.id));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        scope: r.scope,
        updatedAt: iso(r.updatedAt),
      }));
    },

    async deprecationsSince(since, system): Promise<readonly SystemDeprecation[]> {
      const rows = await db
        .select({
          systemId: DEP.systemId,
          deprecatedCode: DEP.deprecatedCode,
          deprecationEffective: DEP.deprecationEffective,
          successorCodes: DEP.successorCodes,
          mappingKind: DEP.mappingKind,
          guidance: DEP.guidance,
        })
        .from(DEP)
        .where(
          and(
            gte(DEP.deprecationEffective, since),
            system === undefined ? undefined : eq(DEP.systemId, system),
          ),
        )
        .orderBy(desc(DEP.deprecationEffective), asc(DEP.deprecatedCode));
      return rows.map((r) => ({
        systemId: r.systemId,
        deprecatedCode: r.deprecatedCode,
        deprecationEffective: r.deprecationEffective,
        successorCodes: r.successorCodes,
        mappingKind: r.mappingKind,
        guidance: r.guidance,
      }));
    },

    async loadHistory({ system, limit }): Promise<readonly TerminologyLoadHistoryEntry[]> {
      // LEFT JOIN: `terminology_update_log.version_id` is nullable (a tenant-extension entry has no
      // version), so an INNER JOIN would silently drop rows the history page is supposed to show.
      const rows = await db
        .select({
          logId: LOG.id,
          systemId: LOG.systemId,
          versionId: LOG.versionId,
          version: VER.version,
          versionStatus: VER.status,
          action: LOG.action,
          conceptCount: LOG.conceptCount,
          newCodes: LOG.newCodes,
          retiredCodes: LOG.retiredCodes,
          affectedValueSets: LOG.affectedValueSets,
          summary: LOG.summary,
          at: LOG.at,
        })
        .from(LOG)
        .leftJoin(VER, eq(VER.id, LOG.versionId))
        .where(system === undefined ? undefined : eq(LOG.systemId, system))
        .orderBy(desc(LOG.at))
        .limit(limit);
      return rows.map((r) => ({
        logId: r.logId,
        systemId: r.systemId,
        versionId: r.versionId,
        version: r.version,
        versionStatus: r.versionStatus,
        action: r.action,
        conceptCount: r.conceptCount,
        newCodes: r.newCodes,
        retiredCodes: r.retiredCodes,
        affectedValueSets: r.affectedValueSets,
        summary: (r.summary ?? {}) as Record<string, unknown>,
        at: iso(r.at),
      }));
    },

    async registerVersion(input: RegisterVersionInput): Promise<RegisterVersionResult> {
      const result = await db
        .execute(sql`
        SELECT version_id, created, status
        FROM terminology_loader_register_version(
          ${input.system}::code_system_id,
          ${input.version},
          ${input.sourceFileRef},
          ${input.checksum},
          ${input.releasedOn}::date,
          ${input.effectiveFrom}::date,
          ${input.loadedBy}::uuid
        )
      `)
        .catch(rethrowRefusal);
      const row = rowsOf(result)[0];
      if (!row) throw new Error("terminology_loader_register_version returned no row");
      return {
        versionId: String(row.version_id),
        created: row.created === true,
        status: String(row.status),
      };
    },

    async requestEmbeddingRefresh(
      system: CodeSystemId,
      requestedBy: string,
    ): Promise<EmbeddingRefreshResult> {
      const result = await db.execute(sql`
        SELECT version_id, logged
        FROM terminology_loader_request_embedding_refresh(
          ${system}::code_system_id,
          ${requestedBy}::uuid
        )
      `);
      const row = rowsOf(result)[0];
      if (!row) throw new Error("terminology_loader_request_embedding_refresh returned no row");
      return {
        versionId: row.version_id === null ? null : String(row.version_id),
        logged: row.logged === true,
      };
    },

    async listTenantExtensions(
      query: TenantExtensionGovernanceQuery,
    ): Promise<readonly TenantExtensionGovernanceRow[]> {
      // The keyset cursor is the opaque `${createdAt}|${id}` the route round-trips; a malformed cursor
      // degrades to "first page" rather than erroring — it can only ever narrow what the caller sees.
      const [afterAt, afterId] = (query.cursor ?? "").split("|");
      const result = await db.execute(sql`
        SELECT extension_id, value_set_id, organization_id, system_id, code, reason,
               added_by, removed_at, created_at
        FROM terminology_admin_list_value_set_extensions(
          ${query.valueSetId ?? null},
          ${query.organizationId ?? null}::uuid,
          ${query.includeRemoved === true},
          ${query.limit ?? 100},
          ${afterAt ? afterAt : null}::timestamptz,
          ${afterId ? afterId : null}::uuid
        )
      `);
      return rowsOf(result).map((r) => ({
        extensionId: String(r.extension_id),
        valueSetId: String(r.value_set_id),
        organizationId: String(r.organization_id),
        systemId: String(r.system_id) as CodeSystemId,
        code: String(r.code),
        reason: String(r.reason),
        addedBy: r.added_by === null ? null : String(r.added_by),
        removedAt: isoN(r.removed_at),
        createdAt: iso(r.created_at),
      }));
    },

    async listLicenseAttestations(system): Promise<readonly LicenseAttestationEntry[]> {
      const rows = await db
        .select()
        .from(ATT)
        .where(system === undefined ? undefined : eq(ATT.systemId, system))
        .orderBy(desc(ATT.attestedAt));
      return rows.map(toAttestationEntry);
    },

    async recordLicenseAttestation(input: RecordAttestationInput) {
      const result = await db
        .execute(sql`
        SELECT terminology_loader_record_license_attestation(
          ${input.system}::code_system_id, ${input.licensee}, ${input.licenseReference},
          ${input.attestedBy}::uuid, ${input.effectiveFrom}::date, ${input.effectiveTo}::date,
          ${input.attributionText}
        ) AS id
      `)
        .catch(rethrowRefusal);
      const row = rowsOf(result)[0];
      if (!row) throw new Error("terminology_loader_record_license_attestation returned no row");
      return { attestationId: String(row.id) };
    },

    async revokeLicenseAttestation(attestationId, revokedBy) {
      const result = await db.execute(sql`
        SELECT terminology_loader_revoke_license_attestation(${attestationId}::uuid, ${revokedBy}::uuid) AS revoked
      `);
      return rowsOf(result)[0]?.revoked === true;
    },

    async activeAttributions(): Promise<readonly SystemAttribution[]> {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await db
        .select({
          systemId: ATT.systemId,
          licensee: ATT.licensee,
          attributionText: ATT.attributionText,
          from: ATT.effectiveFrom,
        })
        .from(ATT)
        .where(
          and(
            isNull(ATT.revokedAt),
            lte(ATT.effectiveFrom, today),
            or(isNull(ATT.effectiveTo), gte(ATT.effectiveTo, today)),
          ),
        )
        .orderBy(desc(ATT.effectiveFrom));
      // Newest attestation per system wins (rows are ordered newest first).
      const newest = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!newest.has(r.systemId)) newest.set(r.systemId, r);
      return [...newest.values()].map((r) => ({
        systemId: r.systemId,
        licensee: r.licensee,
        attributionText: r.attributionText,
      }));
    },
  };
}
