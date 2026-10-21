// @chartwarden/billing · repositories — `per_diem_rate_calculation` (the reproducible HIPPS payment math for a claim,
// §3.3; 1:1 with `claim` via `per_diem_rate_calculation_claim_uq`). APPEND-ONLY — mirrors the `validation_run`
// exemplar: INSERT + READ ONLY, deliberately NO update/delete method (the DB carries an append-only
// write-audit trigger from P1; the per-claim math is recorded once at assembly and never mutated — a
// re-assembly is a re-derivation behind the same idempotent claim key).
//
// IDEMPOTENCY: `append` is INSERT … ON CONFLICT (claim_id) DO NOTHING then read-back, so a re-run of the
// HIPPS calculator for the same claim collapses to the original row rather than doubling. ENUM BOUNDARY:
// there is NO enum on this table — the per-segment `level_of_care` lives inside the typed `segments` jsonb
// as the DB abbreviation the math layer emits, so rows pass through un-mapped. No PHI / MBI (D13 / §8.7);
// money is integer cents (D8).
import * as schema from "@chartwarden/db/schema";
import { eq } from "drizzle-orm";
import type { BillingDb } from "./db";

const H = schema.perDiemRateCalculation;

/** Data port for `per_diem_rate_calculation` (APPEND-ONLY: idempotent per-claim insert + read; no update/delete). */
export class PerDiemRateCalculationRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append a claim's HIPPS calculation, idempotent on `claim_id` (the 1:1 unique surface): on a duplicate the
   * INSERT no-ops and the existing row is read back, so a re-derivation collapses to the original row.
   * Returns the persisted calculation.
   */
  async append(values: schema.NewPerDiemRateCalculation): Promise<schema.PerDiemRateCalculation> {
    const [inserted] = await this.db
      .insert(H)
      .values(values)
      .onConflictDoNothing({ target: H.claimId })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findByClaim(values.claimId);
    if (!existing)
      throw new Error("per_diem_rate_calculation append: conflict but no existing row found");
    return existing;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.PerDiemRateCalculation | null> {
    const [row] = await this.db.select().from(H).where(eq(H.id, id)).limit(1);
    return row ?? null;
  }

  /** The 1:1 HIPPS calculation for a claim, or `null`. */
  async findByClaim(claimId: string): Promise<schema.PerDiemRateCalculation | null> {
    const [row] = await this.db.select().from(H).where(eq(H.claimId, claimId)).limit(1);
    return row ?? null;
  }
}
