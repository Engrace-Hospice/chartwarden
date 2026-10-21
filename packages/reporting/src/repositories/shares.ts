// @chartwarden/reporting · repositories — the view-share aggregate: `report_share` (an explicit share
// grant for a saved view — to a role key, or rarely a specific membership) (M33 §3.3–§3.4). The share
// SERVICE wraps these in `withOrgContext` and enforces `report.share.write` / `report.share.org`
// (org_admin) at the route; `revokeByMembership` backs the M34 recipient-revocation cascade (§4.3
// ScheduledReportProvider sibling — a revoked membership loses its explicit shares too).
import { schema } from "@chartwarden/db";
import { and, desc, eq } from "drizzle-orm";
import type { ReportingDb } from "./db";

const S = schema.reportShare;

/** Data port for `report_share`. */
export class ReportShareRepository {
  constructor(private readonly db: ReportingDb) {}

  /** Insert a new share grant (defaults to `active`). Returns the inserted row. */
  async create(values: schema.NewReportShare): Promise<schema.ReportShare> {
    const [row] = await this.db.insert(S).values(values).returning();
    if (!row) throw new Error("report_share insert returned no row");
    return row;
  }

  /** Fetch a share by id, or `null`. */
  async findById(id: string): Promise<schema.ReportShare | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** Active share grants for a view (the "who can see this" surface). */
  async listActiveByView(reportViewId: string): Promise<readonly schema.ReportShare[]> {
    return this.db
      .select()
      .from(S)
      .where(and(eq(S.reportViewId, reportViewId), eq(S.status, "active")))
      .orderBy(desc(S.createdAt));
  }

  /** Active share grants targeting a role key in an org (the role-share read fan-in). */
  async listActiveByRole(
    organizationId: string,
    roleKey: string,
  ): Promise<readonly schema.ReportShare[]> {
    return this.db
      .select()
      .from(S)
      .where(
        and(
          eq(S.organizationId, organizationId),
          eq(S.sharedWithRoleKey, roleKey),
          eq(S.status, "active"),
        ),
      )
      .orderBy(desc(S.createdAt));
  }

  /** Revoke a single share grant (stamps `revokedAt`). Returns the updated row. */
  async revoke(id: string, revokedAt: Date = new Date()): Promise<schema.ReportShare> {
    const [row] = await this.db
      .update(S)
      .set({ status: "revoked", revokedAt })
      .where(eq(S.id, id))
      .returning();
    if (!row) throw new Error(`report_share ${id} not found for revoke`);
    return row;
  }

  /**
   * Revoke every active explicit-membership share for a membership being off-boarded (M34 cascade).
   * Returns the number of grants revoked.
   */
  async revokeByMembership(
    organizationId: string,
    membershipId: string,
    revokedAt: Date = new Date(),
  ): Promise<number> {
    const rows = await this.db
      .update(S)
      .set({ status: "revoked", revokedAt })
      .where(
        and(
          eq(S.organizationId, organizationId),
          eq(S.sharedWithMembershipId, membershipId),
          eq(S.status, "active"),
        ),
      )
      .returning();
    return rows.length;
  }
}
