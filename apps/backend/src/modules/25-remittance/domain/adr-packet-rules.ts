// M25 milestone 2b — the pure ADR packet rules. No I/O: the service reads the facts and these decide.
//   - the documentation checklist (what a hospice ADR response usually has to cover),
//   - reviewer sign-off (a different person from whoever sent the packet to review, nothing unticked, at least
//     one document attached),
//   - what a recorded filing needs before the case may move to `submitted` (sign-off, a channel, proof, a real
//     date; a filing after the due date is allowed only with an explicit acknowledgement).
// Refusals are reason codes the service turns into typed errors; none carries content.

/** Checklist keys. The SME has not yet confirmed this list against MAC ADR letters (PRD open question). */
export const ADR_CHECKLIST_KEYS = [
  "certification_of_terminal_illness",
  "election_statement",
  "plan_of_care",
  "physician_orders",
  "visit_notes",
  "medical_records_cover",
] as const;
export type AdrChecklistKey = (typeof ADR_CHECKLIST_KEYS)[number];
export type AdrChecklistState = "pending" | "ready" | "not_applicable";

/** How the response left the building. Electronic sending with receipts is milestone 6. */
export const ADR_FILING_CHANNELS = ["mac_portal", "fax", "mail", "esmd", "other"] as const;
export type AdrFilingChannel = (typeof ADR_FILING_CHANNELS)[number];

export type AdrSignOffRefusal = "REVIEWER_IS_ASSEMBLER" | "PACKET_EMPTY" | "CHECKLIST_INCOMPLETE";
export type AdrFilingRefusal =
  | "NOT_SIGNED_OFF"
  | "CHANNEL_INVALID"
  | "PROOF_REQUIRED"
  | "FILED_IN_FUTURE"
  | "LATE_ACKNOWLEDGEMENT_REQUIRED";

export function isChecklistKey(k: string): k is AdrChecklistKey {
  return (ADR_CHECKLIST_KEYS as readonly string[]).includes(k);
}

export function checkSignOff(input: {
  readonly assemblerMembershipId: string;
  readonly reviewerMembershipId: string;
  readonly checklist: Readonly<Record<string, string>>;
  readonly attachedCount: number;
}): AdrSignOffRefusal | null {
  if (input.reviewerMembershipId === input.assemblerMembershipId) return "REVIEWER_IS_ASSEMBLER";
  if (input.attachedCount < 1) return "PACKET_EMPTY";
  const done = (k: string): boolean =>
    input.checklist[k] === "ready" || input.checklist[k] === "not_applicable";
  return ADR_CHECKLIST_KEYS.every(done) ? null : "CHECKLIST_INCOMPLETE";
}

export function checkFiling(input: {
  readonly signedOffByMembershipId: string | null;
  readonly channel: string;
  readonly confirmationRef: string;
  readonly filedAt: Date;
  readonly dueAt: Date;
  readonly lateAcknowledged: boolean;
  readonly now: Date;
}): AdrFilingRefusal | null {
  if (!input.signedOffByMembershipId) return "NOT_SIGNED_OFF";
  if (!(ADR_FILING_CHANNELS as readonly string[]).includes(input.channel)) return "CHANNEL_INVALID";
  if (input.confirmationRef.trim() === "") return "PROOF_REQUIRED";
  if (input.filedAt.getTime() > input.now.getTime()) return "FILED_IN_FUTURE";
  if (input.filedAt.getTime() > input.dueAt.getTime() && !input.lateAcknowledged) {
    return "LATE_ACKNOWLEDGEMENT_REQUIRED";
  }
  return null;
}
