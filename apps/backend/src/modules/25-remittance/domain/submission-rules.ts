// M25 milestone 6a - receipt, approval and recovery rules for a submission attempt. PURE; refusals are reason codes the
// service turns into typed errors, none carries content.
import { containsMbi } from "./qic";
import type { SubmissionStatus } from "./submission";

/** The longest confirmation reference accepted (mirrors the filing routes). */
export const MAX_CONFIRMATION_REF_LENGTH = 200;

/** Days a `needs_manual` attempt may sit without proof before the nightly watch raises the alert. SME-unconfirmed. */
export const PROOF_MISSING_DAYS = 3;

export type ReceiptRefusal =
  | "PROOF_REQUIRED"
  | "REFERENCE_TOO_LONG"
  | "MBI_NOT_ALLOWED"
  | "RECEIPT_TIME_INVALID"
  | "RECEIPT_IN_FUTURE";

export function checkReceipt(input: {
  readonly confirmationRef: string;
  readonly receiptAt: Date;
  readonly now: Date;
}): ReceiptRefusal | null {
  const ref = input.confirmationRef.trim();
  if (ref === "") return "PROOF_REQUIRED";
  if (ref.length > MAX_CONFIRMATION_REF_LENGTH) return "REFERENCE_TOO_LONG";
  if (containsMbi(ref)) return "MBI_NOT_ALLOWED";
  if (Number.isNaN(input.receiptAt.getTime())) return "RECEIPT_TIME_INVALID";
  if (input.receiptAt.getTime() > input.now.getTime()) return "RECEIPT_IN_FUTURE";
  return null;
}

export type ApprovalRefusal = "SELF_APPROVAL";

/**
 * Whoever approves a transmission should not be whoever prepared it, unless the org has a single eligible user.
 * SME/compliance item: the single-user exception is the planner's default, to be confirmed.
 */
export function checkApproval(input: {
  readonly preparedBy: string | null;
  readonly approver: string;
  readonly eligibleUserCount: number;
}): ApprovalRefusal | null {
  if (input.preparedBy === null || input.preparedBy !== input.approver) return null;
  return input.eligibleUserCount <= 1 ? null : "SELF_APPROVAL";
}

export const UNKNOWN_OUTCOME_REASON =
  "The worker stopped mid-send. Outcome unknown: verify with the channel before refiling.";

/**
 * A `sending` attempt whose worker died is NEVER auto-resent: a double filing is worse than a delayed one. It moves to
 * `needs_manual`. (Deliberately unlike the fax records-request sweep, which settles a stale send to `failed`.)
 */
export function staleSendingOutcome(input: {
  readonly status: SubmissionStatus;
  readonly sendingSince: Date;
  readonly now: Date;
  readonly staleAfterMs: number;
}): { readonly to: "needs_manual"; readonly reason: string } | null {
  if (input.status !== "sending") return null;
  if (input.now.getTime() - input.sendingSince.getTime() < input.staleAfterMs) return null;
  return { to: "needs_manual", reason: UNKNOWN_OUTCOME_REASON };
}

const MS_PER_DAY = 86_400_000;

/** True for a `needs_manual` attempt older than the threshold: the "proof missing" state, never blank on screen. */
export function isProofMissing(input: {
  readonly status: SubmissionStatus;
  readonly createdAt: Date;
  readonly now: Date;
  readonly thresholdDays?: number;
}): boolean {
  if (input.status !== "needs_manual") return false;
  const days = (input.now.getTime() - input.createdAt.getTime()) / MS_PER_DAY;
  return days >= (input.thresholdDays ?? PROOF_MISSING_DAYS);
}
