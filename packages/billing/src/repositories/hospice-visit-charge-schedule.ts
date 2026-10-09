// @wardenx/billing · repositories — `hospice_visit_charge_schedule` (migration 1056; the TENANT-ENTERED, effective-dated
// charge per 15-minute unit per visit discipline). ORG-SCOPED, no PHI. APPEND-ONLY exactly like `hospice_rate_table`:
// rows are inserted and SUPERSEDED (`superseded_at`/`superseded_by_id`, the only app-updatable columns — column GRANT +
// `hospice_visit_charge_schedule_guard` trigger); a charge is never edited in place and there is no delete surface.
// "Live" = `superseded_at IS NULL`; the DB EXCLUDE constraint guarantees at most one live version covers any date per
// provider entity.
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { BillingDb } from "./db";

const S = schema.hospiceVisitChargeSchedule;

export class HospiceVisitChargeScheduleRepository {
  constructor(private readonly db: BillingDb) {}

  async create(
    values: schema.NewHospiceVisitChargeSchedule,
  ): Promise<schema.HospiceVisitChargeSchedule> {
    const [row] = await this.db.insert(S).values(values).returning();
    if (!row) throw new Error("hospice_visit_charge_schedule insert returned no row");
    return row;
  }

  async findById(id: string): Promise<schema.HospiceVisitChargeSchedule | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** The LIVE version covering `date` for a provider entity, or `null`. */
  async findEffectiveOn(
    providerEntityId: string,
    date: string,
  ): Promise<schema.HospiceVisitChargeSchedule | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(
        and(
          eq(S.providerEntityId, providerEntityId),
          isNull(S.supersededAt),
          lte(S.effectiveFrom, date),
          or(isNull(S.effectiveTo), gte(S.effectiveTo, date)),
        ),
      )
      .orderBy(desc(S.effectiveFrom))
      .limit(1);
    return row ?? null;
  }

  /** LIVE versions whose window intersects `[from, to]` (`to` null = open), optionally ignoring one row. */
  async findLiveOverlapping(
    providerEntityId: string,
    from: string,
    to: string | null,
    excludeId?: string,
  ): Promise<readonly schema.HospiceVisitChargeSchedule[]> {
    return this.db
      .select()
      .from(S)
      .where(
        and(
          eq(S.providerEntityId, providerEntityId),
          isNull(S.supersededAt),
          excludeId ? sql`${S.id} <> ${excludeId}` : undefined,
          or(isNull(S.effectiveTo), gte(S.effectiveTo, from)),
          to === null ? undefined : lte(S.effectiveFrom, to),
        ),
      )
      .orderBy(S.effectiveFrom);
  }

  /** A provider entity's versions, newest window first; superseded versions only when asked. */
  async listForProviderEntity(
    providerEntityId: string,
    opts: { includeSuperseded?: boolean; limit?: number } = {},
  ): Promise<readonly schema.HospiceVisitChargeSchedule[]> {
    return this.db
      .select()
      .from(S)
      .where(
        and(
          eq(S.providerEntityId, providerEntityId),
          opts.includeSuperseded ? undefined : isNull(S.supersededAt),
        ),
      )
      .orderBy(desc(S.effectiveFrom), desc(S.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }

  /** Stamp a LIVE row as superseded by `successorId`. Returns the row, or `null` if it was not live. */
  async markSuperseded(
    id: string,
    successorId: string,
    at: Date,
  ): Promise<schema.HospiceVisitChargeSchedule | null> {
    const [row] = await this.db
      .update(S)
      .set({ supersededAt: at, supersededById: successorId })
      .where(and(eq(S.id, id), isNull(S.supersededAt)))
      .returning();
    return row ?? null;
  }
}
