// @wardenx/billing · repositories — `sequestration_policy` (per-provider-entity effective-dated
// sequestration-percentage schedule, §3.3, D11; non-partitioned; retention class `operational`). ORG-SCOPED.
//
// APPEND-ONLY (F-212, migration 0281): a policy row's percentage / start / actor / reason are never edited. The app role may
// only (a) CLOSE an open period (`effective_to` NULL -> date) so a successor can take over, and (b) SUPERSEDE a row
// (`superseded_at` + `superseded_by_id`) when it was keyed wrongly; both are column-GRANT + `sequestration_policy_guard`
// trigger enforced. "Live" = `superseded_at IS NULL`; a DB EXCLUDE constraint guarantees at most one live row covers any date per
// provider entity, so `findEffectiveOn` has at most one answer. There is NO delete surface (destruction role only).
//
// No enum case translation (this table has no enums). No PHI (D18).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { BillingDb } from "./db";

const S = schema.sequestrationPolicy;

/** Data port for `sequestration_policy` (APPEND-ONLY: insert, close-open-period, supersede; live-row reads). */
export class SequestrationPolicyRepository {
  constructor(private readonly db: BillingDb) {}

  /** Insert a policy row (the DB CHECKs + EXCLUDE are the backstop for the service's validation and overlap pre-check). */
  async create(values: schema.NewSequestrationPolicy): Promise<schema.SequestrationPolicy> {
    const [row] = await this.db.insert(S).values(values).returning();
    if (!row) throw new Error("sequestration_policy insert returned no row");
    return row;
  }

  /** Point read by id (live OR superseded), or `null`. */
  async findById(id: string): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** The LIVE open-ended policy for a provider entity (`effective_to IS NULL`, not superseded), or `null`. */
  async findActiveForProviderEntity(
    providerEntityId: string,
  ): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(
        and(
          eq(S.providerEntityId, providerEntityId),
          isNull(S.effectiveTo),
          isNull(S.supersededAt),
        ),
      )
      .orderBy(desc(S.effectiveFrom))
      .limit(1);
    return row ?? null;
  }

  /**
   * The LIVE policy in effect for a provider entity on a given service date — `effective_from <= date AND
   * (effective_to IS NULL OR effective_to >= date)` — the snapshot read claim assembly uses to stamp
   * `claim.sequestration_applied_pct`. At most one row can match (EXCLUDE constraint). `null` if none covers the date.
   */
  async findEffectiveOn(
    providerEntityId: string,
    serviceDate: string,
  ): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(
        and(
          eq(S.providerEntityId, providerEntityId),
          isNull(S.supersededAt),
          lte(S.effectiveFrom, serviceDate),
          or(isNull(S.effectiveTo), gte(S.effectiveTo, serviceDate)),
        ),
      )
      .orderBy(desc(S.effectiveFrom))
      .limit(1);
    return row ?? null;
  }

  /** LIVE rows whose window intersects `[from, to]` (`to` null = open), optionally ignoring one row. */
  async findLiveOverlapping(
    providerEntityId: string,
    from: string,
    to: string | null,
    excludeId?: string,
  ): Promise<readonly schema.SequestrationPolicy[]> {
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

  /**
   * A provider entity's schedule, newest `effective_from` first; superseded rows only when asked (a per-PE history is
   * small — a bounded read, not cursor-paginated).
   */
  async listForProviderEntity(
    providerEntityId: string,
    opts: { includeSuperseded?: boolean; limit?: number } = {},
  ): Promise<readonly schema.SequestrationPolicy[]> {
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
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /**
   * CLOSE a LIVE open-ended row by stamping `effective_to`, so a successor can take over. The WHERE requires
   * `effective_to IS NULL` and `superseded_at IS NULL`, so this can only ever close an open period (the guard trigger
   * enforces the same). Returns the closed row, or `null`.
   */
  async closeOpenPeriod(
    id: string,
    effectiveTo: string,
  ): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db
      .update(S)
      .set({ effectiveTo })
      .where(
        and(
          eq(S.id, id),
          isNull(S.effectiveTo),
          isNull(S.supersededAt),
          sql`${S.effectiveFrom} <= ${effectiveTo}`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Stamp a LIVE row as superseded by `successorId`. Returns the row, or `null` if it was not live. */
  async markSuperseded(
    id: string,
    successorId: string,
    at: Date,
  ): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db
      .update(S)
      .set({ supersededAt: at, supersededById: successorId })
      .where(and(eq(S.id, id), isNull(S.supersededAt)))
      .returning();
    return row ?? null;
  }
}
