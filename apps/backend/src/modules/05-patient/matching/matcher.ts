// apps/backend/src/modules/05-patient/matching/matcher.ts — the M5 patient-matching engine
// (§2.3, §7.2, §7.3; D2). DETERMINISTIC-FIRST then PROBABILISTIC-QUEUED; auto-merge FORBIDDEN.
//
// Pure: given a normalized incoming patient + the candidate set the service preselected (by org,
// blocking keys), classify the create as `hard_block` (a deterministic or ≥0.92 probabilistic hit —
// 409, no row created, §7.2), `soft_review` (any candidate in [0.75,0.92) — create the patient AND
// open a patient_match_review per candidate, §7.3), or `quiet_create` (no candidate ≥0.75). The
// service (T09) does the DB I/O; this engine owns the algorithm so the thresholds + weights have one
// home and a future ML re-tune is an explicit governance change (M32), never silent drift.
//
// DEFENSE IN DEPTH (W-M5-17): the probabilistic feature set NEVER includes SSN — it is used ONLY by
// the deterministic SSN+DOB rule (D2). SSN is never a fuzzy signal and never leaks into a score.

import { jaroWinkler, levenshtein } from "./similarity";

/** A normalized address fragment used for comparison (already USPS-normalized by the caller). */
export interface MatchAddress {
  readonly line1: string;
  readonly city: string;
  readonly postalCode: string;
}

/** The normalized identity fields the matcher compares (names already upper-cased, DOB ISO). */
export interface MatchSubject {
  readonly lastName: string;
  readonly firstName: string;
  readonly dob: string; // ISO yyyy-mm-dd
  readonly mbi?: string | null;
  readonly ssn?: string | null; // used ONLY by the deterministic SSN+DOB rule, never probabilistic
  readonly primaryAddress?: MatchAddress | null;
  readonly phoneLast7?: string | null;
  readonly email?: string | null;
}

/** An existing candidate patient, carrying its id alongside the comparable identity. */
export interface MatchCandidate extends MatchSubject {
  readonly id: string;
}

/** The §2.3 deterministic rule that fired (for the §7.2 `matchedOn` response + audit). */
export type DeterministicRule = "mbi" | "ssn_dob" | "dob_name_address";

/** Tunable thresholds (D2: tenant-configurable within tight bounds). */
export interface MatchThresholds {
  /** Probabilistic hard-block floor. Default 0.92; clamped to ≥ 0.85 (D2 floor). */
  readonly hard: number;
  /** Soft-review floor. Default 0.75; clamped to ≤ 0.80 (D2 ceiling). */
  readonly soft: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = { hard: 0.92, soft: 0.75 };

/** Clamp tenant thresholds into the D2 bounds (hard ≥ 0.85; soft ≤ 0.80; hard > soft). */
export function clampThresholds(t: MatchThresholds): MatchThresholds {
  const hard = Math.max(0.85, t.hard);
  const soft = Math.min(0.8, t.soft);
  return { hard, soft: Math.min(soft, hard - 0.0001) };
}

/** A scored candidate (probabilistic pass). `score` is in [0,1]. */
export interface ScoredCandidate {
  readonly id: string;
  readonly score: number;
}

/** The matcher's decision. */
export type MatchResult =
  | { readonly outcome: "hard_block"; readonly existingPatientId: string; readonly matchedOn: DeterministicRule | "probabilistic"; readonly score?: number }
  | { readonly outcome: "soft_review"; readonly reviewCandidates: readonly ScoredCandidate[] }
  | { readonly outcome: "quiet_create"; readonly topScore: number };

/** Does deterministic rule R hard-match the incoming against this candidate? (§2.3, D2). */
function deterministicRule(incoming: MatchSubject, c: MatchCandidate): DeterministicRule | null {
  // 1. exact MBI
  if (incoming.mbi && c.mbi && incoming.mbi === c.mbi) return "mbi";
  // 2. exact SSN + exact DOB
  if (incoming.ssn && c.ssn && incoming.ssn === c.ssn && incoming.dob === c.dob) return "ssn_dob";
  // 3. exact DOB + normalized last+first + matching primary address line1+city+postal
  if (
    incoming.dob === c.dob &&
    incoming.lastName === c.lastName &&
    incoming.firstName === c.firstName &&
    incoming.primaryAddress &&
    c.primaryAddress &&
    incoming.primaryAddress.line1 === c.primaryAddress.line1 &&
    incoming.primaryAddress.city === c.primaryAddress.city &&
    incoming.primaryAddress.postalCode === c.primaryAddress.postalCode
  ) {
    return "dob_name_address";
  }
  return null;
}

/** The §2.3 weighted probabilistic score in [0,1] (SSN deliberately absent from the features). */
export function probabilisticScore(incoming: MatchSubject, c: MatchCandidate): number {
  let score = 0;
  score += 0.25 * jaroWinkler(incoming.lastName, c.lastName);
  score += 0.15 * jaroWinkler(incoming.firstName, c.firstName);
  // address: exact line1+city+postal → 0.20; else line1 JW > 0.85 → 0.10
  if (incoming.primaryAddress && c.primaryAddress) {
    const a = incoming.primaryAddress;
    const b = c.primaryAddress;
    if (a.line1 === b.line1 && a.city === b.city && a.postalCode === b.postalCode) score += 0.2;
    else if (jaroWinkler(a.line1, b.line1) > 0.85) score += 0.1;
  }
  // DOB: exact → 0.20; else Levenshtein ≤ 1 → 0.10
  if (incoming.dob === c.dob) score += 0.2;
  else if (levenshtein(incoming.dob, c.dob) <= 1) score += 0.1;
  // phone last-7 → 0.10
  if (incoming.phoneLast7 && c.phoneLast7 && incoming.phoneLast7 === c.phoneLast7) score += 0.1;
  // email → 0.05
  if (incoming.email && c.email && incoming.email === c.email) score += 0.05;
  return Math.min(1, score);
}

/**
 * Run the full §2.3 pipeline against the preselected candidate set. Deterministic rules win first
 * (any hit → hard_block, §7.2). Otherwise score every candidate: a max ≥ `hard` is a hard block
 * (§7.2); any candidate in `[soft, hard)` opens a review (§7.3, still creates the patient); below
 * `soft` is a quiet create. Auto-merge never happens — a hard block returns the existing id for the
 * reviewer, it does not merge.
 */
export function runMatch(
  incoming: MatchSubject,
  candidates: readonly MatchCandidate[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchResult {
  const { hard, soft } = clampThresholds(thresholds);

  // Deterministic pass — first hit wins (stable order = candidate order).
  for (const c of candidates) {
    const rule = deterministicRule(incoming, c);
    if (rule !== null) return { outcome: "hard_block", existingPatientId: c.id, matchedOn: rule };
  }

  // Probabilistic pass.
  const scored = candidates
    .map((c) => ({ id: c.id, score: probabilisticScore(incoming, c) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (top === undefined) return { outcome: "quiet_create", topScore: 0 };

  if (top.score >= hard) {
    return { outcome: "hard_block", existingPatientId: top.id, matchedOn: "probabilistic", score: top.score };
  }
  const reviewCandidates = scored.filter((s) => s.score >= soft && s.score < hard);
  if (reviewCandidates.length > 0) return { outcome: "soft_review", reviewCandidates };
  return { outcome: "quiet_create", topScore: top.score };
}
