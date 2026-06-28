// @wardenx/cost-report · repositories — the opt-in bad-debt log: `bad_debt_record` (the un-collectible
// portion of Medicare deductibles/coinsurance claimed under PRM I Ch 3-4; add/edit only while the parent
// is draft/populating; SOFT-DELETE — a `deleted_at` tombstone preserves the row for audit — D7) (M27
// §3.3). ORG-SCOPED; the bad-debt service wraps these in `withOrgContext` and owns the parent-state guard
// + the `cost_report.bad_debt_claimed` opt-in. `amount_cents` is integer cents (bigint, mode number; D8).
// No PHI (D18) — `period_label` is a month bucket, not a patient.
import { schema } from "@wardenx/db";
import { and, asc, eq, isNull, sum } from "drizzle-orm";
import type { CostReportDb } from "./db";

const B = schema.badDebtRecord;

/** Data port for `bad_debt_record` (soft-delete; tombstone preserved for audit). */
export class BadDebtRepository {
  constructor(private readonly db: CostReportDb) {}

  async create(values: schema.NewBadDebtRecord): Promise<schema.BadDebtRecord> {
    const [row] = await this.db.insert(B).values(values).returning();
    if (!row) throw new Error("bad_debt_record insert returned no row");
    return row;
  }

  /** Point read by id (incl. tombstoned rows — the audit surface), or `null`. */
  async findById(id: string): Promise<schema.BadDebtRecord | null> {
    const [row] = await this.db.select().from(B).where(eq(B.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * The LIVE bad-debt entries for a report (`deleted_at IS NULL`), §3.4 `idx_bad_debt_org_report_period`,
   * by period then add time.
   */
  async listForReport(
    organizationId: string,
    costReportId: string,
  ): Promise<readonly schema.BadDebtRecord[]> {
    return this.db
      .select()
      .from(B)
      .where(
        and(
          eq(B.organizationId, organizationId),
          eq(B.costReportId, costReportId),
          isNull(B.deletedAt),
        ),
      )
      .orderBy(asc(B.periodLabel), asc(B.addedAt));
  }

  /** The full history for a report INCLUDING tombstoned rows (the auditor's deleted-entry trail). */
  async listForReportWithDeleted(
    organizationId: string,
    costReportId: string,
  ): Promise<readonly schema.BadDebtRecord[]> {
    return this.db
      .select()
      .from(B)
      .where(and(eq(B.organizationId, organizationId), eq(B.costReportId, costReportId)))
      .orderBy(asc(B.periodLabel), asc(B.addedAt));
  }

  /** The summed LIVE claimed bad debt for a report, in integer cents (D8); `0` when none. */
  async sumLiveAmountCents(organizationId: string, costReportId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(B.amountCents) })
      .from(B)
      .where(
        and(
          eq(B.organizationId, organizationId),
          eq(B.costReportId, costReportId),
          isNull(B.deletedAt),
        ),
      );
    return row?.total ? Number(row.total) : 0;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        schema.NewBadDebtRecord,
        | "periodLabel"
        | "debtKind"
        | "amountCents"
        | "collectionEffortsDocumented"
        | "supportingDocumentIds"
      >
    >,
  ): Promise<schema.BadDebtRecord> {
    const [row] = await this.db.update(B).set(patch).where(eq(B.id, id)).returning();
    if (!row) throw new Error(`bad_debt_record ${id} not found for update`);
    return row;
  }

  /**
   * Soft-delete (stamp `deleted_at` + the deleting membership), only when still live. Returns the
   * tombstoned row, or `null` when already deleted / absent.
   */
  async softDelete(
    id: string,
    deletedByMembershipId: string,
    deletedAt: Date = new Date(),
  ): Promise<schema.BadDebtRecord | null> {
    const [row] = await this.db
      .update(B)
      .set({ deletedAt, deletedByMembershipId })
      .where(and(eq(B.id, id), isNull(B.deletedAt)))
      .returning();
    return row ?? null;
  }
}
