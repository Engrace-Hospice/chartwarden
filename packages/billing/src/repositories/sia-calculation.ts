// @chartwarden/billing · repositories — `sia_calculation` (the Service Intensity Add-on math for the last-7-days-of-life
// window, §3.3). APPEND-ONLY, one row per (claim, revision) — `sia_calculation_claim_revision_uq`, migrations 1511/1512. The DB
// carries an append-only write-audit trigger from P1 (UPDATE always refused; DELETE only for a deletable DRAFT claim's own
// rows, 1061), so a re-derivation after a visit fact or the CHC rate changed is a NEW ROW — `appendSiaRevision` writes
// revision = latest + 1 — and the newest revision is the claim's current SIA calculation (`findLatestSiaByClaim`). There is
// deliberately NO update/delete method. No PHI / MBI (D13 / §8.7); money is integer cents (D8).
//
// ENUM BOUNDARY: there is NO enum on this table — each visit's `discipline` and exclusion reason live inside the typed jsonb as
// the raw tokens, so rows pass through un-mapped.
import * as schema from "@chartwarden/db/schema";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { desc, eq, sql } from "drizzle-orm";
import { SNAPSHOT_MUTABLE_STATES } from "./claim";
import { type BillingDb, claimStateCodec } from "./db";

const S = schema.siaCalculation;

/**
 * What one `units_v2` revision records, filled by claim assembly / re-validation from `calculateSia`'s result plus the CHC
 * rate it priced with. `basis` is always stamped 'units_v2' and `revision` is assigned (latest + 1) by
 * {@link SiaCalculationRepository.appendSiaRevision}; neither is an input. The legacy fields (`qualifyingVisits`,
 * `totalQualifyingMinutes`, `siaAddOnCents`, `windowStart`) stay filled so older readers keep working.
 */
export interface SiaSnapshotInput {
  readonly organizationId: string;
  readonly claimId: string;
  readonly patientDeceasedDate: string; // ISO date
  readonly windowStart: string; // ISO date, deceased date - 6
  readonly qualifyingVisits: readonly schema.SiaQualifyingVisit[]; // the COUNTED visits
  readonly totalQualifyingMinutes: number;
  readonly siaAddOnCents: number;
  readonly paidUnits: number;
  readonly eligibleUnits: number;
  readonly truncatedUnits: number;
  /** The rate the add-on was priced at; `null` only on a row with no payable units (nothing was priced). */
  readonly chcHourlyRateCents: number | null;
  readonly wageIndexFiscalYear: number | null;
  readonly wageIndexFactor: string | null;
  readonly policy: schema.SiaCalculationPolicy;
  /** `calculateSia(...).evaluation.visits`: every visit in the window with its counted/excluded verdict. */
  readonly visitOutcomes: readonly schema.SiaVisitOutcomeRecord[];
  readonly priorClaimAdvisory: schema.SiaPriorClaimAdvisory | null;
}

/** Data port for `sia_calculation` (APPEND-ONLY: revision insert + read; no update/delete). */
export class SiaCalculationRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append the claim's next `units_v2` revision (1 when it has none): ONE statement computes revision = latest + 1, so two
   * writers cannot both read the same latest and silently overwrite. A genuine race on the same claim fails loudly on the
   * unique index (23505) rather than losing a row. Returns the persisted row.
   */
  async appendSiaRevision(input: SiaSnapshotInput): Promise<schema.SiaCalculation> {
    const [row] = await this.db
      .insert(S)
      .values({
        organizationId: input.organizationId,
        claimId: input.claimId,
        patientDeceasedDate: input.patientDeceasedDate,
        windowStart: input.windowStart,
        qualifyingVisits: input.qualifyingVisits.map((v) => ({ ...v })),
        totalQualifyingMinutes: input.totalQualifyingMinutes,
        siaAddOnCents: input.siaAddOnCents,
        paidUnits: input.paidUnits,
        eligibleUnits: input.eligibleUnits,
        truncatedUnits: input.truncatedUnits,
        chcHourlyRateCents: input.chcHourlyRateCents,
        wageIndexFiscalYear: input.wageIndexFiscalYear,
        wageIndexFactor: input.wageIndexFactor,
        policy: { ...input.policy },
        visitOutcomes: input.visitOutcomes.map((v) => ({ ...v })),
        priorClaimAdvisory: input.priorClaimAdvisory ? { ...input.priorClaimAdvisory } : null,
        basis: "units_v2",
        revision: sql`(SELECT COALESCE(MAX(${S.revision}), 0) + 1 FROM ${S} WHERE ${S.claimId} = ${input.claimId})`,
      })
      .returning();
    if (!row) throw new Error("sia_calculation appendSiaRevision: insert returned no row");
    return row;
  }

  /** Point read by id, or `null`. */
  async findById(id: string): Promise<schema.SiaCalculation | null> {
    const [row] = await this.db.select().from(S).where(eq(S.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Serialise revision writers for ONE claim: `SELECT … FOR NO KEY UPDATE` on the claim row, held to the end of the caller's
   * transaction. Two overlapping re-validations would otherwise both read revision N, both decide to append, and the
   * second would die on `sia_calculation_claim_revision_uq` with a raw unique violation. Call before the
   * read-compare-append.
   *
   * The claim's state is read UNDER the lock: a submit that committed after the caller's own earlier (unlocked) read would
   * otherwise surface as the database guard's raw `check_violation` (`M23_SIA_CLAIM_NOT_MUTABLE`, migration 1512). A claim
   * that is no longer DRAFT, VALIDATING or READY gets the same 409 the snapshot refresh gives a frozen claim, and nothing is
   * appended: the add-on a claim was billed with is not superseded. A claim that is absent under the lock (removed by the
   * destruction role after the caller read it, or not visible to this tenant) answers 404, like the claim lookup before it.
   */
  async lockClaimForRevision(claimId: string): Promise<void> {
    const [row] = await this.db
      .select({ state: schema.claim.state })
      .from(schema.claim)
      .where(eq(schema.claim.id, claimId))
      .limit(1)
      // NO KEY UPDATE, not UPDATE: it still serialises every revision writer (they all take it), but unlike FOR UPDATE it
      // does not conflict with the KEY SHARE lock a concurrent child insert (claim_submission, ...) takes on this row.
      .for("no key update");
    // The caller has already loaded this claim, so its absence under the lock means it was removed after that read (only the
    // destruction role can delete a claim past DRAFT) or is not visible to this tenant. Without this the INSERT that follows
    // would hit the guard trigger, which runs before any FK check and raises a raw `check_violation` ("claim state: not
    // found") that the error handler turns into a 500.
    if (row === undefined) throw new NotFoundError("claim", claimId);
    const state = claimStateCodec.fromDb(row.state);
    if (SNAPSHOT_MUTABLE_STATES.includes(state)) return;
    throw new ChartWardenError(
      "CLAIM_SIA_IMMUTABLE",
      `the SIA add-on of a claim in state '${state}' cannot be revised; only a draft, validating or ready claim's can`,
      409,
    );
  }

  /** The claim's CURRENT SIA calculation (its highest revision), or `null` when it never had one. */
  async findLatestSiaByClaim(claimId: string): Promise<schema.SiaCalculation | null> {
    const [row] = await this.db
      .select()
      .from(S)
      .where(eq(S.claimId, claimId))
      .orderBy(desc(S.revision))
      .limit(1);
    return row ?? null;
  }
}
