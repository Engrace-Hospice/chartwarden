// apps/backend/src/modules/05-patient/match-review-db.ts — GAP-019: the §7.3 soft-duplicate review rows.
//
// `admit` used to insert the patient and return `matchReviewIds: []` ("a follow-up"), so a probable
// duplicate chart was created silently and nothing ever reached a reviewer. It now inserts one
// `patient_match_review` row per soft candidate in the SAME transaction as the patient, and returns their
// ids (spec §7.3: "201 + matchReviewIds").
import { type DbClient, schema } from "@wardenx/db";
import type { MatchSubject, ScoredCandidate } from "./matching/matcher";
import { DEFAULT_THRESHOLDS } from "./matching/matcher";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const REVIEW = schema.patientMatchReviews;

const SCORE_DECIMALS = 4;

/** What is stored as `candidate_incoming`: the normalized identity the matcher compared, minus SSN
 *  (SSN is never a fuzzy signal and never stored in plaintext outside its envelope-encrypted column). */
function incomingSnapshot(incoming: MatchSubject): Record<string, unknown> {
  return {
    lastName: incoming.lastName,
    firstName: incoming.firstName,
    dob: incoming.dob,
    mbi: incoming.mbi ?? null,
    primaryAddress: incoming.primaryAddress ?? null,
    phoneLast7: incoming.phoneLast7 ?? null,
    email: incoming.email ?? null,
  };
}

/** Insert one open review per soft candidate (highest score first); returns the new row ids in that order. */
export async function insertSoftMatchReviews(
  tx: Tx,
  organizationId: string,
  newPatientId: string,
  incoming: MatchSubject,
  candidates: readonly ScoredCandidate[],
  options: { readonly rule?: string } = {},
): Promise<string[]> {
  const ordered = [...candidates].sort((a, b) => b.score - a.score);
  const ids: string[] = [];
  for (const candidate of ordered) {
    const rows = (await tx
      .insert(REVIEW)
      .values({
        organizationId,
        candidateExistingPatientId: candidate.id,
        newPatientId,
        candidateIncoming: incomingSnapshot(incoming),
        score: candidate.score.toFixed(SCORE_DECIMALS),
        featureBreakdown: {
          rule: options.rule ?? "probabilistic",
          score: candidate.score,
          softThreshold: DEFAULT_THRESHOLDS.soft,
          hardThreshold: DEFAULT_THRESHOLDS.hard,
        },
        status: "open",
      })
      .returning({ id: REVIEW.id })) as Array<{ id: string }>;
    ids.push(rows[0]!.id);
  }
  return ids;
}
