// @wardenx/billing · repositories — `tenant_wage_index` (F-211; the TENANT-ENTERED, append-only CMS hospice wage index
// per CCN + federal fiscal year). ORG-SCOPED, no PHI. Rows are inserted and SUPERSEDED (`superseded_at`/`superseded_by_id`,
// the only app-updatable columns — column GRANT + `tenant_wage_index_guard` trigger); there is no edit or delete surface.
// "Live" = `superseded_at IS NULL`; the partial unique index `tenant_wage_index_live_uq` guarantees at most one live row
// per (org, ccn, fiscal year), so `findLive` has at most one answer.
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { BillingDb } from "./db";

const T = schema.tenantWageIndex;

export class TenantWageIndexRepository {
  constructor(private readonly db: BillingDb) {}

  async create(values: schema.NewTenantWageIndex): Promise<schema.TenantWageIndex> {
    const [row] = await this.db.insert(T).values(values).returning();
    if (!row) throw new Error("tenant_wage_index insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.TenantWageIndex | null> {
    const [row] = await this.db.select().from(T).where(eq(T.id, id)).limit(1);
    return row ?? null;
  }

  /** The LIVE row for a CCN + fiscal year, or `null`. */
  async findLive(ccn: string, fiscalYearStarting: number): Promise<schema.TenantWageIndex | null> {
    const [row] = await this.db
      .select()
      .from(T)
      .where(
        and(eq(T.ccn, ccn), eq(T.fiscalYearStarting, fiscalYearStarting), isNull(T.supersededAt)),
      )
      .limit(1);
    return row ?? null;
  }

  /** Rows, newest fiscal year first; optionally filtered by CCN / fiscal year; superseded rows only when asked. */
  async list(
    opts: {
      ccn?: string;
      fiscalYearStarting?: number;
      includeSuperseded?: boolean;
      limit?: number;
    } = {},
  ): Promise<readonly schema.TenantWageIndex[]> {
    return this.db
      .select()
      .from(T)
      .where(
        and(
          opts.ccn ? eq(T.ccn, opts.ccn) : undefined,
          opts.fiscalYearStarting !== undefined
            ? eq(T.fiscalYearStarting, opts.fiscalYearStarting)
            : undefined,
          opts.includeSuperseded ? undefined : isNull(T.supersededAt),
        ),
      )
      .orderBy(desc(T.fiscalYearStarting), T.ccn, desc(T.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }

  /** Stamp a LIVE row as superseded by `successorId`. Returns the row, or `null` if it was not live. */
  async markSuperseded(
    id: string,
    successorId: string,
    at: Date,
  ): Promise<schema.TenantWageIndex | null> {
    const [row] = await this.db
      .update(T)
      .set({ supersededAt: at, supersededById: successorId })
      .where(and(eq(T.id, id), isNull(T.supersededAt)))
      .returning();
    return row ?? null;
  }
}
