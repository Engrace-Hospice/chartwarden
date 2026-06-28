// M25 — per-line posting outcome (§2.4). PURE. Given the CLP02 payer claim-status code and the
// charge/payment amounts, classify the line's outcome — which drives the M23 claim-state event
// (m25.remittance.claim_paid / .claim_partial_paid / .claim_denied / .claim_recouped).
import type { PostingOutcome } from "./types";

/** CLP02 reversal status — a recoupment of a previously paid claim (42 CFR §424.526). */
export const CLP_STATUS_REVERSAL = 22;

/** Dollar tolerance for treating "paid == charged" as a full payment (mirrors the D3 $1 heuristic band). */
const FULL_PAYMENT_TOLERANCE = 1;

/**
 * Classify a remittance line's posting outcome.
 * - CLP02 = 22 → `recouped` (reversal/offset), regardless of amounts.
 * - payment <= 0 → `denied`.
 * - payment >= charge − $1 → `paid` (full).
 * - otherwise → `partial_paid`.
 */
export function classifyPostingOutcome(
  clp02StatusCode: number,
  totalCharge: number,
  totalPayment: number,
): PostingOutcome {
  if (clp02StatusCode === CLP_STATUS_REVERSAL) return "recouped";
  if (totalPayment <= 0) return "denied";
  if (totalPayment >= totalCharge - FULL_PAYMENT_TOLERANCE) return "paid";
  return "partial_paid";
}

/** The M23-consumer outbox event a posting outcome emits (§2.4 / §4.5). */
export function outcomeEventKind(outcome: PostingOutcome): string {
  switch (outcome) {
    case "paid":
      return "m25.remittance.claim_paid";
    case "partial_paid":
      return "m25.remittance.claim_partial_paid";
    case "denied":
      return "m25.remittance.claim_denied";
    case "recouped":
      return "m25.remittance.claim_recouped";
  }
}
