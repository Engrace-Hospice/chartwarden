// @wardenx/saas-tenant-platform · repositories — onboarding data port: `onboarding_task_template`
// (platform-shared read-only catalog) + `onboarding_task` (per-tenant runtime rows) (M34 §3.4).
//
// The eleven-step onboarding state machine (D3) is DATA-DRIVEN: the canonical step floor lives in the
// `onboarding_task_template` catalog (SD-036 pattern-2, platform-shared, org-less — every tenant reads
// the same template rows; writes are platform-ops/migration only), so new onboarding requirements are
// seed changes, not code changes. At provisioning the service materializes one `onboarding_task` per
// applicable template for the tenant; this repo reads the templates and drives the per-tenant task rows
// (status transitions pending → in_progress → done/skipped/blocked).
import { type DbClient, schema } from "@wardenx/db";
import { asc, eq } from "drizzle-orm";

const T = schema.onboardingTaskTemplate;
const K = schema.onboardingTask;

/** Data port for the onboarding template catalog + per-tenant onboarding task rows. */
export class OnboardingRepository {
  constructor(private readonly db: DbClient) {}

  // ── onboarding_task_template (platform-shared, read-only catalog) ───────────────────────────

  /** All onboarding templates in canonical order — the step floor the service materializes from. */
  async listTemplates(): Promise<readonly schema.OnboardingTaskTemplate[]> {
    return this.db.select().from(T).orderBy(asc(T.canonicalOrder));
  }

  /** Fetch a single template by its `key`, or `null`. */
  async findTemplateByKey(key: string): Promise<schema.OnboardingTaskTemplate | null> {
    const [row] = await this.db.select().from(T).where(eq(T.key, key)).limit(1);
    return row ?? null;
  }

  // ── onboarding_task (per-tenant runtime rows) ───────────────────────────────────────────────

  /** Insert one onboarding task. */
  async createTask(values: schema.NewOnboardingTask): Promise<schema.OnboardingTask> {
    const [row] = await this.db.insert(K).values(values).returning();
    if (!row) throw new Error("onboarding_task insert returned no row");
    return row;
  }

  /**
   * Materialize a tenant's onboarding tasks in one shot at provisioning (one row per applicable
   * template). Returns the inserted rows. Empty input is a no-op returning `[]`.
   */
  async createTasks(
    values: readonly schema.NewOnboardingTask[],
  ): Promise<readonly schema.OnboardingTask[]> {
    if (values.length === 0) return [];
    return this.db
      .insert(K)
      .values([...values])
      .returning();
  }

  /** Fetch an onboarding task by id, or `null`. */
  async findTaskById(id: string): Promise<schema.OnboardingTask | null> {
    const [row] = await this.db.select().from(K).where(eq(K.id, id)).limit(1);
    return row ?? null;
  }

  /** A tenant's onboarding tasks, ordered by template canonical order (joined to the catalog). */
  async listTasksByTenant(tenantAccountId: string): Promise<readonly schema.OnboardingTask[]> {
    return this.db
      .select()
      .from(K)
      .innerJoin(T, eq(K.templateKey, T.key))
      .where(eq(K.tenantAccountId, tenantAccountId))
      .orderBy(asc(T.canonicalOrder))
      .then((rows) => rows.map((r) => r.onboarding_task));
  }

  /**
   * Transition a task's status, stamping the relevant timestamps / blocker / completion evidence.
   * The state machine's legal-transition guard lives in the onboarding service.
   */
  async updateTaskStatus(
    id: string,
    patch: Partial<
      Pick<
        schema.NewOnboardingTask,
        | "status"
        | "assignedToMembershipId"
        | "dueAt"
        | "startedAt"
        | "completedAt"
        | "blockerReason"
        | "completionEvidence"
      >
    >,
  ): Promise<schema.OnboardingTask> {
    const [row] = await this.db.update(K).set(patch).where(eq(K.id, id)).returning();
    if (!row) throw new Error(`onboarding_task ${id} not found for status update`);
    return row;
  }
}
