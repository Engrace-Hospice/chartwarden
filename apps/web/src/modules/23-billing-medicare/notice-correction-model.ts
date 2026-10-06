// apps/web/src/modules/23-billing-medicare — the pure half of "File corrected NOE / NOTR" (CMS Pub. 100-04 ch. 11
// §20.1.1 / §20.1.2): when a notice can be corrected, what the form validates before it posts, and how the
// payer's date source reads. The server re-checks every rule (ADR-0030); this only keeps the form honest.

/** The correction-chain fields the NOE / NOTR views carry (migration 0378). */
export interface CorrectionLinkFields {
  state: string;
  correctsNoticeId?: string | null;
  correctionReason?: string | null;
  correctedBy?: { noticeId: string; state: string } | null;
}

export type CorrectionAvailability =
  | { kind: "none" }
  | { kind: "file" }
  /** A correction is in progress or accepted — open it instead. */
  | { kind: "in_progress"; noticeId: string }
  /** The correction was itself rejected — correct that one. */
  | { kind: "correct_latest"; noticeId: string };

/** Only a rejected notice is corrected, and one correction at a time. */
export function correctionAvailability(rec: CorrectionLinkFields): CorrectionAvailability {
  if (rec.state !== "ack_rejected") return { kind: "none" };
  const by = rec.correctedBy ?? null;
  if (by === null || by.state === "cancelled") return { kind: "file" };
  if (by.state === "ack_rejected") return { kind: "correct_latest", noticeId: by.noticeId };
  return { kind: "in_progress", noticeId: by.noticeId };
}

export const CORRECTION_REASON_MIN = 20;
export const CORRECTION_REASON_MAX = 2000;

export interface CorrectionDraft {
  date: string;
  reason: string;
}

/** Field errors keyed like the draft; empty when it can be posted. */
export function validateCorrectionDraft(
  draft: CorrectionDraft,
  today: string,
): Partial<Record<keyof CorrectionDraft, string>> {
  const errors: Partial<Record<keyof CorrectionDraft, string>> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) errors.date = "Enter a date.";
  else if (draft.date > today) errors.date = "The date cannot be in the future.";
  const reason = draft.reason.trim();
  if (reason.length < CORRECTION_REASON_MIN) {
    errors.reason = `Say what was wrong and what you corrected (at least ${CORRECTION_REASON_MIN} characters).`;
  } else if (reason.length > CORRECTION_REASON_MAX) {
    errors.reason = `Keep it under ${CORRECTION_REASON_MAX} characters.`;
  }
  return errors;
}

const SOURCE_LABEL: Record<string, string> = {
  "277ca_stc02": "277CA status date",
  "999_gs04": "999 group date",
  "999_isa09": "999 interchange date",
  receipt: "date we received it",
};

/** "2026-10-05 (277CA status date)" — the payer's date with where it came from. */
export function payerDateLabel(
  date: string | null | undefined,
  source: string | null | undefined,
): string | null {
  if (!date) return null;
  return source ? `${date} (${SOURCE_LABEL[source] ?? source})` : date;
}
