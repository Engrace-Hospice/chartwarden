// @wardenx/reporting · repositories — the scheduled-report aggregate: `report_schedule` (a cron-driven
// render of a saved view to a recipient list, evaluated in the tenant timezone) (M33 §3.3–§3.4). The
// schedule SERVICE wraps these in `withOrgContext` (recipients must be active memberships in the same
// org) and the cron evaluator calls `listDue` under `withPlatformContext`. `listActiveForOrg` +
// `cascadeRecipientRevocation` back the §4.3 ScheduledReportProvider seam M34 consumes.
import { schema } from "@wardenx/db";
import { and, asc, eq, lte } from "drizzle-orm";
import type { ReportingDb } from "./db";

const SCH = schema.reportSchedule;

/** Data port for `report_schedule`. */
export class ReportScheduleRepository {
  constructor(private readonly db: ReportingDb) {}

  /** Insert a new schedule (defaults to `active`). Returns the inserted row. */
  async create(values: schema.NewReportSchedule): Promise<schema.ReportSchedule> {
    const [row] = await this.db.insert(SCH).values(values).returning();
    if (!row) throw new Error("report_schedule insert returned no row");
    return row;
  }

  /** Fetch a schedule by id, or `null`. */
  async findById(id: string): Promise<schema.ReportSchedule | null> {
    const [row] = await this.db.select().from(SCH).where(eq(SCH.id, id)).limit(1);
    return row ?? null;
  }

  /** "My schedules" (§3.4 `report_schedule_owner_status_idx`): an owner's schedules. */
  async listByOwner(
    ownerMembershipId: string,
    status?: schema.ReportSchedule["status"],
  ): Promise<readonly schema.ReportSchedule[]> {
    const where = and(
      eq(SCH.ownerMembershipId, ownerMembershipId),
      status ? eq(SCH.status, status) : undefined,
    );
    return this.db.select().from(SCH).where(where).orderBy(asc(SCH.nextRunAt));
  }

  /** Active schedules for an org — the §4.3 ScheduledReportProvider.listActiveSchedulesForOrg backing. */
  async listActiveForOrg(organizationId: string): Promise<readonly schema.ReportSchedule[]> {
    return this.db
      .select()
      .from(SCH)
      .where(and(eq(SCH.organizationId, organizationId), eq(SCH.status, "active")))
      .orderBy(asc(SCH.nextRunAt));
  }

  /**
   * The cron evaluator's "what's due" scan (§3.4 `report_schedule_org_status_next_run_idx`): active
   * schedules in an org whose `next_run_at <= dueBefore`, oldest-due first.
   */
  async listDue(
    organizationId: string,
    dueBefore: Date,
    limit = 100,
  ): Promise<readonly schema.ReportSchedule[]> {
    return this.db
      .select()
      .from(SCH)
      .where(
        and(
          eq(SCH.organizationId, organizationId),
          eq(SCH.status, "active"),
          lte(SCH.nextRunAt, dueBefore),
        ),
      )
      .orderBy(asc(SCH.nextRunAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** Active schedules referencing a given view (e.g. to pause on view-archive). */
  async listActiveByView(reportViewId: string): Promise<readonly schema.ReportSchedule[]> {
    return this.db
      .select()
      .from(SCH)
      .where(and(eq(SCH.reportViewId, reportViewId), eq(SCH.status, "active")))
      .orderBy(asc(SCH.createdAt));
  }

  /**
   * Update a schedule's mutable fields (cron, timezone, recipients, format, next-run advance, status,
   * cancellation). The legal-transition + recipient-validation guards live in the schedule service.
   */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewReportSchedule,
        | "cronExpression"
        | "tenantTimezone"
        | "format"
        | "recipientMembershipIds"
        | "deliveryChannel"
        | "nextRunAt"
        | "status"
        | "cancelledAt"
      >
    >,
  ): Promise<schema.ReportSchedule> {
    const [row] = await this.db.update(SCH).set(patch).where(eq(SCH.id, id)).returning();
    if (!row) throw new Error(`report_schedule ${id} not found for update`);
    return row;
  }
}
