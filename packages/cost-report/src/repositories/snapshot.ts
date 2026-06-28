// @wardenx/cost-report · repositories — the content-hashed snapshot lockdown: `cost_report_snapshot`
// (every seam-derived input + worksheet state materialized at submit/reopen with a SHA-256 content hash;
// INSERT-ONLY — the RLS write policy is system-only, §3.5; `prior_snapshot_id` chains snapshots through
// reopens; `cost_report.latest_snapshot_id` is the head — D10) (M27 §3.3). ORG-SCOPED; the snapshot
// builder/service wraps these in `withOrgContext`. `materialized_inputs` + `worksheet_snapshot` are
// audit-denylisted (§3.6); this port returns the whole `$inferSelect` row and the service projects.
import { schema } from "@wardenx/db";
import { and, desc, eq } from "drizzle-orm";
import type { CostReportDb } from "./db";

const S = schema.costReportSnapshot;

/** Data port for `cost_report_snapshot` (insert-only + chain traversal). */
export class CostReportSnapshotRepository {
  constructor(private readonly db: CostReportDb) {}

  /** Append a snapshot (submit / reopen / mac_revision / admin_audit). Returns the inserted row. */
  async create(values: schema.NewCostReportSnapshot): Promise<schema.CostReportSnapshot> {
    const [row] = await this.db.insert(S).values(values).returning();
    if (!row) throw new Error("cost_report_snapshot insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.CostReportSnapshot | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** A report's snapshots (§3.4 `idx_snapshot_org_report`), newest-created first. */
  async listForReport(
    organizationId: string,
    costReportId: string,
  ): Promise<readonly schema.CostReportSnapshot[]> {
    return this.db
      .select()
      .from(S)
      .where(and(eq(S.organizationId, organizationId), eq(S.costReportId, costReportId)))
      .orderBy(desc(S.createdAt));
  }

  /** The snapshot for a content hash (the `idx_snapshot_content_hash` surface) — dedup probe, or `null`. */
  async findByContentHash(contentHashSha256: string): Promise<schema.CostReportSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(eq(S.contentHashSha256, contentHashSha256))
      .limit(1);
    return row ?? null;
  }

  /**
   * Traverse the snapshot chain from a head id backward via `prior_snapshot_id`, newest→oldest. Each hop
   * is a point read (the chain is short — one link per reopen, D19); a missing/cyclic link terminates the
   * walk. The `maxDepth` guard bounds a corrupt chain.
   */
  async walkChain(
    headSnapshotId: string,
    maxDepth = 64,
  ): Promise<readonly schema.CostReportSnapshot[]> {
    const chain: schema.CostReportSnapshot[] = [];
    const seen = new Set<string>();
    let cursor: string | null = headSnapshotId;
    while (cursor && !seen.has(cursor) && chain.length < maxDepth) {
      seen.add(cursor);
      const node: schema.CostReportSnapshot | null = await this.findById(cursor);
      if (!node) break;
      chain.push(node);
      cursor = node.priorSnapshotId;
    }
    return chain;
  }
}
