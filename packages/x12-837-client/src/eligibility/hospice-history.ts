// @chartwarden/x12-837-client — derive the beneficiary's hospice election / benefit-period history from the
// parsed 271 hospice records. Pure.
//
// What HETS gives and does NOT give (CMS HETS 270/271 Companion Guide §7.16 + HETS2024-1 release §3.2):
//   - every NOE (election) and every billed benefit period on the beneficiary's CWF file, ACROSS ALL
//     hospices, regardless of the requested date(s) of service — capped at 180 NOEs + 180 billed periods
//     since April 2024 (50 billed periods before that);
//   - NO benefit-period number and no occurrence count ("Hospice providers should utilize the returned
//     Hospice episodes and/or NOE to determine Hospice status").
// Benefit periods run 90 / 90 / 60 / 60 … for the beneficiary's lifetime (42 CFR 418.21) and do not reset
// on revocation or a change of hospice (Medicare Claims Processing Manual ch. 11 §20.1.6 — CWF keeps the
// election and benefit periods). So the ordinal of a billed period is its position in the full, oldest-
// first list — computable ONLY when the list is complete (not capped) and nothing after the last billed
// period is still unbilled. Every other case returns `null` with the reason, never a guess.
import type { HospiceRecord, HospiceRevocationCode } from "./parse-271";

/** HETS returns at most this many billed hospice periods (and NOEs) per 271 (HETS2024-1, April 2024). */
export const HETS_HOSPICE_PERIOD_RETURN_CAP = 180;

/** One hospice period in the shape the readmission screen consumes. */
export interface HospicePeriod {
  readonly kind: "election" | "benefit_period";
  /** 1-based lifetime benefit-period ordinal; null for NOE rows or when the history is not complete. */
  readonly periodNumber: number | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly hospiceNpi: string | null;
  /** The period's end date when HETS reports it revoked/terminated (codes 1–3); null otherwise. */
  readonly revocationOrDischargeDate: string | null;
  readonly revocationCode: HospiceRevocationCode | null;
  readonly daysUsed: number | null;
}

/** Why `nextPeriodNumber` is (or is not) known. */
export type NextPeriodBasis =
  | "computed"
  | "election_open"
  | "election_status_uncertain"
  | "unbilled_election"
  | "history_truncated";

export interface HospiceHistory {
  /** Oldest → newest by start date (benefit periods and NOEs interleaved). */
  readonly periods: readonly HospicePeriod[];
  /**
   * true  — the most recent hospice record is an open spell (revocation code 0, no end or ending on/after
   *         the as-of date): Medicare rejects a new NOE until that election is terminated;
   * false — the most recent record is revoked/terminated, or there is no hospice history at all;
   * null  — not determinable (code 0 but the last billed period ended before the as-of date: either a
   *         final-claim discharge with no NOTR, or a later period not yet billed).
   */
  readonly electionOpen: boolean | null;
  /** HETS hit its return cap — older history may be missing, so ordinals are unknown. */
  readonly truncated: boolean;
  readonly billedPeriodCount: number;
  /** The benefit-period number a NEW election on the as-of date would start, or null (see basis). */
  readonly nextPeriodNumber: number | null;
  readonly nextPeriodBasis: NextPeriodBasis;
}

const REVOKED: ReadonlySet<string> = new Set(["1", "2", "3"]);

function dedupeByStart(records: readonly HospiceRecord[]): HospiceRecord[] {
  const byStart = new Map<string, HospiceRecord>();
  for (const r of records) {
    const prior = byStart.get(r.startDate);
    // Keep the richer row (a transfer can surface the same period twice; prefer one with an end date).
    if (!prior || (prior.endDate === null && r.endDate !== null)) byStart.set(r.startDate, r);
  }
  return [...byStart.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function electionStatus(latest: HospicePeriod | undefined, asOf: string): boolean | null {
  if (!latest) return false;
  if (latest.revocationCode !== null && REVOKED.has(latest.revocationCode)) return false;
  // Code 0 (or no code): open when the record has no end, or its end is on/after the as-of date.
  if (latest.endDate === null || latest.endDate >= asOf) {
    return latest.revocationCode === "0" || latest.kind === "election" ? true : null;
  }
  return null;
}

/** Derive the numbered history + open-election flag + next period number from the 271 hospice records. */
export function deriveHospiceHistory(
  records: readonly HospiceRecord[],
  opts: { readonly asOfServiceDate: string },
): HospiceHistory {
  const billed = dedupeByStart(records.filter((r) => r.kind === "benefit_period"));
  const elections = dedupeByStart(records.filter((r) => r.kind === "election"));
  const truncated =
    billed.length >= HETS_HOSPICE_PERIOD_RETURN_CAP ||
    elections.length >= HETS_HOSPICE_PERIOD_RETURN_CAP;

  const toPeriod = (r: HospiceRecord, periodNumber: number | null): HospicePeriod => ({
    kind: r.kind,
    periodNumber,
    startDate: r.startDate,
    endDate: r.endDate,
    hospiceNpi: r.hospiceNpi,
    revocationOrDischargeDate:
      r.revocationCode !== null && REVOKED.has(r.revocationCode) ? r.endDate : null,
    revocationCode: r.revocationCode,
    daysUsed: r.daysUsed,
  });

  const billedPeriods = billed.map((r, i) => toPeriod(r, truncated ? null : i + 1));
  const lastBilled = billedPeriods.at(-1);
  // An NOE with no billed period starting on its date and starting after the last billed period: that
  // election consumed at least one period nobody has billed yet (claims lag the period).
  const unbilledElections = elections.filter(
    (e) =>
      !billed.some((b) => b.startDate === e.startDate) &&
      (!lastBilled || e.startDate > (lastBilled.endDate ?? lastBilled.startDate)),
  );
  const periods = [...billedPeriods, ...elections.map((e) => toPeriod(e, null))].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || (a.kind === "election" ? -1 : 1),
  );
  // The most recent record decides the election status; on a tie the billed period (it has an end) wins.
  const latest = [...periods].sort(
    (a, b) => b.startDate.localeCompare(a.startDate) || (a.kind === "benefit_period" ? -1 : 1),
  )[0];
  const electionOpen = electionStatus(latest, opts.asOfServiceDate);

  const basis: NextPeriodBasis = truncated
    ? "history_truncated"
    : electionOpen === true
      ? "election_open"
      : unbilledElections.length > 0
        ? "unbilled_election"
        : electionOpen === null
          ? "election_status_uncertain"
          : "computed";
  return {
    periods,
    electionOpen,
    truncated,
    billedPeriodCount: billed.length,
    nextPeriodNumber: basis === "computed" ? billed.length + 1 : null,
    nextPeriodBasis: basis,
  };
}
