// @wardenx/billing · repositories — `validation_override` (one row per overridden failed validation
// result, §3.3, D5; APPEND-ONLY, retention class `compliance`). A role-gated, reason-required (≥40 chars),
// M4-audited override that lets a claim proceed past a NON-regulatory failure; AT MOST ONE override per
// result (the `validation_override_result_uq` unique index). This port mirrors the `ValidationRunRepository`
// exemplar: idempotent INSERT + READ ONLY — there is deliberately NO update/delete method. The override is
// recorded once (with its M4 audit-event id captured in the same transaction) and never mutated; reverting
// is a new corrective action upstream, never a row edit.
//
// IDEMPOTENCY (§2.6): a retried override on the same `result_id` collapses to the original row via
// `onConflictDoNothing` + read-back, so a retry never doubles. ENUM BOUNDARY: `override_role_applied`
// (billing_manager/…) is a DB-native lowercase enum identical to the domain `OverrideRole`, so rows pass
// through un-mapped. No PHI / MBI is ever stored here (D13, §8.7).
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type BillingDb,
  buildCursorPage,
  type CursorPage,
  decodeCursor,
  keysetBefore,
  pageSizeOf,
} from "./db";

const O = schema.validationOverride;

/** Data port for `validation_override` (APPEND-ONLY: idempotent insert + read; NO update/delete surface). */
export class ValidationOverrideRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append an override, idempotent on `result_id` (§2.6, the at-most-one-per-result invariant): on a
   * duplicate the INSERT no-ops and the existing row is read back, so a retry collapses to the original.
   * Returns the persisted override.
   */
  async append(values: schema.NewValidationOverride): Promise<schema.ValidationOverride> {
    const [inserted] = await this.db
      .insert(O)
      .values(values)
      .onConflictDoNothing({ target: [O.resultId] })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findByResult(values.resultId);
    if (!existing) throw new Error("validation_override append: conflict but no existing row found");
    return existing;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.ValidationOverride | null> {
    const [row] = await this.db.select().from(O).where(eq(O.id, id)).limit(1);
    return row ?? null;
  }

  /** The override for a given failed result (the unique `result_id` probe), or `null`. */
  async findByResult(resultId: string): Promise<schema.ValidationOverride | null> {
    const [row] = await this.db.select().from(O).where(eq(O.resultId, resultId)).limit(1);
    return row ?? null;
  }

  /** The overrides covering a set of results (batch attach to a result page); empty input → `[]`. */
  async listByResultIds(
    resultIds: readonly string[],
  ): Promise<readonly schema.ValidationOverride[]> {
    if (resultIds.length === 0) return [];
    return this.db.select().from(O).where(inArray(O.resultId, [...resultIds]));
  }

  /**
   * One keyset page of an org's overrides for the compliance-review worklist, `(applied_at DESC, id DESC)`.
   * Over-fetches `size + 1` rows so {@link buildCursorPage} can reveal `hasMore` + mint the next cursor.
   * RLS scopes the statement to `app.org_id` at the service layer.
   */
  async listByOrgPage(
    organizationId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<schema.ValidationOverride>> {
    const size = pageSizeOf(limit);
    const where = and(
      eq(O.organizationId, organizationId),
      keysetBefore(O.appliedAt, O.id, cursor ? decodeCursor(cursor) : undefined),
    );
    const rows = await this.db
      .select()
      .from(O)
      .where(where)
      .orderBy(desc(O.appliedAt), desc(O.id))
      .limit(size + 1);
    return buildCursorPage(rows, size, (r) => ({
      createdAt: r.appliedAt.toISOString(),
      id: r.id,
    }));
  }
}
