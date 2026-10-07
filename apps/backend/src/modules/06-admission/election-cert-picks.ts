// apps/backend/src/modules/06-admission/election-cert-picks.ts — which ONE election statement / CTI /
// face-to-face row the Election & Certification view shows for a benefit period. PURE.
//
// A period can carry more than one row of each kind: `cti_period_active_idx` allows at most one
// NON-voided CTI but any number of voided ones (a voided CTI is kept as the record of what was
// certified, 42 CFR 418.22 / 418.104), and `f2f_period_attested_idx` allows at most one ATTESTED
// face-to-face beside any number of scheduled / completed ones. The read used to build a
// `Map(rows.map(r => [periodId, r]))`, so whichever row the database happened to return last won —
// a voided CTI could hide the live one and the view would tell the user the period was uncertified.
//
// The pick is now deterministic: the most-live status wins (the rank tables below), then the newest
// `createdAt`, then the highest `version`, then the later input position. A voided row is shown only
// when no live row exists, and is then shown AS voided.

/** A per-period row the pick compares. `createdAt` / `version` are optional tiebreaks. */
export interface PerPeriodCandidate {
  readonly electionPeriodId: string;
  readonly status: string;
  readonly createdAt?: Date | string | null;
  readonly version?: number | bigint | string | null;
}

/** Higher = more live. Signed outranks every in-flight state; superseded / voided only as a fallback. */
export const CTI_STATUS_RANK: Readonly<Record<string, number>> = {
  signed: 5,
  awaiting_attending: 4,
  awaiting_hospice_md: 3,
  drafted: 2,
  superseded: 1,
  voided: 0,
};

/** The attested encounter is the one that satisfies 42 CFR 418.22(a)(4); then completed, then scheduled. */
export const F2F_STATUS_RANK: Readonly<Record<string, number>> = {
  attested: 2,
  completed: 1,
  scheduled: 0,
};

/** `election_statement_period_idx` keeps one row per period today; ranked anyway so the view never
 *  depends on that index staying total. */
export const ELECTION_STATEMENT_STATUS_RANK: Readonly<Record<string, number>> = {
  signed: 2,
  drafted: 1,
  voided: 0,
};

/** A status missing from the rank table sorts below every known one. */
const UNKNOWN_STATUS_RANK = -1;

const timeOf = (v: PerPeriodCandidate["createdAt"]): number => {
  if (v === null || v === undefined) return Number.NEGATIVE_INFINITY;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

const versionOf = (v: PerPeriodCandidate["version"]): number =>
  v === null || v === undefined ? Number.NEGATIVE_INFINITY : Number(v);

/** True when `a` should be shown instead of `b` (ties fall to the caller: the later input row wins). */
function outranks(
  a: PerPeriodCandidate,
  b: PerPeriodCandidate,
  rank: Readonly<Record<string, number>>,
): boolean | null {
  const ra = rank[a.status] ?? UNKNOWN_STATUS_RANK;
  const rb = rank[b.status] ?? UNKNOWN_STATUS_RANK;
  if (ra !== rb) return ra > rb;
  const ta = timeOf(a.createdAt);
  const tb = timeOf(b.createdAt);
  if (ta !== tb) return ta > tb;
  const va = versionOf(a.version);
  const vb = versionOf(b.version);
  if (va !== vb) return va > vb;
  return null;
}

/** One row per `electionPeriodId`, chosen by `rank` then newest `createdAt`, then `version`. */
export function pickOnePerPeriod<T extends PerPeriodCandidate>(
  rows: readonly T[],
  rank: Readonly<Record<string, number>>,
): ReadonlyMap<string, T> {
  const picked = new Map<string, T>();
  for (const row of rows) {
    const current = picked.get(row.electionPeriodId);
    if (current === undefined || outranks(row, current, rank) !== false) {
      picked.set(row.electionPeriodId, row);
    }
  }
  return picked;
}
