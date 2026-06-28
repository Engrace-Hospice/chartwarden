// @wardenx/billing · repositories — `sequestration_policy` (per-provider-entity effective-dated
// sequestration-percentage schedule, §3.3, D11; non-partitioned; retention class `operational`). ORG-SCOPED.
//
// FORWARD-ONLY WRITES (D11 / §3.5 "effective-date-immutable; no version needed"): tenants may only
// forward-date a NEW policy entry; they may never rewrite a past or current effective period. This is
// belt-and-braces with the DB `sequestration_policy_active_uq` partial unique index + the `forwardOnly`
// CHECK (`effective_from > CURRENT_DATE OR effective_to IS NOT NULL`). The repo therefore offers exactly
// two write doors:
//   * `create` — insert a forward-dated policy (the DB CHECK rejects a non-future, still-open period).
//   * `closeActivePolicy` — set `effective_to` on the CURRENTLY-ACTIVE row (the one with `effective_to IS
//     NULL`) so a forward-dated successor can take over; the WHERE clause requires `effective_to IS NULL`
//     so this can only ever CLOSE the open period, never reopen or rewrite a historical one.
// There is deliberately NO general update/delete surface and NO `version` column (effective-date immutability
// is the concurrency model — the active partial-unique index serializes competing forward-dates).
//
// No enum case translation (this table has no enums). No PHI (D18).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { BillingDb } from "./db";

const S = schema.sequestrationPolicy;

/** Data port for `sequestration_policy` (FORWARD-ONLY: forward-dated insert + active-row close; reads). */
export class SequestrationPolicyRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Insert a forward-dated sequestration policy. The DB `forwardOnly` CHECK guarantees the new period is
   * either future-dated (`effective_from > CURRENT_DATE`) or already closed (`effective_to IS NOT NULL`),
   * so a tenant can never write into the past/present. Returns the inserted row.
   */
  async create(values: schema.NewSequestrationPolicy): Promise<schema.SequestrationPolicy> {
    const [row] = await this.db.insert(S).values(values).returning();
    if (!row) throw new Error("sequestration_policy insert returned no row");
    return row;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** The currently-active policy for a provider entity (`effective_to IS NULL`), or `null`. */
  async findActiveForProviderEntity(
    providerEntityId: string,
  ): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(and(eq(S.providerEntityId, providerEntityId), isNull(S.effectiveTo)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The policy in effect for a provider entity on a given service date — `effective_from <= date AND
   * (effective_to IS NULL OR effective_to >= date)`, newest `effective_from` first (the snapshot read the
   * claim-assembly calculator uses to stamp `claim.sequestration_applied_pct`). Returns `null` if no policy
   * covers the date.
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
          lte(S.effectiveFrom, serviceDate),
          or(isNull(S.effectiveTo), gte(S.effectiveTo, serviceDate)),
        ),
      )
      .orderBy(desc(S.effectiveFrom))
      .limit(1);
    return row ?? null;
  }

  /**
   * A provider entity's policy schedule, newest `effective_from` first (a per-PE history is small — bounded
   * read like `validation_run.listForClaim`, not cursor-paginated).
   */
  async listForProviderEntity(
    providerEntityId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly schema.SequestrationPolicy[]> {
    return this.db
      .select()
      .from(S)
      .where(eq(S.providerEntityId, providerEntityId))
      .orderBy(desc(S.effectiveFrom))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  }

  /**
   * CLOSE the currently-active policy for a provider entity by stamping `effective_to`, so a forward-dated
   * successor takes over. The WHERE clause requires `effective_to IS NULL`, so this can ONLY close the open
   * period — it can never reopen a closed one or rewrite a historical period (forward-only invariant).
   * Returns the closed row, or `null` if there was no open period to close.
   */
  async closeActivePolicy(
    providerEntityId: string,
    effectiveTo: string,
  ): Promise<schema.SequestrationPolicy | null> {
    const [row] = await this.db
      .update(S)
      .set({ effectiveTo })
      .where(
        and(
          eq(S.providerEntityId, providerEntityId),
          isNull(S.effectiveTo),
          // never close a row to a date on/before its own start (keeps the period non-degenerate):
          sql`${S.effectiveFrom} <= ${effectiveTo}`,
        ),
      )
      .returning();
    return row ?? null;
  }
}
