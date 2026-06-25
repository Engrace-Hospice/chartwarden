// @wardenx/reporting · repositories — the report-definition aggregate: `report_definition` (the
// tenant-/system-authored definition bound to a base, carrying the optimistic-concurrency lock) +
// `report_definition_version` (the immutable spec snapshots; publish promotes one to `latest`) (M33
// §3.3–§3.4). One data port over the two tables of the authoring chain; the authoring SERVICE wraps
// these in `withOrgContext` and owns the legal-transition + version-bump guards.
import { schema } from "@wardenx/db";
import { and, desc, eq } from "drizzle-orm";
import type { ReportingDb } from "./db";

const D = schema.reportDefinition;
const V = schema.reportDefinitionVersion;

/** Data port for `report_definition` + `report_definition_version`. */
export class ReportDefinitionRepository {
  constructor(private readonly db: ReportingDb) {}

  // ── report_definition ───────────────────────────────────────────────────────────────────────

  /** Insert a new report definition (draft). Returns the inserted row. */
  async createDefinition(values: schema.NewReportDefinition): Promise<schema.ReportDefinition> {
    const [row] = await this.db.insert(D).values(values).returning();
    if (!row) throw new Error("report_definition insert returned no row");
    return row;
  }

  /** Fetch a definition by id, or `null`. */
  async findDefinitionById(id: string): Promise<schema.ReportDefinition | null> {
    const [row] = await this.db.select().from(D).where(eq(D.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * "List active tenant definitions" UI (§3.4 `report_definition_org_status_authorship_idx`): filter
   * by org + optional status + optional authorship.
   */
  async listDefinitions(
    organizationId: string,
    opts: {
      status?: schema.ReportDefinition["status"];
      authorship?: schema.ReportDefinition["authorship"];
      limit?: number;
    } = {},
  ): Promise<readonly schema.ReportDefinition[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const where = and(
      eq(D.organizationId, organizationId),
      opts.status ? eq(D.status, opts.status) : undefined,
      opts.authorship ? eq(D.authorship, opts.authorship) : undefined,
    );
    return this.db.select().from(D).where(where).orderBy(desc(D.createdAt)).limit(limit);
  }

  /** The "where used" admin surface (§3.4 `report_definition_base_status_idx`): definitions on a base. */
  async listDefinitionsByBase(
    baseKey: string,
    status?: schema.ReportDefinition["status"],
  ): Promise<readonly schema.ReportDefinition[]> {
    const where = and(eq(D.baseKey, baseKey), status ? eq(D.status, status) : undefined);
    return this.db.select().from(D).where(where).orderBy(desc(D.createdAt));
  }

  /**
   * Apply a definition patch (publish pointer / status / metadata) under an optimistic-concurrency
   * guard: the update only lands when the row's `version_seq` still matches `expectedVersionSeq`, and
   * it bumps the lock. Returns the updated row, or `null` on a stale-version miss (the service maps
   * that to a 409 retry).
   */
  async updateDefinition(
    id: string,
    expectedVersionSeq: number,
    patch: Partial<
      Pick<
        schema.NewReportDefinition,
        "status" | "latestVersionId" | "displayName" | "description" | "archivedAt"
      >
    >,
  ): Promise<schema.ReportDefinition | null> {
    const [row] = await this.db
      .update(D)
      .set({ ...patch, versionSeq: expectedVersionSeq + 1 })
      .where(and(eq(D.id, id), eq(D.versionSeq, expectedVersionSeq)))
      .returning();
    return row ?? null;
  }

  // ── report_definition_version ───────────────────────────────────────────────────────────────

  /** Insert a new (draft) version snapshot of a definition's spec. */
  async createVersion(
    values: schema.NewReportDefinitionVersion,
  ): Promise<schema.ReportDefinitionVersion> {
    const [row] = await this.db.insert(V).values(values).returning();
    if (!row) throw new Error("report_definition_version insert returned no row");
    return row;
  }

  /** Fetch a version by id, or `null`. */
  async findVersionById(id: string): Promise<schema.ReportDefinitionVersion | null> {
    const [row] = await this.db.select().from(V).where(eq(V.id, id)).limit(1);
    return row ?? null;
  }

  /** The latest version of a definition by `version_number` desc (§3.4 `..._def_version_idx`), or `null`. */
  async findLatestVersion(definitionId: string): Promise<schema.ReportDefinitionVersion | null> {
    const [row] = await this.db
      .select()
      .from(V)
      .where(eq(V.definitionId, definitionId))
      .orderBy(desc(V.versionNumber))
      .limit(1);
    return row ?? null;
  }

  /** All versions of a definition, newest version first. */
  async listVersions(definitionId: string): Promise<readonly schema.ReportDefinitionVersion[]> {
    return this.db
      .select()
      .from(V)
      .where(eq(V.definitionId, definitionId))
      .orderBy(desc(V.versionNumber));
  }

  /** The recent-edits audit surface (§3.4 `..._org_published_idx`): published versions newest-first. */
  async listRecentPublished(
    organizationId: string,
    limit = 50,
  ): Promise<readonly schema.ReportDefinitionVersion[]> {
    return this.db
      .select()
      .from(V)
      .where(eq(V.organizationId, organizationId))
      .orderBy(desc(V.publishedAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * Transition a version's status (publish / supersede), stamping the relevant timestamps + actor.
   * The legal-transition guard lives in the authoring service.
   */
  async updateVersionStatus(
    id: string,
    patch: Partial<
      Pick<
        schema.NewReportDefinitionVersion,
        "status" | "publishedAt" | "publishedByMembershipId" | "supersededAt"
      >
    >,
  ): Promise<schema.ReportDefinitionVersion> {
    const [row] = await this.db.update(V).set(patch).where(eq(V.id, id)).returning();
    if (!row) throw new Error(`report_definition_version ${id} not found for status update`);
    return row;
  }
}
