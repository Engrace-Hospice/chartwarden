// M10 (R-08) — pure rules for cancelling an iQIES package that was generated but never uploaded.
//
// The manual flow is: assemble (batch `packaged`, items `pending`) -> download (`exported`) -> upload in the CMS
// portal -> Mark uploaded. A `pending` item holds its assessment out of every later assemble (and the partial
// unique index `uniq_hope_sub_item_assessment_active` backs that), so a package that was lost or never uploaded
// used to lock its signed assessments forever. Cancelling frees them: the batch and its pending items become
// `cancelled`, an item that is not `pending` is not in the assemble eligibility's excluded set, and the next
// assemble packages the same assessments in a NEW batch.
//
// Only a batch nobody uploaded can be cancelled: once it is marked uploaded CMS may hold the records, and the
// only way forward is the result (or a correction). A cancelled package was never transmitted, so the cancel deletes
// its stored bytes (the ZIP and each record's XML hold PHI and no retention hold covers them) and keeps the evidence
// that it existed (hashes, sizes, who/when/why; see hope-submission-cancel-db.ts). Shared by the DB backend
// (hope-submission-cancel-db.ts) and the in-memory slice, so the two cannot drift.
import { require_ } from "@chartwarden/hope";

/** Batch states that were never marked uploaded to CMS (the only ones a cancel may touch). */
const CANCELLABLE_STATUSES: readonly string[] = ["packaged", "exported"];

export const isCancellableSubmissionStatus = (status: string): boolean =>
  CANCELLABLE_STATUSES.includes(status);

/** The 409 text for a cancel on a batch that is neither cancellable nor already cancelled. */
export const cancelNotAllowedMessage = (id: string, status: string): string =>
  `Submission ${id} is ${status}; only a package that was never marked uploaded (packaged or exported) can be cancelled.`;

/** The 409 text for downloading a cancelled package: it must never reach the CMS portal. */
export const cancelledPackageMessage = (id: string): string =>
  `Submission ${id} was cancelled; its package must not be uploaded to CMS. Generate a new package.`;

/** Refuse (409 M10_SUBMISSION_CANCELLED) any step that would hand a cancelled package onward: download, mark uploaded. */
export const requireNotCancelled = (id: string, status: string): void =>
  require_(status !== "cancelled", "M10_SUBMISSION_CANCELLED", cancelledPackageMessage(id));
