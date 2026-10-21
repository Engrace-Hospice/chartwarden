// @chartwarden/reporting · repositories — the drilldown-audit aggregate: `report_drilldown_audit` (the
// INSERT-ONLY trail of drilldown navigations from a tile into an owner-module surface; partitioned
// monthly by `accessed_at`, composite PK id + accessed_at) (M33 §3.3–§3.4, §3.7). This table is
// destruction_blocked (retention class `compliance`): there is intentionally NO update / delete here —
// even with org_admin (§3.5). `query_filters_cipher` is the envelope-encrypted filter context and is
// DENYLISTED in the M4 write-audit trigger (§3.6). The drilldown emitter writes one row per navigation
// under `withOrgContext`.
import { schema } from "@chartwarden/db";
import { and, desc, eq } from "drizzle-orm";
import type { ReportingDb } from "./db";

const A = schema.reportDrilldownAudit;

/** Insert-only data port for `report_drilldown_audit`. */
export class ReportDrilldownAuditRepository {
  constructor(private readonly db: ReportingDb) {}

  /** Append a drilldown-audit row (the only mutating operation this table admits). */
  async append(values: schema.NewReportDrilldownAudit): Promise<schema.ReportDrilldownAudit> {
    const [row] = await this.db.insert(A).values(values).returning();
    if (!row) throw new Error("report_drilldown_audit insert returned no row");
    return row;
  }

  /** An actor's recent drilldowns newest-first (§3.4 `..._actor_accessed_idx`). */
  async listByActor(
    actorMembershipId: string,
    limit = 50,
  ): Promise<readonly schema.ReportDrilldownAudit[]> {
    return this.db
      .select()
      .from(A)
      .where(eq(A.actorMembershipId, actorMembershipId))
      .orderBy(desc(A.accessedAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * The compliance drilldown-audit surface (§3.4 `..._org_module_accessed_idx`): an org's drilldowns
   * into a given target module, newest-first.
   */
  async listByOrgTargetModule(
    organizationId: string,
    drilldownTargetModule: number,
    limit = 100,
  ): Promise<readonly schema.ReportDrilldownAudit[]> {
    return this.db
      .select()
      .from(A)
      .where(
        and(
          eq(A.organizationId, organizationId),
          eq(A.drilldownTargetModule, drilldownTargetModule),
        ),
      )
      .orderBy(desc(A.accessedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** The cross-module-audit join (§3.4 `..._trace_id_idx`): the row(s) for a drilldown trace id. */
  async findByTraceId(drilldownTraceId: string): Promise<readonly schema.ReportDrilldownAudit[]> {
    return this.db
      .select()
      .from(A)
      .where(eq(A.drilldownTraceId, drilldownTraceId))
      .orderBy(desc(A.accessedAt));
  }
}
