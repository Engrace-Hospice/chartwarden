// @wardenx/billing · repositories — `eligibility_check` (HETS 270/271 result cache per (patient, as-of-date),
// §3.3, D13; non-partitioned; retention class `compliance`). ORG-SCOPED; APPEND-ONLY (the P1 DB write-audit
// trigger denies UPDATE/DELETE — this repo mirrors that by offering NO mutating surface).
//
// MBI NEVER PERSISTED (D13 / §3.6 / §8.7): the MBI submitted to HETS is built at request time from M5's
// encrypted MBI and is NEVER stored here. The `eligibility_check` row + this repo carry only the parsed
// outcome, the as-of service date, a coverage-flags `parsedPayload` (opaque at the DB layer; the service
// guarantees it holds NO MBI digits), an optional MinIO ref to the raw 271, and the staleness target — so
// there is structurally no MBI column for this port to read or write.
//
// NOT IDEMPOTENT (§3.5): a re-check on the same `(patient, as_of_date)` inserts a NEW row (so the freshness
// read always sees the latest `checked_at`); the §11.A rule then reads the MOST-RECENT row only. Contrast
// `validation_run`, which dedups on an idempotency key.
//
// ENUM BOUNDARY: `outcome` diverges (the DB has 5 values — incl. `mbi_invalid`/`hets_error` — vs the domain
// `EligibilityOutcome`'s 4), so every read maps through `eligibilityOutcomeCodec.fromDb` (DB `mbi_invalid`
// and `hets_error` both fold to domain `error`; `unknown_response` ↔ `indeterminate`) and writes map through
// `.toDb` (domain `error` → the canonical DB `hets_error`). The case/value never leaks past this boundary.
import * as schema from "@wardenx/db/schema";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { EligibilityOutcome } from "../contracts";
import { type BillingDb, eligibilityOutcomeCodec } from "./db";

const E = schema.eligibilityCheck;

/** DB-side `outcome` values that count as a usable (resolved) eligibility determination for the freshness rule. */
const RESOLVED_DB_OUTCOMES = ["active_part_a", "inactive_part_a"] as const;

/** The domain-cased `eligibility_check` row: `outcome` mapped to the domain `EligibilityOutcome`. */
export interface EligibilityCheckRecord extends Omit<schema.EligibilityCheck, "outcome"> {
  readonly outcome: EligibilityOutcome;
}

/** Append input: the Drizzle insert shape with `outcome` as the domain `EligibilityOutcome`. */
export type NewEligibilityCheckInput = Omit<schema.NewEligibilityCheck, "outcome"> & {
  readonly outcome: EligibilityOutcome;
};

/** Map a DB row to the domain-cased record (the single read-boundary outcome translation). */
function toEligibilityRecord(row: schema.EligibilityCheck): EligibilityCheckRecord {
  return { ...row, outcome: eligibilityOutcomeCodec.fromDb(row.outcome) };
}

/** Data port for `eligibility_check` (APPEND-ONLY: insert + read; no update/delete; outcome codec mapped). */
export class EligibilityCheckRepository {
  constructor(private readonly db: BillingDb) {}

  /**
   * Append a 270/271 result. NOT idempotent — every check is a new row (§3.5), so a same-day re-check
   * refreshes `checked_at`. Maps the domain `outcome` to the DB enum. Returns the domain-cased record.
   */
  async append(input: NewEligibilityCheckInput): Promise<EligibilityCheckRecord> {
    const { outcome, ...rest } = input;
    const values: schema.NewEligibilityCheck = {
      ...rest,
      outcome: eligibilityOutcomeCodec.toDb(outcome),
    };
    const [row] = await this.db.insert(E).values(values).returning();
    if (!row) throw new Error("eligibility_check insert returned no row");
    return toEligibilityRecord(row);
  }

  /** Point read by id (domain-cased), or `null`. */
  async findById(id: string): Promise<EligibilityCheckRecord | null> {
    const [row] = await this.db.select().from(E).where(eq(E.id, id)).limit(1);
    return row ? toEligibilityRecord(row) : null;
  }

  /** The most-recent check for a patient (any outcome), newest `checked_at` first, or `null`. */
  async findLatestForPatient(
    organizationId: string,
    patientId: string,
  ): Promise<EligibilityCheckRecord | null> {
    const [row] = await this.db
      .select()
      .from(E)
      .where(and(eq(E.organizationId, organizationId), eq(E.patientId, patientId)))
      .orderBy(desc(E.checkedAt))
      .limit(1);
    return row ? toEligibilityRecord(row) : null;
  }

  /**
   * The most-recent RESOLVED check for a patient — `outcome IN ('active_part_a','inactive_part_a')` (the
   * `eligibility_check_recent_per_patient` partial-index read) — newest `checked_at` first, or `null`. This
   * is the §11.A 30-day-freshness rule input (the service compares `checked_at` to the 30-day window;
   * `mbi_invalid`/`unknown_response`/`hets_error` rows are NOT a usable determination and are skipped).
   */
  async findLatestResolvedForPatient(
    organizationId: string,
    patientId: string,
  ): Promise<EligibilityCheckRecord | null> {
    const [row] = await this.db
      .select()
      .from(E)
      .where(
        and(
          eq(E.organizationId, organizationId),
          eq(E.patientId, patientId),
          inArray(E.outcome, [...RESOLVED_DB_OUTCOMES]),
        ),
      )
      .orderBy(desc(E.checkedAt))
      .limit(1);
    return row ? toEligibilityRecord(row) : null;
  }

  /** A patient's eligibility checks, newest `checked_at` first (bounded read for the patient timeline). */
  async listForPatient(
    organizationId: string,
    patientId: string,
    opts: { limit?: number } = {},
  ): Promise<readonly EligibilityCheckRecord[]> {
    const rows = await this.db
      .select()
      .from(E)
      .where(and(eq(E.organizationId, organizationId), eq(E.patientId, patientId)))
      .orderBy(desc(E.checkedAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    return rows.map(toEligibilityRecord);
  }

  /**
   * Rows whose `stale_at` has passed `asOf` for an org — the `eligibility_check_stale_idx` scan the daily
   * eligibility-stale-watchdog cron drains to raise the `eligibility.expired` notification. Bounded; oldest
   * `stale_at` first so the cron works the most-overdue first.
   */
  async listStaleForOrg(
    organizationId: string,
    asOf: Date,
    opts: { limit?: number } = {},
  ): Promise<readonly EligibilityCheckRecord[]> {
    const rows = await this.db
      .select()
      .from(E)
      .where(and(eq(E.organizationId, organizationId), lt(E.staleAt, asOf)))
      .orderBy(E.staleAt)
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
    return rows.map(toEligibilityRecord);
  }
}
