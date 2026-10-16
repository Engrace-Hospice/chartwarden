// M25 milestone 5 — the TPE (Targeted Probe and Educate) program tracker. PURE. The tracker RECORDS what the MAC sends
// (rounds, its results letter, education dates, the outcome); it computes only what the program rules leave no room
// for. Per-MAC exit thresholds are NOT verified, so they are per-organization dated rule data with no seed and no
// default in code: a missing threshold resolves to `pct: null` and the screen says so.
import { MS_PER_DAY, isoDay, parseNoticeDay } from "./deadline";

// Verified basis (PRD): a TPE program is at most 3 rounds, rounds are at least 45 days apart, and a round samples
// 20-40 claims. The sample range and the interval are surfaced as WARNINGS only: the MAC sets the dates and the
// sample, and the hospice must record what really happened. What the interval counts from is SME-unconfirmed.
export const TPE_MAX_ROUNDS = 3;
export const TPE_MIN_INTERVAL_DAYS = 45;
export const TPE_SAMPLE_MIN = 20;
export const TPE_SAMPLE_MAX = 40;

export type TpeProgramState = "active" | "compliant" | "referred" | "closed";
export const TPE_PROGRAM_STATES: readonly TpeProgramState[] = [
  "active",
  "compliant",
  "referred",
  "closed",
];

/** The result the MAC's letter states for a round; the letter, not our count, is official. */
export const TPE_MAC_RESULTS = ["compliant", "non_compliant"] as const;
export type TpeMacResult = (typeof TPE_MAC_RESULTS)[number];

export const TPE_CLAIM_RESULTS = ["pending", "no_error", "error"] as const;
export type TpeClaimResult = (typeof TPE_CLAIM_RESULTS)[number];

/** Referral kinds from the PRD; the full CMS list (for example UPIC) is SME-unconfirmed, `other` covers it. */
export const TPE_REFERRAL_KINDS = ["prepay_review", "extrapolation", "rac", "other"] as const;
export type TpeReferralKind = (typeof TPE_REFERRAL_KINDS)[number];

// The same edges as the database guard trigger in migration 1118.
const PROGRAM_EDGES: Readonly<Record<TpeProgramState, readonly TpeProgramState[]>> = {
  active: ["compliant", "referred", "closed"],
  compliant: ["closed"],
  referred: ["closed"],
  closed: [],
};

export function canTransitionTpeProgram(from: TpeProgramState, to: TpeProgramState): boolean {
  return PROGRAM_EDGES[from].includes(to);
}

export interface TpeRuleRow {
  readonly macName: string;
  readonly exitErrorRatePct: number;
  /** Day (YYYY-MM-DD) someone confirmed the number against the MAC's letter; null = unverified. */
  readonly verifiedOn: string | null;
  readonly sourceNote: string | null;
  readonly effectiveFrom: string;
}

export interface TpeThreshold {
  /** null = the organization has recorded no threshold for this MAC; nothing is assumed. */
  readonly pct: number | null;
  readonly source: "org_rule" | "none";
  readonly verified: boolean;
  readonly sourceNote: string | null;
}

/** The newest rule in force for the MAC (case-insensitive), or "none". `asOf` defaults to no date filter. */
export function resolveTpeThreshold(
  rules: readonly TpeRuleRow[],
  macName: string,
  asOf?: string,
): TpeThreshold {
  const wanted = macName.trim().toLowerCase();
  const rule = rules
    .filter(
      (r) =>
        r.macName.trim().toLowerCase() === wanted &&
        (asOf === undefined || r.effectiveFrom <= asOf),
    )
    .reduce<TpeRuleRow | undefined>(
      (best, r) => (best === undefined || r.effectiveFrom > best.effectiveFrom ? r : best),
      undefined,
    );
  if (!rule) return { pct: null, source: "none", verified: false, sourceNote: null };
  return {
    pct: rule.exitErrorRatePct,
    source: "org_rule",
    verified: rule.verifiedOn !== null,
    sourceNote: rule.sourceNote,
  };
}

export interface TpeClaimCountRate {
  readonly reviewed: number;
  readonly errors: number;
  readonly pct: number;
}

/** Advisory only ("claim count, not the MAC's calculation"): pending claims are excluded; null when none reviewed. */
export function claimCountErrorRate(
  claims: readonly { readonly result: string }[],
): TpeClaimCountRate | null {
  const reviewed = claims.filter((c) => c.result === "no_error" || c.result === "error");
  if (reviewed.length === 0) return null;
  const errors = reviewed.filter((c) => c.result === "error").length;
  return {
    reviewed: reviewed.length,
    errors,
    pct: Math.round((errors / reviewed.length) * 10_000) / 100,
  };
}

/** Education day + 45 days; null until an education day is known. */
export function nextRoundEarliest(educationOn: string | null): string | null {
  if (educationOn === null) return null;
  return isoDay(parseNoticeDay(educationOn) + TPE_MIN_INTERVAL_DAYS * MS_PER_DAY);
}

/** A warning (never a block) when a round's notice falls before the earliest allowed day. */
export function intervalWarning(prevEducationOn: string | null, noticeOn: string): string | null {
  const earliest = nextRoundEarliest(prevEducationOn);
  if (earliest === null || noticeOn >= earliest) return null;
  return `This round starts less than ${TPE_MIN_INTERVAL_DAYS} days after the previous round's education (earliest ${earliest}). Check the dates against the MAC's letter.`;
}

/** A warning (never a block) when the sample is outside the usual 20-40 claims. */
export function sampleSizeWarning(count: number): string | null {
  if (count >= TPE_SAMPLE_MIN && count <= TPE_SAMPLE_MAX) return null;
  return `${count} claims sampled; a TPE round usually samples ${TPE_SAMPLE_MIN} to ${TPE_SAMPLE_MAX}.`;
}

export type TpeReferralRisk = "relief" | "referred" | "unknown" | "low" | "elevated" | "high";

/** ADVISORY label, not a CMS determination. A recorded outcome wins; otherwise the latest round with a result. */
export function tpeReferralRisk(
  program: {
    readonly state: string;
    readonly outcomeOn: string | null;
    readonly referralKinds: readonly string[];
  },
  rounds: readonly { readonly roundNumber: number; readonly macResult: string | null }[],
): TpeReferralRisk {
  const referred =
    program.state === "referred" ||
    (program.state === "closed" && program.referralKinds.length > 0);
  if (referred) return "referred";
  const relief =
    program.state === "compliant" || (program.state === "closed" && program.outcomeOn !== null);
  if (relief) return "relief";
  const latest = rounds
    .filter((r) => r.macResult !== null)
    .reduce<(typeof rounds)[number] | undefined>(
      (best, r) => (best === undefined || r.roundNumber > best.roundNumber ? r : best),
      undefined,
    );
  if (!latest) return "unknown";
  if (latest.macResult === "compliant") return "low";
  return latest.roundNumber >= TPE_MAX_ROUNDS ? "high" : "elevated";
}
