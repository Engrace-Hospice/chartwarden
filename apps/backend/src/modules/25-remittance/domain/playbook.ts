// M25 milestone 9a-1 - the denial-reason PLAYBOOK library. PURE (no I/O).
//
// A playbook is ORGANIZATION-AUTHORED guidance for one denial reason (a code kind + code, optionally one MAC): a short
// summary and an ordered list of steps. Every version is immutable once published and carries a mandatory source note
// and a reviewer who is not its author. NOTHING here states what CMS, a MAC or a payer requires: there is no platform
// playbook, no seeded text and no default. When an organization has written none, the resolver returns null and the
// screen says so. A playbook is guidance only: it never changes routing, deadlines, checklist state, sign-off, filing or
// any case state (the live suite asserts this row for row).
import { type CodeKeyedEntry, type DenialRouteInput, pickCodeKeyed } from "./denial-route";

export {
  type RouteCodeKind as PlaybookCodeKind,
  ROUTE_CODE_KINDS as PLAYBOOK_CODE_KINDS,
} from "./denial-route";

export const PLAYBOOK_VERSION_STATUSES = ["draft", "published", "retired"] as const;
export type PlaybookVersionStatus = (typeof PLAYBOOK_VERSION_STATUSES)[number];

/** A per-case step tick. Advisory: no guard anywhere reads it. */
export const PLAYBOOK_STEP_STATUSES = ["done", "not_applicable"] as const;
export type PlaybookStepStatus = (typeof PLAYBOOK_STEP_STATUSES)[number];

// Product bounds, not rules: they keep a playbook short enough to read on a case panel.
export const PLAYBOOK_MAX_STEPS = 30;
export const PLAYBOOK_TITLE_MAX = 120;
export const PLAYBOOK_SUMMARY_MAX = 1000;
export const PLAYBOOK_STEP_TEXT_MAX = 500;
export const PLAYBOOK_SOURCE_NOTE_MAX = 500;
const STEP_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CODE = /^[A-Za-z0-9]{1,16}$/;

export interface PlaybookStep {
  readonly key: string;
  readonly text: string;
}

export interface PlaybookVersionContent {
  readonly summary: string;
  readonly sourceNote: string;
  readonly steps: readonly PlaybookStep[];
}

export type PlaybookContentRefusal =
  | "SOURCE_NOTE_REQUIRED"
  | "SOURCE_NOTE_TOO_LONG"
  | "SUMMARY_REQUIRED"
  | "SUMMARY_TOO_LONG"
  | "STEPS_REQUIRED"
  | "TOO_MANY_STEPS"
  | "STEP_KEY_INVALID"
  | "STEP_KEY_DUPLICATE"
  | "STEP_TEXT_REQUIRED"
  | "STEP_TEXT_TOO_LONG";

export type PlaybookValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly PlaybookContentRefusal[] };

/** The code as stored: upper-cased and trimmed; null when it is not 1 to 16 letters or digits. */
export function normalizePlaybookCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE.test(code) ? code : null;
}

/** Reasons a version's content cannot be saved. Each reason appears once, in a stable order. */
export function validatePlaybookVersion(content: PlaybookVersionContent): PlaybookValidation {
  const reasons = new Set<PlaybookContentRefusal>();
  const summary = content.summary.trim();
  if (summary === "") reasons.add("SUMMARY_REQUIRED");
  else if (summary.length > PLAYBOOK_SUMMARY_MAX) reasons.add("SUMMARY_TOO_LONG");
  const source = content.sourceNote.trim();
  if (source === "") reasons.add("SOURCE_NOTE_REQUIRED");
  else if (source.length > PLAYBOOK_SOURCE_NOTE_MAX) reasons.add("SOURCE_NOTE_TOO_LONG");
  if (content.steps.length === 0) reasons.add("STEPS_REQUIRED");
  if (content.steps.length > PLAYBOOK_MAX_STEPS) reasons.add("TOO_MANY_STEPS");
  const seen = new Set<string>();
  for (const step of content.steps) {
    if (seen.has(step.key)) reasons.add("STEP_KEY_DUPLICATE");
    seen.add(step.key);
    if (!STEP_KEY.test(step.key)) reasons.add("STEP_KEY_INVALID");
    const text = step.text.trim();
    if (text === "") reasons.add("STEP_TEXT_REQUIRED");
    else if (text.length > PLAYBOOK_STEP_TEXT_MAX) reasons.add("STEP_TEXT_TOO_LONG");
  }
  const order: readonly PlaybookContentRefusal[] = [
    "SUMMARY_REQUIRED",
    "SUMMARY_TOO_LONG",
    "SOURCE_NOTE_REQUIRED",
    "SOURCE_NOTE_TOO_LONG",
    "STEPS_REQUIRED",
    "TOO_MANY_STEPS",
    "STEP_KEY_DUPLICATE",
    "STEP_KEY_INVALID",
    "STEP_TEXT_REQUIRED",
    "STEP_TEXT_TOO_LONG",
  ];
  return reasons.size === 0
    ? { ok: true }
    : { ok: false, reasons: order.filter((r) => reasons.has(r)) };
}

export type PlaybookPublishRefusal = "NOT_A_DRAFT" | "REVIEWER_IS_AUTHOR";

/** The people involved, by membership id AND user id (a re-invited person has a new membership id but the same user id). */
export interface PlaybookPeople {
  readonly authorMembershipId: string;
  readonly authorUserId: string;
  /** Whoever last changed the draft's content (the author unless someone else edited it). */
  readonly lastEditorMembershipId: string;
  readonly lastEditorUserId: string;
  readonly publisherMembershipId: string;
  readonly publisherUserId: string;
}

/** Review before publish: only a draft is published, and never by its author or last editor (the `checkSignOff` shape). */
export function checkPublish(
  input: PlaybookPeople & { readonly status: PlaybookVersionStatus },
): PlaybookPublishRefusal | null {
  if (input.status !== "draft") return "NOT_A_DRAFT";
  const same =
    input.publisherMembershipId === input.authorMembershipId ||
    input.publisherMembershipId === input.lastEditorMembershipId ||
    input.publisherUserId === input.authorUserId ||
    input.publisherUserId === input.lastEditorUserId;
  return same ? "REVIEWER_IS_AUTHOR" : null;
}

export function checkRetire(status: PlaybookVersionStatus): "NOT_PUBLISHED" | null {
  return status === "published" ? null : "NOT_PUBLISHED";
}

/** What resolution needs from a published version joined to its playbook's key. */
export interface PlaybookResolveEntry extends CodeKeyedEntry {
  readonly id: string;
}

/**
 * The published version that applies to a denial, by the SAME precedence as the routing rules (MAC reason > RARC >
 * CARC, MAC-specific first, newest effective date). Null when the organization has written none: absence is shown, it
 * is never replaced by a default.
 */
export function resolvePlaybook<T extends PlaybookResolveEntry>(
  input: DenialRouteInput,
  published: readonly T[],
): T | null {
  return pickCodeKeyed(input, published);
}
