// @wardenx/reporting · repositories — the saved-view aggregate: `report_view` (a saved view over a
// definition version: owner, pinned filters, share scope, org-default flag) (M33 §3.3–§3.4). The view
// SERVICE wraps these in `withOrgContext` and owns the ownership / `report.view.set_org_default`
// (org_admin) guard; the `dashboard_visibility` ABAC predicate (§4.7) decides read/edit at the route.
import { schema } from "@wardenx/db";
import { and, desc, eq, not } from "drizzle-orm";
import type { ReportingDb } from "./db";

const W = schema.reportView;

/** Data port for `report_view`. */
export class ReportViewRepository {
  constructor(private readonly db: ReportingDb) {}

  /** Insert a new saved view (defaults to `private` / `active`). Returns the inserted row. */
  async create(values: schema.NewReportView): Promise<schema.ReportView> {
    const [row] = await this.db.insert(W).values(values).returning();
    if (!row) throw new Error("report_view insert returned no row");
    return row;
  }

  /** Fetch a view by id, or `null`. */
  async findById(id: string): Promise<schema.ReportView | null> {
    const [row] = await this.db.select().from(W).where(eq(W.id, id)).limit(1);
    return row ?? null;
  }

  /** "My views" (§3.4 `report_view_org_owner_status_idx`): an owner's views in an org. */
  async listByOwner(
    organizationId: string,
    ownerMembershipId: string,
    status: schema.ReportView["status"] = "active",
  ): Promise<readonly schema.ReportView[]> {
    return this.db
      .select()
      .from(W)
      .where(
        and(
          eq(W.organizationId, organizationId),
          eq(W.ownerMembershipId, ownerMembershipId),
          eq(W.status, status),
        ),
      )
      .orderBy(desc(W.createdAt));
  }

  /** Org-wide shared views (§3.4 partial `report_view_org_share_default_idx` WHERE share_scope='org'). */
  async listOrgShared(organizationId: string): Promise<readonly schema.ReportView[]> {
    return this.db
      .select()
      .from(W)
      .where(
        and(eq(W.organizationId, organizationId), eq(W.shareScope, "org"), eq(W.status, "active")),
      )
      .orderBy(desc(W.createdAt));
  }

  /** The single org-default view, or `null` (the org-default surface, §3.4). */
  async findOrgDefault(organizationId: string): Promise<schema.ReportView | null> {
    const [row] = await this.db
      .select()
      .from(W)
      .where(
        and(eq(W.organizationId, organizationId), eq(W.isOrgDefault, true), eq(W.status, "active")),
      )
      .limit(1);
    return row ?? null;
  }

  /** Update a view's editable fields (display name, pinned filters, share scope / role keys, status). */
  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewReportView,
        "displayName" | "pinnedFilters" | "shareScope" | "shareRoleKeys" | "isOrgDefault" | "status"
      >
    >,
  ): Promise<schema.ReportView> {
    const [row] = await this.db.update(W).set(patch).where(eq(W.id, id)).returning();
    if (!row) throw new Error(`report_view ${id} not found for update`);
    return row;
  }

  /**
   * Clear the org-default flag from every other view in the org (the "exactly one default" invariant —
   * the service calls this then sets `isOrgDefault=true` on the new default in the same transaction).
   * Returns the number of rows cleared.
   */
  async clearOrgDefault(organizationId: string, exceptViewId?: string): Promise<number> {
    const where = and(
      eq(W.organizationId, organizationId),
      eq(W.isOrgDefault, true),
      exceptViewId ? not(eq(W.id, exceptViewId)) : undefined,
    );
    const rows = await this.db.update(W).set({ isOrgDefault: false }).where(where).returning();
    return rows.length;
  }
}
