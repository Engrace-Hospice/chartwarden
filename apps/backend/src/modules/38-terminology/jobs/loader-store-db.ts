// apps/backend/src/modules/38-terminology/jobs/loader-store-db.ts — the production {@link LoaderStorePort} over
// Drizzle + the migration-0364 `terminology_loader_*` SECURITY DEFINER functions (GAP-108).
//
// Every WRITE is a function call: `chartwarden_app` has no INSERT/UPDATE grant on any canonical table (§7.4) and the
// worker connects as `chartwarden_app`, so `SELECT terminology_loader_…(…)` is the whole write surface — the functions
// run as the NOLOGIN `terminology_loader` role. Reads are plain selects (the platform-shared `USING (true)` policies).
// A deterministic refusal raised by a function (`TERMINOLOGY_<REASON>: …`) becomes a `LoaderDataError` so the
// orchestrator fails the version; any other error propagates and the job retries.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type ActivationSummary,
  type LicenseAttestation,
  type LoadableSystemId,
  LoaderDataError,
  type LoaderStorePort,
  type LoaderVersion,
  type PriorConcept,
  type StageSummary,
  type StagedRow,
  isLoadableSystem,
} from "@chartwarden/terminology-loader";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { isUniqueViolation, terminologyRefusalOf } from "../db-errors";

const VER = schema.codeSystemVersions;
const CS = schema.codeSystems;
const ATT = schema.terminologyLicenseAttestations;

type ExecRow = Record<string, unknown>;
const rowsOf = (result: unknown): ExecRow[] => {
  const r = result as { rows?: ExecRow[] } | ExecRow[];
  return Array.isArray(r) ? r : (r.rows ?? []);
};

/** Re-raise a function's deterministic refusal as a data error; anything else is infrastructure. */
function mapDbError(err: unknown): never {
  const refusal = terminologyRefusalOf(err);
  if (refusal) throw new LoaderDataError(refusal.code.replace(/^TERMINOLOGY_/, ""), refusal.detail);
  if (isUniqueViolation(err))
    throw new LoaderDataError("DUPLICATE_CODE", "a code appears twice in the source");
  throw err;
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    return mapDbError(err);
  }
}

function toVersion(r: typeof VER.$inferSelect): LoaderVersion {
  if (!isLoadableSystem(r.codeSystemId)) {
    throw new LoaderDataError("SYSTEM_NOT_LOADABLE", `${r.codeSystemId} has no loader`);
  }
  return {
    id: r.id,
    system: r.codeSystemId,
    version: r.version,
    status: r.status,
    sourceFileRef: r.sourceFileRef,
    checksum: r.checksum,
    effectiveFrom: String(r.effectiveFrom),
    releasedOn: String(r.releasedOn),
  };
}

/** JSON the function reads: snake_case keys, `null` for an absent date. */
const stagedJson = (rows: readonly StagedRow[]): string =>
  JSON.stringify(
    rows.map((r) => ({
      code: r.code,
      display: r.display,
      status: r.status,
      effective_date: r.effectiveDate,
      end_date: r.endDate,
      properties: r.properties,
    })),
  );

/** Build the production loader store. */
export function createDbLoaderStore(db: DbClient): LoaderStorePort {
  return {
    async getVersion(versionId) {
      const [row] = await db.select().from(VER).where(eq(VER.id, versionId)).limit(1);
      return row ? toVersion(row) : null;
    },

    stageRows(versionId, kind, rows, reset) {
      return call(async () => {
        const result = await db.execute(
          sql`SELECT terminology_loader_stage_concepts(${versionId}::uuid, ${kind}, ${stagedJson(rows)}::jsonb, ${reset}) AS n`,
        );
        return Number(rowsOf(result)[0]?.n ?? 0);
      });
    },

    markStaged(versionId, expectedConcepts): Promise<StageSummary> {
      return call(async () => {
        const result = await db.execute(
          sql`SELECT r_concepts, r_new, r_retired, r_changed FROM terminology_loader_mark_staged(${versionId}::uuid, ${expectedConcepts})`,
        );
        const row = rowsOf(result)[0];
        if (!row) throw new Error("terminology_loader_mark_staged returned no row");
        return {
          concepts: Number(row.r_concepts),
          newCodes: Number(row.r_new),
          retiredCodes: Number(row.r_retired),
          changedDisplays: Number(row.r_changed),
        };
      });
    },

    activate(versionId, activatedBy): Promise<ActivationSummary> {
      return call(async () => {
        const result = await db.execute(
          sql`SELECT r_concepts, r_new, r_retired, r_deprecations, r_prior FROM terminology_loader_activate_version(${versionId}::uuid, ${activatedBy}::uuid)`,
        );
        const row = rowsOf(result)[0];
        if (!row) throw new Error("terminology_loader_activate_version returned no row");
        return {
          concepts: Number(row.r_concepts),
          newCodes: Number(row.r_new),
          retiredCodes: Number(row.r_retired),
          deprecations: Number(row.r_deprecations),
          supersededVersionId: row.r_prior === null ? null : String(row.r_prior),
        };
      });
    },

    async fail(versionId, reason) {
      await db.execute(sql`SELECT terminology_loader_fail_version(${versionId}::uuid, ${reason})`);
    },

    async listActiveConcepts(system, excludeVersionId): Promise<readonly PriorConcept[]> {
      if (system !== "icd10cm") return [];
      const [prior] = await db
        .select({ id: VER.id })
        .from(VER)
        .where(
          and(
            eq(VER.codeSystemId, system),
            eq(VER.status, "active"),
            isNull(VER.effectiveTo),
            ne(VER.id, excludeVersionId),
          ),
        )
        .orderBy(desc(VER.effectiveFrom))
        .limit(1);
      if (!prior) return [];
      const T = schema.conceptIcd10cm;
      const rows = await db
        .select({ code: T.code, display: T.display, isBillableLeaf: T.isBillableLeaf })
        .from(T)
        .where(and(eq(T.versionId, prior.id), eq(T.status, "active")));
      return rows;
    },

    async latestVersion(system) {
      const [row] = await db
        .select()
        .from(VER)
        .where(eq(VER.codeSystemId, system))
        .orderBy(desc(VER.loadedAt))
        .limit(1);
      return row ? toVersion(row) : null;
    },

    async latestStagedVersion(system) {
      const [row] = await db
        .select()
        .from(VER)
        .where(and(eq(VER.codeSystemId, system), eq(VER.status, "staged")))
        .orderBy(desc(VER.effectiveFrom))
        .limit(1);
      return row ? toVersion(row) : null;
    },

    async licenseAttestations(system): Promise<readonly LicenseAttestation[]> {
      const rows = await db.select().from(ATT).where(eq(ATT.systemId, system));
      return rows.map((r) => ({
        id: r.id,
        system: r.systemId as LoadableSystemId,
        licensee: r.licensee,
        licenseReference: r.licenseReference,
        attestedBy: r.attestedBy,
        effectiveFrom: String(r.effectiveFrom),
        effectiveTo: r.effectiveTo === null ? null : String(r.effectiveTo),
        attributionText: r.attributionText,
        revokedAt: r.revokedAt === null ? null : r.revokedAt.toISOString(),
      }));
    },

    async licenseSource(system) {
      const [row] = await db
        .select({ source: CS.licenseSource })
        .from(CS)
        .where(eq(CS.id, system))
        .limit(1);
      if (!row)
        throw new LoaderDataError("UNKNOWN_SYSTEM", `${system} is not in the code_system catalog`);
      return row.source;
    },

    registerVersion(input) {
      return call(async () => {
        const result = await db.execute(sql`
          SELECT version_id, created, status FROM terminology_loader_register_version(
            ${input.system}::code_system_id, ${input.version}, ${input.sourceFileRef}, ${input.checksum},
            ${input.releasedOn}::date, ${input.effectiveFrom}::date, ${input.loadedBy}::uuid)`);
        const row = rowsOf(result)[0];
        if (!row) throw new Error("terminology_loader_register_version returned no row");
        return {
          versionId: String(row.version_id),
          created: row.created === true,
          status: String(row.status),
        };
      });
    },
  };
}
