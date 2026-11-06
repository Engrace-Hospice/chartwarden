// apps/backend/src/modules/16-bereavement/lifecycle/physician-letter.ts — ADR-0109 D6.
//
// The pure rules around `bereavement_physician_letter`: the condolence letter to the patient's INTERNAL attending clinician. It is
// created `pending_review` when the intake opens the plan and disclosed only once a human approves it (approve) or retired with a
// documented reason (decline). Both transitions are legal only from `pending_review`; approval needs a recipient (the care team's
// attending, or the user the reviewer names). No IO: the letter service applies these inside its transaction.
import { BereavementStateError } from "./errors";

export type PhysicianLetterStatus = "pending_review" | "approved" | "rendered" | "declined";

/** The letter is due this many days after the death (UTC-midnight death date, like the cadence floor). */
export const PHYSICIAN_LETTER_DUE_DAYS = 2;
/** The reviewer's optional personal note: at most this many characters (sealed at rest). */
export const PHYSICIAN_LETTER_NOTE_MAX = 1000;
/** A decline carries a reason of at least this many characters after trimming. */
export const PHYSICIAN_LETTER_DECLINE_REASON_MIN = 20;

const MS_PER_DAY = 86_400_000;

/** When a letter for a death on `deathDate` (`YYYY-MM-DD`) is due: UTC midnight of that date plus {@link PHYSICIAN_LETTER_DUE_DAYS}. */
export function physicianLetterDueAt(deathDate: string): Date {
  return new Date(
    Date.parse(`${deathDate}T00:00:00.000Z`) + PHYSICIAN_LETTER_DUE_DAYS * MS_PER_DAY,
  );
}

function assertPending(status: PhysicianLetterStatus): void {
  if (status !== "pending_review") {
    throw new BereavementStateError(
      "PHYSICIAN_LETTER_NOT_PENDING",
      `the letter is ${status}; only a letter pending review can be approved or declined`,
    );
  }
}

/** The reviewer's note as stored: trimmed, null when blank; over {@link PHYSICIAN_LETTER_NOTE_MAX} is refused (422). */
export function normalizePersonalNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > PHYSICIAN_LETTER_NOTE_MAX) {
    throw new BereavementStateError(
      "PHYSICIAN_LETTER_NOTE_TOO_LONG",
      `the personal note is at most ${PHYSICIAN_LETTER_NOTE_MAX} characters`,
    );
  }
  return trimmed.length === 0 ? null : trimmed;
}

/** What approval will store: the recipient and the trimmed note (null when blank). */
export interface LetterApprovalDecision {
  readonly attendingUserId: string;
  readonly personalNote: string | null;
}

/**
 * Approve a `pending_review` letter. The recipient is the reviewer's pick when they named one, else the attending the care team
 * resolved at intake; with neither the letter cannot be approved (422). A blank note is no note; a note over the cap is refused.
 * The caller validates that a picked user is an active member of the organization (an id alone proves nothing).
 */
export function decideLetterApproval(
  letter: { readonly status: PhysicianLetterStatus; readonly attendingUserId: string | null },
  input: {
    readonly personalNote: string | null | undefined;
    readonly attendingUserId: string | null | undefined;
  },
): LetterApprovalDecision {
  assertPending(letter.status);
  const personalNote = normalizePersonalNote(input.personalNote);
  const attendingUserId = input.attendingUserId ?? letter.attendingUserId;
  if (attendingUserId === null || attendingUserId === undefined) {
    throw new BereavementStateError(
      "PHYSICIAN_LETTER_ATTENDING_REQUIRED",
      "no attending clinician is resolved for this patient; choose the internal clinician who should receive the letter",
    );
  }
  return { attendingUserId, personalNote };
}

/** Decline a `pending_review` letter: the trimmed reason, which must be at least {@link PHYSICIAN_LETTER_DECLINE_REASON_MIN} characters. */
export function decideLetterDecline(
  letter: { readonly status: PhysicianLetterStatus },
  reason: string,
): string {
  assertPending(letter.status);
  const trimmed = reason.trim();
  if (trimmed.length < PHYSICIAN_LETTER_DECLINE_REASON_MIN) {
    throw new BereavementStateError(
      "PHYSICIAN_LETTER_DECLINE_REASON_TOO_SHORT",
      `a decline needs a reason of at least ${PHYSICIAN_LETTER_DECLINE_REASON_MIN} characters`,
    );
  }
  return trimmed;
}
