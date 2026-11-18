// apps/web/src/shell — what the closure banner says for a given status answer (ADR-0113). Pure: no React, no client. The SERVER decided
// the stage and the verdict; this only words them. Two rules shape the wording: a banner never claims access is limited unless the
// verdict says the clinician IS blocked (or the tenant mode is `block`, where overdue notes do limit other work), and mode `off` or an
// `ok` stage says nothing at all.
import type { NoteClosureStatus } from "./note-closure";

export type ClosureBannerTone = "info" | "warning" | "error";

export interface ClosureBannerModel {
  readonly tone: ClosureBannerTone;
  readonly title: string;
  readonly detail: string;
  /** The clinician is blocked right now: the banner links straight to the oldest note and says to ask a supervisor for an override. */
  readonly blocked: boolean;
  /** The oldest open note (the link target when `blocked`). */
  readonly encounterId: string | null;
}

/** An instant in the viewer's locale and time zone ("Nov 18, 3:40 PM"); an unparseable value is shown as a dash, never "Invalid Date". */
export function formatClosureInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const notesPhrase = (count: number): string => (count === 1 ? "visit note" : "visit notes");
const verbFor = (count: number): string => (count === 1 ? "is" : "are");

/** "Your oldest note was due Nov 18, 3:40 PM." — or nothing when the server sent no deadline. */
function oldestDueSentence(status: NoteClosureStatus): string {
  return status.deadlineAt === null
    ? ""
    : ` The oldest was due ${formatClosureInstant(status.deadlineAt)}.`;
}

function blockedModel(status: NoteClosureStatus): ClosureBannerModel {
  const count = Math.max(1, status.overdueCount);
  return {
    tone: "error",
    title: "Visit notes overdue: your access is limited",
    detail: [
      `${count} ${notesPhrase(count)} ${verbFor(count)} past the deadline.${oldestDueSentence(status)}`,
      "Until you sign them you can close notes and use patient-safety tools (eMAR, orders, triage, safety, messaging);",
      "everything else is refused. Ask a supervisor for a temporary override if you need more time.",
    ].join(" "),
    blocked: true,
    encounterId: status.encounterId,
  };
}

function overrideModel(status: NoteClosureStatus, expiresAt: string): ClosureBannerModel {
  const count = Math.max(1, status.overdueCount);
  return {
    tone: "warning",
    title: "A supervisor has temporarily lifted the limit on your access",
    detail: [
      `Until ${formatClosureInstant(expiresAt)}.`,
      `Your ${count} overdue ${notesPhrase(count)} still need closing; the limit returns when this ends.`,
    ].join(" "),
    blocked: false,
    encounterId: status.encounterId,
  };
}

function overdueModel(status: NoteClosureStatus): ClosureBannerModel {
  const count = Math.max(1, status.overdueCount);
  // Only a tenant on `block` limits other work for an overdue note; in `warn` the banner says nothing about access.
  const limitSentence =
    status.mode === "block"
      ? " Your organization limits other work while a note stays overdue."
      : "";
  return {
    tone: "warning",
    title: count === 1 ? "A visit note is overdue" : `${count} visit notes are overdue`,
    detail: `Close ${count === 1 ? "it" : "them"} as soon as you can.${oldestDueSentence(status)}${limitSentence}`,
    blocked: false,
    encounterId: status.encounterId,
  };
}

function atRiskModel(status: NoteClosureStatus): ClosureBannerModel {
  const due = status.deadlineAt === null ? "soon" : `by ${formatClosureInstant(status.deadlineAt)}`;
  return {
    tone: "info",
    title: "A visit note is due soon",
    detail: `Your oldest open note is due ${due}. Sign it to close it.`,
    blocked: false,
    encounterId: status.encounterId,
  };
}

/** True while a supervisor's override is still lifting the block (the server sent its expiry; an expired one no longer counts). */
function activeOverrideExpiry(status: NoteClosureStatus, now: Date): string | null {
  const expiresAt = status.overrideExpiresAt;
  if (expiresAt === null) return null;
  return Date.parse(expiresAt) > now.getTime() ? expiresAt : null;
}

/** The banner for one status answer, or null when it has nothing to say (no answer, mode off, or the note is not yet at risk). */
export function closureBannerModel(
  status: NoteClosureStatus | null,
  now: Date,
): ClosureBannerModel | null {
  if (status === null || status.mode === "off") return null;
  if (status.verdict === "blocked") return blockedModel(status);
  const overrideExpiresAt = activeOverrideExpiry(status, now);
  if (overrideExpiresAt !== null) return overrideModel(status, overrideExpiresAt);
  if (status.stage === "overdue" || status.stage === "escalated") return overdueModel(status);
  if (status.stage === "at_risk") return atRiskModel(status);
  return null;
}
