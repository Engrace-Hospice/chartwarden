// @chartwarden/billing · repositories — `hospice_rate_table` (F-210; the TENANT-ENTERED, effective-dated hospice per-diem
// rate set). ORG-SCOPED, no PHI. APPEND-ONLY: rows are inserted and SUPERSEDED (`superseded_at`/`superseded_by_id`, the
// only app-updatable columns — column GRANT + `hospice_rate_table_guard` trigger); a rate is never edited in place and
// there is no delete surface. "Live" = `superseded_at IS NULL`; the DB EXCLUDE constraint guarantees at most one live
// version covers any date per provider entity, so `findEffectiveOn` has at most one answer.
import * as schema from "@chartwarden/db/schema";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { BillingDb } from "./db";

const R = schema.hospiceRateTable;

export class HospiceRateTableRepository {
  constructor(private readonly db: BillingDb) {}

  async create(values: schema.NewHospiceRateTable): Promise<schema.HospiceRateTable> {
    const [row] = await this.db.insert(R).values(values).returning();
    if (!row) throw new Error("hospice_rate_table insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.HospiceRateTable | null> {
    const [row] = await this.db.select().from(R).where(eq(R.id, id)).limit(1);
    return row ?? null;
  }

  /** The LIVE version covering `date` for a provider entity, or `null`. */
  async findEffectiveOn(
    providerEntityId: string,
    date: string,
  ): Promise<schema.HospiceRateTable | null> {
    const [row] = await this.db
      .select()
      .from(R)
      .where(
        and(
          eq(R.providerEntityId, providerEntityId),
          isNull(R.supersededAt),
          lte(R.effectiveFrom, date),
          or(isNull(R.effectiveTo), gte(R.effectiveTo, date)),
        ),
      )
      .orderBy(desc(R.effectiveFrom))
      .limit(1);
    return row ?? null;
  }

  /** LIVE versions whose window intersects `[from, to]` (`to` null = open), optionally ignoring one row. */
  async findLiveOverlapping(
    providerEntityId: string,
    from: string,
    to: string | null,
    excludeId?: string,
  ): Promise<readonly schema.HospiceRateTable[]> {
    return this.db
      .select()
      .from(R)
      .where(
        and(
          eq(R.providerEntityId, providerEntityId),
          isNull(R.supersededAt),
          excludeId ? sql`${R.id} <> ${excludeId}` : undefined,
          or(isNull(R.effectiveTo), gte(R.effectiveTo, from)),
          to === null ? undefined : lte(R.effectiveFrom, to),
        ),
      )
      .orderBy(R.effectiveFrom);
  }

  /** A provider entity's versions, newest window first; superseded versions only when asked. */
  async listForProviderEntity(
    providerEntityId: string,
    opts: { includeSuperseded?: boolean; limit?: number } = {},
  ): Promise<readonly schema.HospiceRateTable[]> {
    return this.db
      .select()
      .from(R)
      .where(
        and(
          eq(R.providerEntityId, providerEntityId),
          opts.includeSuperseded ? undefined : isNull(R.supersededAt),
        ),
      )
      .orderBy(desc(R.effectiveFrom), desc(R.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }

  /** Stamp a LIVE row as superseded by `successorId`. Returns the row, or `null` if it was not live. */
  async markSuperseded(
    id: string,
    successorId: string,
    at: Date,
  ): Promise<schema.HospiceRateTable | null> {
    const [row] = await this.db
      .update(R)
      .set({ supersededAt: at, supersededById: successorId })
      .where(and(eq(R.id, id), isNull(R.supersededAt)))
      .returning();
    return row ?? null;
  }
}
