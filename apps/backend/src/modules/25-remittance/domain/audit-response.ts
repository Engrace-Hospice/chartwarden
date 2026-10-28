// M25 milestone 7a-2 - the pure AUDIT RESPONSE rules (RAC / UPIC / SMRC / other). No I/O: the service reads the facts
// and these decide. NOTHING here states what a particular audit contractor requires:
//   - the response checklist is typed by the person FROM THE REQUEST LETTER (no item is seeded: what an audit asks for
//     is not a verified fact), each item ready or not applicable before sign-off;
//   - the filing channels are labels for how the response left the building, they imply no portal or format;
//   - the due date is a recorded deadline (7a-1); a response needs one, or an explicit "none stated in the request"
//     attestation (the cited_evidence_none pattern), and a filing after an open recorded deadline needs an explicit
//     late acknowledgement.
// Refusals are reason codes the service turns into typed errors; none carries content.

import { createHash } from "node:crypto";

export const AUDIT_RESPONSE_ITEM_STATES = ["pending", "ready", "not_applicable"] as const;
export type AuditResponseItemState = (typeof AUDIT_RESPONSE_ITEM_STATES)[number];

export interface AuditResponseItem {
  readonly label: string;
  readonly state: AuditResponseItemState;
}

export const MAX_AUDIT_RESPONSE_ITEMS = 50;
export const MAX_AUDIT_ITEM_LABEL = 200;

/** How the response left the building. Labels only: no channel is verified for any audit contractor (SME item). */
export const AUDIT_FILING_CHANNELS = ["esmd", "fax", "mail", "other"] as const;
export type AuditFilingChannel = (typeof AUDIT_FILING_CHANNELS)[number];

export type AuditItemsRefusal =
  | "ITEMS_TOO_MANY"
  | "ITEM_LABEL_REQUIRED"
  | "ITEM_LABEL_TOO_LONG"
  | "ITEM_LABEL_DUPLICATE"
  | "ITEM_STATE_INVALID";

export type AuditReadyRefusal = "PACKET_EMPTY" | "CHECKLIST_INCOMPLETE";
export type AuditSignOffRefusal =
  | AuditReadyRefusal
  | "REVIEWER_IS_ASSEMBLER"
  | "REVIEWER_IS_PREPARER"
  | "ALREADY_SIGNED_OFF"
  | "DEADLINE_OR_ATTESTATION_REQUIRED";

export type AuditFilingRefusal =
  | "NOT_SIGNED_OFF"
  | "CHANNEL_INVALID"
  | "PROOF_REQUIRED"
  | "FILED_IN_FUTURE"
  | "FILED_BEFORE_REVIEW"
  | "DEADLINE_OR_ATTESTATION_REQUIRED"
  | "LATE_ACKNOWLEDGEMENT_REQUIRED";

export function checkResponseItems(items: readonly AuditResponseItem[]): AuditItemsRefusal | null {
  if (items.length > MAX_AUDIT_RESPONSE_ITEMS) return "ITEMS_TOO_MANY";
  const seen = new Set<string>();
  for (const item of items) {
    const label = item.label.trim();
    if (label === "") return "ITEM_LABEL_REQUIRED";
    if (label.length > MAX_AUDIT_ITEM_LABEL) return "ITEM_LABEL_TOO_LONG";
    if (!(AUDIT_RESPONSE_ITEM_STATES as readonly string[]).includes(item.state)) {
      return "ITEM_STATE_INVALID";
    }
    const key = label.toLowerCase();
    if (seen.has(key)) return "ITEM_LABEL_DUPLICATE";
    seen.add(key);
  }
  return null;
}

/**
 * What a packet needs to leave assembly: at least one document and every typed item done. The move to review and the
 * sign-off both ask it, so a request can never enter a state that sign-off cannot leave.
 */
export function checkReadyForReview(input: {
  readonly items: readonly AuditResponseItem[];
  readonly attachedCount: number;
}): AuditReadyRefusal | null {
  if (input.attachedCount < 1) return "PACKET_EMPTY";
  return input.items.every((i) => i.state === "ready" || i.state === "not_applicable")
    ? null
    : "CHECKLIST_INCOMPLETE";
}

/**
 * Preparer != approver: whoever sent the packet to review, attached one of its documents or typed its checklist cannot
 * sign it off, and a packet is signed off once.
 */
export function checkAuditSignOff(input: {
  readonly assemblerMembershipId: string;
  readonly reviewerMembershipId: string;
  /** Everyone who attached a live document or set the checklist. */
  readonly preparerMembershipIds: readonly string[];
  readonly alreadySignedOff: boolean;
  /** Recorded deadlines of any status, and whether the none-stated attestation was made: a sign-off covers one of them. */
  readonly recordedDeadlineCount: number;
  readonly noDeadlineStatedAttested: boolean;
  readonly items: readonly AuditResponseItem[];
  readonly attachedCount: number;
}): AuditSignOffRefusal | null {
  if (input.alreadySignedOff) return "ALREADY_SIGNED_OFF";
  if (input.reviewerMembershipId === input.assemblerMembershipId) return "REVIEWER_IS_ASSEMBLER";
  if (input.preparerMembershipIds.includes(input.reviewerMembershipId))
    return "REVIEWER_IS_PREPARER";
  const ready = checkReadyForReview(input);
  if (ready) return ready;
  // Deadlines and the attestation freeze at sign-off, so a sign-off without either could never be filed.
  return input.recordedDeadlineCount === 0 && !input.noDeadlineStatedAttested
    ? "DEADLINE_OR_ATTESTATION_REQUIRED"
    : null;
}

/**
 * A fingerprint of everything a reviewer signs off: the claims, the typed checklist, the documents, the recorded
 * deadlines and the attestation. Filing recomputes it; a difference means the packet moved after sign-off.
 */
export function signOffFingerprint(input: {
  readonly claimIds: readonly string[];
  readonly items: readonly AuditResponseItem[];
  readonly documents: readonly { readonly documentId: string; readonly claimId: string }[];
  readonly deadlines: readonly {
    readonly id: string;
    readonly dueOn: string;
    readonly satisfiedOn: string | null;
  }[];
  readonly noDeadlineStatedAttested: boolean;
}): string {
  const canonical = JSON.stringify({
    c: [...input.claimIds].sort(),
    i: input.items.map((i) => [i.label, i.state]),
    d: input.documents.map((d) => [d.documentId, d.claimId]).sort(),
    t: input.deadlines.map((d) => [d.id, d.dueOn, d.satisfiedOn]).sort(),
    a: input.noDeadlineStatedAttested,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function checkAuditFiling(input: {
  readonly signedOffByMembershipId: string | null;
  readonly channel: string;
  readonly confirmationRef: string;
  readonly filedAt: Date;
  readonly reviewedAt: Date;
  readonly now: Date;
  /** Recorded deadlines of any status (a satisfied one still proves a date was recorded). */
  readonly recordedDeadlineCount: number;
  readonly noDeadlineStatedAttested: boolean;
  /** End-of-day instant of the earliest UNSATISFIED recorded deadline, or null. */
  readonly earliestOpenDueAt: Date | null;
  readonly lateAcknowledged: boolean;
}): AuditFilingRefusal | null {
  if (!input.signedOffByMembershipId) return "NOT_SIGNED_OFF";
  if (!(AUDIT_FILING_CHANNELS as readonly string[]).includes(input.channel)) {
    return "CHANNEL_INVALID";
  }
  if (input.confirmationRef.trim() === "") return "PROOF_REQUIRED";
  if (input.filedAt.getTime() > input.now.getTime()) return "FILED_IN_FUTURE";
  if (input.filedAt.getTime() < input.reviewedAt.getTime()) return "FILED_BEFORE_REVIEW";
  if (input.recordedDeadlineCount === 0 && !input.noDeadlineStatedAttested) {
    return "DEADLINE_OR_ATTESTATION_REQUIRED";
  }
  if (
    input.earliestOpenDueAt !== null &&
    input.filedAt.getTime() > input.earliestOpenDueAt.getTime() &&
    !input.lateAcknowledged
  ) {
    return "LATE_ACKNOWLEDGEMENT_REQUIRED";
  }
  return null;
}

/** The attestation is only meaningful while the request has no recorded deadline at all. */
export function canAttestNoDeadlineStated(input: {
  readonly recordedDeadlineCount: number;
  readonly alreadyAttested: boolean;
}): "DEADLINES_EXIST" | "ALREADY_ATTESTED" | null {
  if (input.recordedDeadlineCount > 0) return "DEADLINES_EXIST";
  return input.alreadyAttested ? "ALREADY_ATTESTED" : null;
}
