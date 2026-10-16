// apps/backend/src/modules/25-remittance/routes/tpe-view.ts — M25 milestone 5: the read model of a TPE program.
// Turns stored rows into what the tracker screen shows (current round, the MAC's rate against the threshold, the
// advisory claim-count rate, the earliest next round, the advisory referral risk, warnings). No database access:
// the service loads the rows and passes them in. Nothing here computes a threshold; it is read from the round's own
// snapshot or, before any results, from the organization's rule (and is "none" when the organization has none).
import {
  TPE_MAX_ROUNDS,
  type TpeRuleRow,
  type TpeThreshold,
  claimCountErrorRate,
  intervalWarning,
  nextRoundEarliest,
  resolveTpeThreshold,
  sampleSizeWarning,
  tpeReferralRisk,
} from "../domain";

export interface TpeProgramRow {
  readonly id: string;
  readonly providerEntityId: string;
  readonly macName: string;
  readonly openedOn: string;
  readonly state: string;
  readonly outcomeOn: string | null;
  readonly reliefUntil: string | null;
  readonly referralKinds: readonly string[];
  readonly version: number;
}

export interface TpeRoundRow {
  readonly id: string;
  readonly tpeProgramId: string;
  readonly roundNumber: number;
  readonly noticeOn: string;
  readonly resultsOn: string | null;
  readonly macErrorRatePct: string | null;
  readonly macResult: string | null;
  readonly thresholdPct: string | null;
  readonly thresholdSource: string | null;
  readonly thresholdVerified: boolean;
  readonly educationOn: string | null;
  readonly educationNote: string | null;
  readonly version: number;
}

export interface TpeClaimRow {
  readonly id: string;
  readonly tpeRoundId: string;
  readonly claimId: string;
  readonly adrCaseId: string | null;
  readonly result: string;
  readonly version: number;
}

export interface TpeThresholdView {
  /** null = no threshold confirmed: the organization has recorded none for this MAC. */
  readonly pct: number | null;
  readonly source: string;
  readonly verified: boolean;
}

export interface TpeLatestRoundView {
  readonly roundNumber: number;
  readonly resultsOn: string;
  readonly macErrorRatePct: number | null;
  readonly macResult: string;
}

export interface TpeProgramSummary extends TpeProgramRow {
  readonly maxRounds: number;
  readonly roundsRecorded: number;
  /** The highest round number recorded, or null before round 1. */
  readonly currentRound: number | null;
  readonly latestRound: TpeLatestRoundView | null;
  readonly threshold: TpeThresholdView;
  /** MAC rate strictly above the threshold; null when either is missing. Whether "at" the threshold passes is SME-unconfirmed. */
  readonly aboveThreshold: boolean | null;
  /** Advisory only: "claim count, not the MAC's calculation", for the current round. */
  readonly claimCountRate: { reviewed: number; errors: number; pct: number } | null;
  readonly nextRoundEarliest: string | null;
  /** Advisory label, not a CMS determination. */
  readonly risk: string;
}

export interface TpeClaimView {
  readonly id: string;
  readonly claimId: string;
  readonly adrCaseId: string | null;
  readonly adrState: string | null;
  readonly result: string;
}

export interface TpeRoundView {
  readonly id: string;
  readonly roundNumber: number;
  readonly noticeOn: string;
  readonly resultsOn: string | null;
  readonly macErrorRatePct: number | null;
  readonly macResult: string | null;
  readonly threshold: TpeThresholdView | null;
  readonly educationOn: string | null;
  readonly educationNote: string | null;
  readonly claims: readonly TpeClaimView[];
  readonly claimCountRate: { reviewed: number; errors: number; pct: number } | null;
  readonly warnings: readonly string[];
  readonly version: number;
}

export interface TpeProgramDetail extends TpeProgramSummary {
  readonly rounds: readonly TpeRoundView[];
}

const toNumber = (v: string | null): number | null => (v === null ? null : Number(v));

const thresholdOfRound = (r: TpeRoundRow): TpeThresholdView | null =>
  r.thresholdSource === null
    ? null
    : { pct: toNumber(r.thresholdPct), source: r.thresholdSource, verified: r.thresholdVerified };

const viewOfResolved = (t: TpeThreshold): TpeThresholdView => ({
  pct: t.pct,
  source: t.source,
  verified: t.verified,
});

/** Summarise one program from its rounds, their claims and the organization's rules in force. */
export function summarizeProgram(
  program: TpeProgramRow,
  rounds: readonly TpeRoundRow[],
  claims: readonly TpeClaimRow[],
  rules: readonly TpeRuleRow[],
): TpeProgramSummary {
  const sorted = [...rounds].sort((a, b) => a.roundNumber - b.roundNumber);
  const current = sorted[sorted.length - 1];
  const resulted = sorted.filter((r) => r.macResult !== null && r.resultsOn !== null);
  const latest = resulted[resulted.length - 1];
  const threshold =
    (latest && thresholdOfRound(latest)) ??
    viewOfResolved(resolveTpeThreshold(rules, program.macName));
  const rate = latest ? toNumber(latest.macErrorRatePct) : null;
  const open = program.state === "active" && sorted.length < TPE_MAX_ROUNDS;
  return {
    ...program,
    maxRounds: TPE_MAX_ROUNDS,
    roundsRecorded: sorted.length,
    currentRound: current?.roundNumber ?? null,
    latestRound:
      latest && latest.resultsOn !== null && latest.macResult !== null
        ? {
            roundNumber: latest.roundNumber,
            resultsOn: latest.resultsOn,
            macErrorRatePct: rate,
            macResult: latest.macResult,
          }
        : null,
    threshold,
    aboveThreshold: rate !== null && threshold.pct !== null ? rate > threshold.pct : null,
    claimCountRate: current
      ? claimCountErrorRate(claims.filter((c) => c.tpeRoundId === current.id))
      : null,
    nextRoundEarliest: open && current ? nextRoundEarliest(current.educationOn) : null,
    risk: tpeReferralRisk(program, sorted),
  };
}

/** The full detail: every round with its claims (linked ADR state), warnings and the claim-count rate. */
export function detailOfProgram(
  program: TpeProgramRow,
  rounds: readonly TpeRoundRow[],
  claims: readonly TpeClaimRow[],
  rules: readonly TpeRuleRow[],
  adrStates: ReadonlyMap<string, string>,
): TpeProgramDetail {
  const sorted = [...rounds].sort((a, b) => a.roundNumber - b.roundNumber);
  const views = sorted.map((r, i): TpeRoundView => {
    const mine = claims.filter((c) => c.tpeRoundId === r.id);
    const prev = i > 0 ? sorted[i - 1] : undefined;
    const warnings = [
      intervalWarning(prev?.educationOn ?? null, r.noticeOn),
      // no warning while nothing is sampled yet: an empty round is simply not started
      mine.length > 0 ? sampleSizeWarning(mine.length) : null,
    ].filter((w): w is string => w !== null);
    return {
      id: r.id,
      roundNumber: r.roundNumber,
      noticeOn: r.noticeOn,
      resultsOn: r.resultsOn,
      macErrorRatePct: toNumber(r.macErrorRatePct),
      macResult: r.macResult,
      threshold: thresholdOfRound(r),
      educationOn: r.educationOn,
      educationNote: r.educationNote,
      claims: mine.map((c) => ({
        id: c.id,
        claimId: c.claimId,
        adrCaseId: c.adrCaseId,
        adrState: c.adrCaseId ? (adrStates.get(c.adrCaseId) ?? null) : null,
        result: c.result,
      })),
      claimCountRate: claimCountErrorRate(mine),
      warnings,
      version: r.version,
    };
  });
  return { ...summarizeProgram(program, rounds, claims, rules), rounds: views };
}
