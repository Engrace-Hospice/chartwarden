// @wardenx/quality · repositories — the QAPI subdomain (CoP §418.58): `qapi_program` (the annual
// program, ≤1 per (org, plan_year)) and its children `qapi_indicator` (tracked indicators, soft-delete),
// `qapi_project` (improvement projects), `qapi_pip` (Performance Improvement Projects, dual-cosign
// closure), and `qapi_governance_minutes` (meeting minutes + append-only amendment log) (M30 §3.3).
// ORG-SCOPED; the QAPI service wraps these in `withOrgContext` and owns the lifecycle/cosign guards
// (the pure reducers live in @wardenx/quality). Several narrative columns are audit-denylisted (§3.6).
import { schema } from "@wardenx/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { QualityDb } from "./db";

const PG = schema.qapiProgram;
const IND = schema.qapiIndicator;
const PRJ = schema.qapiProject;
const PIP = schema.qapiPip;
const MIN = schema.qapiGovernanceMinutes;

/** Data port for the five QAPI tables (program · indicator · project · pip · minutes). */
export class QapiRepository {
  constructor(private readonly db: QualityDb) {}

  // ── qapi_program ───────────────────────────────────────────────────────────────────────────────

  async createProgram(values: schema.NewQapiProgram): Promise<schema.QapiProgram> {
    const [row] = await this.db.insert(PG).values(values).returning();
    if (!row) throw new Error("qapi_program insert returned no row");
    return row;
  }

  async findProgramById(id: string): Promise<schema.QapiProgram | null> {
    const [row] = await this.db.select().from(PG).where(eq(PG.id, id)).limit(1);
    return row ?? null;
  }

  /** The single program for a plan year (the V-8 unique surface), or `null`. */
  async findProgramByYear(
    organizationId: string,
    planYear: number,
  ): Promise<schema.QapiProgram | null> {
    const [row] = await this.db
      .select()
      .from(PG)
      .where(and(eq(PG.organizationId, organizationId), eq(PG.planYear, planYear)))
      .limit(1);
    return row ?? null;
  }

  /** An org's programs, newest plan year first. */
  async listPrograms(organizationId: string): Promise<readonly schema.QapiProgram[]> {
    return this.db
      .select()
      .from(PG)
      .where(eq(PG.organizationId, organizationId))
      .orderBy(desc(PG.planYear));
  }

  async updateProgram(
    id: string,
    patch: Partial<
      Pick<
        schema.NewQapiProgram,
        | "programDescription"
        | "governingBodyRoster"
        | "yearEndAttestation"
        | "closed"
        | "closedAt"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.QapiProgram> {
    const [row] = await this.db.update(PG).set(patch).where(eq(PG.id, id)).returning();
    if (!row) throw new Error(`qapi_program ${id} not found for update`);
    return row;
  }

  // ── qapi_indicator (soft-delete) ─────────────────────────────────────────────────────────────

  async createIndicator(values: schema.NewQapiIndicator): Promise<schema.QapiIndicator> {
    const [row] = await this.db.insert(IND).values(values).returning();
    if (!row) throw new Error("qapi_indicator insert returned no row");
    return row;
  }

  async findIndicatorById(id: string): Promise<schema.QapiIndicator | null> {
    const [row] = await this.db.select().from(IND).where(eq(IND.id, id)).limit(1);
    return row ?? null;
  }

  /** A program's live (non-soft-deleted) indicators, newest first. */
  async listIndicators(qapiProgramId: string): Promise<readonly schema.QapiIndicator[]> {
    return this.db
      .select()
      .from(IND)
      .where(and(eq(IND.qapiProgramId, qapiProgramId), isNull(IND.deletedAt)))
      .orderBy(desc(IND.createdAt));
  }

  async updateIndicator(
    id: string,
    patch: Partial<
      Pick<
        schema.NewQapiIndicator,
        | "indicatorName"
        | "dataPath"
        | "tenantTargetValue"
        | "baselineValue"
        | "baselineAt"
        | "trackingFrequency"
      >
    >,
  ): Promise<schema.QapiIndicator> {
    const [row] = await this.db.update(IND).set(patch).where(eq(IND.id, id)).returning();
    if (!row) throw new Error(`qapi_indicator ${id} not found for update`);
    return row;
  }

  /** Soft-delete an indicator (stamp `deleted_at`). Returns the deleted row. */
  async softDeleteIndicator(
    id: string,
    deletedAt: Date = new Date(),
  ): Promise<schema.QapiIndicator> {
    const [row] = await this.db
      .update(IND)
      .set({ deletedAt })
      .where(and(eq(IND.id, id), isNull(IND.deletedAt)))
      .returning();
    if (!row) throw new Error(`qapi_indicator ${id} not found (or already deleted)`);
    return row;
  }

  // ── qapi_project ─────────────────────────────────────────────────────────────────────────────

  async createProject(values: schema.NewQapiProject): Promise<schema.QapiProject> {
    const [row] = await this.db.insert(PRJ).values(values).returning();
    if (!row) throw new Error("qapi_project insert returned no row");
    return row;
  }

  async findProjectById(id: string): Promise<schema.QapiProject | null> {
    const [row] = await this.db.select().from(PRJ).where(eq(PRJ.id, id)).limit(1);
    return row ?? null;
  }

  /** A program's projects (optionally narrowed by status), newest first. */
  async listProjects(
    qapiProgramId: string,
    status?: schema.QapiProject["status"],
  ): Promise<readonly schema.QapiProject[]> {
    const where = and(
      eq(PRJ.qapiProgramId, qapiProgramId),
      status ? eq(PRJ.status, status) : undefined,
    );
    return this.db.select().from(PRJ).where(where).orderBy(desc(PRJ.createdAt));
  }

  /** An org's projects in a given status (e.g. `corrective_action` — the risk-register source, D13). */
  async listProjectsByStatus(
    organizationId: string,
    status: schema.QapiProject["status"],
  ): Promise<readonly schema.QapiProject[]> {
    return this.db
      .select()
      .from(PRJ)
      .where(and(eq(PRJ.organizationId, organizationId), eq(PRJ.status, status)))
      .orderBy(desc(PRJ.updatedAt));
  }

  async updateProject(
    id: string,
    patch: Partial<
      Pick<
        schema.NewQapiProject,
        | "title"
        | "goalText"
        | "ownerMembershipId"
        | "linkedIndicatorId"
        | "baselineValue"
        | "targetValue"
        | "timelineStart"
        | "timelineTargetEnd"
        | "status"
        | "outcomeText"
        | "abandonReason"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.QapiProject> {
    const [row] = await this.db.update(PRJ).set(patch).where(eq(PRJ.id, id)).returning();
    if (!row) throw new Error(`qapi_project ${id} not found for update`);
    return row;
  }

  // ── qapi_pip ─────────────────────────────────────────────────────────────────────────────────

  async createPip(values: schema.NewQapiPip): Promise<schema.QapiPip> {
    const [row] = await this.db.insert(PIP).values(values).returning();
    if (!row) throw new Error("qapi_pip insert returned no row");
    return row;
  }

  async findPipById(id: string): Promise<schema.QapiPip | null> {
    const [row] = await this.db.select().from(PIP).where(eq(PIP.id, id)).limit(1);
    return row ?? null;
  }

  /** A program's PIPs (optionally narrowed by status), newest first. */
  async listPips(
    qapiProgramId: string,
    status?: schema.QapiPip["status"],
  ): Promise<readonly schema.QapiPip[]> {
    const where = and(
      eq(PIP.qapiProgramId, qapiProgramId),
      status ? eq(PIP.status, status) : undefined,
    );
    return this.db.select().from(PIP).where(where).orderBy(desc(PIP.createdAt));
  }

  async updatePip(
    id: string,
    patch: Partial<
      Pick<
        schema.NewQapiPip,
        | "title"
        | "charterText"
        | "rootCauseAnalysisText"
        | "interventionPlanText"
        | "measurementPlanText"
        | "conclusionText"
        | "status"
        | "cosignQapiCoordinatorAt"
        | "cosignQapiCoordinatorMembershipId"
        | "cosignMedicalDirectorAt"
        | "cosignMedicalDirectorMembershipId"
        | "closedAt"
        | "suspendReason"
        | "documentId"
        | "updatedAt"
        | "version"
      >
    >,
  ): Promise<schema.QapiPip> {
    const [row] = await this.db.update(PIP).set(patch).where(eq(PIP.id, id)).returning();
    if (!row) throw new Error(`qapi_pip ${id} not found for update`);
    return row;
  }

  // ── qapi_governance_minutes ──────────────────────────────────────────────────────────────────

  async createMinutes(
    values: schema.NewQapiGovernanceMinutes,
  ): Promise<schema.QapiGovernanceMinutes> {
    const [row] = await this.db.insert(MIN).values(values).returning();
    if (!row) throw new Error("qapi_governance_minutes insert returned no row");
    return row;
  }

  async findMinutesById(id: string): Promise<schema.QapiGovernanceMinutes | null> {
    const [row] = await this.db.select().from(MIN).where(eq(MIN.id, id)).limit(1);
    return row ?? null;
  }

  /** A program's minutes, newest meeting first. */
  async listMinutes(
    qapiProgramId: string,
    limit = 50,
  ): Promise<readonly schema.QapiGovernanceMinutes[]> {
    return this.db
      .select()
      .from(MIN)
      .where(eq(MIN.qapiProgramId, qapiProgramId))
      .orderBy(desc(MIN.meetingAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * Update minutes (edit the narrative / reviewed lists / sign-off / append an amendment-log entry).
   * The "amendment after sign-off is append-only" guard lives in the service.
   */
  async updateMinutes(
    id: string,
    patch: Partial<
      Pick<
        schema.NewQapiGovernanceMinutes,
        | "minutesText"
        | "attendeeRoster"
        | "reviewedProjectIds"
        | "reviewedPipIds"
        | "signed"
        | "signedAt"
        | "signedByMembershipId"
        | "documentId"
        | "amendmentLog"
      >
    >,
  ): Promise<schema.QapiGovernanceMinutes> {
    const [row] = await this.db.update(MIN).set(patch).where(eq(MIN.id, id)).returning();
    if (!row) throw new Error(`qapi_governance_minutes ${id} not found for update`);
    return row;
  }
}
