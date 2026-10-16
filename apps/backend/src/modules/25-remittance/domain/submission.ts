// M25 milestone 6a - the submission attempt's vocabulary and status machine (hospice ADR/TPE/QIC PRD, milestone 6).
// PURE. Closed sets mirror the migration 1121 CHECKs (text + CHECK, no pgEnum).
//
// Every "submit" in M25 records a filing made outside WardenX; an attempt is the one place that tracks HOW it was
// filed and the proof that came back. In 6a only the manual (guided) adapter is live, so an attempt is born either
// `acknowledged` (the case already carried channel + reference + time) or `needs_manual` (an appeal submit carries
// none). The send edges (queued/sending/sent/failed) are modelled and tested now so 6b is purely additive.

export const SUBMISSION_PURPOSES = [
  "adr_response",
  "appeal_request",
  "reopening_request",
  "qic_escalation_request",
] as const;
export type SubmissionPurpose = (typeof SUBMISSION_PURPOSES)[number];

/** The union of the ADR, reopening and QIC-escalation channel sets. Whether each applies to each filing is SME-unconfirmed. */
export const SUBMISSION_CHANNELS = [
  "esmd",
  "mac_portal",
  "qic_portal",
  "fax",
  "mail",
  "other",
] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];

/** `manual` is the guided path (always bound); `esmd` and `fax` are electronic shells, UNBOUND until configured. */
export const SUBMISSION_ADAPTERS = ["manual", "esmd", "fax"] as const;
export type SubmissionAdapterKind = (typeof SUBMISSION_ADAPTERS)[number];

export const SUBMISSION_STATUSES = [
  "prepared",
  "queued",
  "sending",
  "sent",
  "acknowledged",
  "needs_manual",
  "failed",
  "cancelled",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export type SubmissionSubjectTable = "adr_case" | "appeal_case" | "reopening_case";

export const RECEIPT_SOURCES = ["entered", "adapter_ack"] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

export function purposeSubject(purpose: SubmissionPurpose): SubmissionSubjectTable {
  if (purpose === "adr_response") return "adr_case";
  if (purpose === "reopening_request") return "reopening_case";
  return "appeal_case";
}

/** `<purpose>:<subject id>:<attempt no>` - passed to adapters; our own unique row is the real dedupe. */
export function submissionIdempotencyKey(
  purpose: SubmissionPurpose,
  subjectId: string,
  attemptNo: number,
): string {
  return `${purpose}:${subjectId}:${attemptNo}`;
}

/** A retry is a NEW row: rows are never rewound. */
export function nextAttemptNumber(existing: readonly number[]): number {
  return existing.reduce((max, n) => Math.max(max, n), 0) + 1;
}

const LIVE: ReadonlySet<SubmissionStatus> = new Set([
  "prepared",
  "queued",
  "sending",
  "sent",
  "needs_manual",
]);
/** In flight: at most one per (subject, purpose) (the partial unique index). */
export function isLiveSubmissionStatus(status: SubmissionStatus): boolean {
  return LIVE.has(status);
}

const EDGES: Readonly<Record<SubmissionStatus, readonly SubmissionStatus[]>> = {
  prepared: ["queued", "needs_manual", "cancelled"],
  queued: ["sending", "needs_manual", "cancelled"],
  sending: ["sent", "needs_manual", "failed"],
  sent: ["acknowledged"],
  needs_manual: ["acknowledged", "cancelled"],
  acknowledged: [],
  failed: [],
  cancelled: [],
};

/** Mirrors `m25_submission_attempt_guard()` in migration 1121. Nothing reaches acknowledged except from sent or needs_manual. */
export function canTransitionSubmission(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return EDGES[from].includes(to);
}
