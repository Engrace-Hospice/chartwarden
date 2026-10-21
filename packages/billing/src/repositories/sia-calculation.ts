// @chartwarden/billing · repositories — `sia_calculation` (the Service Intensity Add-on math for the
// last-7-days-of-life window, §3.3; 0..1 with `claim` via `sia_calculation_claim_uq`). APPEND-ONLY —
// mirrors the `validation_run` exemplar: INSERT + READ ONLY, deliberately NO update/delete method (the DB
// carries an append-only write-audit trigger from P1; the SIA math is recorded once at assembly and never
// mutated — a re-assembly is a re-derivation behind the same idempotent claim key).
//
// IDEMPOTENCY: `append` is INSERT … ON CONFLICT (claim_id) DO NOTHING then read-back, so a re-run of the
// SIA calculator for the same claim collapses to the original row. ENUM BOUNDARY: there is NO enum on this
// table — each qualifying care record's `discipline` lives inside the typed `qualifying_visits` jsonb as the
// raw discipline token, so rows pass through un-mapped. No PHI / MBI (D13 / §8.7); money is integer cents (D8).
import * as schema from "@chartwarden/db/schema";
import { eq } from "drizzle-orm";
import type { BillingDb } from "./db";

const S = schema.siaCalculation;

/** Data port for `sia_calculation` (APPEND-ONLY: idempotent per-claim insert + read; no update/delete). */
export class SiaCalculationRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append a claim's SIA calculation, idempotent on `claim_id` (the 0..1 unique surface): on a duplicate the
   * INSERT no-ops and the existing row is read back, so a re-derivation collapses to the original row.
   * Returns the persisted calculation.
   */
  async append(values: schema.NewSiaCalculation): Promise<schema.SiaCalculation> {
    const [inserted] = await this.db
      .insert(S)
      .values(values)
      .onConflictDoNothing({ target: S.claimId })
      .returning();
    if (inserted) return inserted;
    const existing = await this.findByClaim(values.claimId);
    if (!existing) throw new Error("sia_calculation append: conflict but no existing row found");
    return existing;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.SiaCalculation | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /** The 0..1 SIA calculation for a claim, or `null`. */
  async findByClaim(claimId: string): Promise<schema.SiaCalculation | null> {
    const [row] = await this.db.select().from(S).where(eq(S.claimId, claimId)).limit(1);
    return row ?? null;
  }
}
