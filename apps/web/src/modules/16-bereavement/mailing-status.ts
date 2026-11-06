// apps/web/src/modules/16-bereavement — the mailing program's vocabulary (ADR-0109 D10, routes 42-52): plain-language labels for the
// closed wire enums, the tone of each run/item status, and the pure rules for a mailing's wording.
//
// NO DEFAULT WORDING SHIPS. A bereavement letter is the agency's own voice to a grieving family: the platform provides the layout, the
// agency provides the words. Nothing in this file (or in any mailing screen) supplies a title, a paragraph or a sign-off.
import type { StatusTone } from "@chartwarden/ui";
import type {
  BereavementRelationshipCode,
  MailingContent,
  MailingItemStatus,
  MailingKey,
  MailingLocaleContent,
  MailingRunStatus,
  TimelineEntry,
} from "./bereavement-api";
import { humanize } from "./bereavement-status";

/** The permission keys the mailing surface is gated on (the server enforces each; the web only decides what to offer). */
export const MAILING_READ_PERMISSION = "bereavement.mailing.read";
export const MAILING_MANAGE_PERMISSION = "bereavement.mailing.manage";
export const MAILING_DISPATCH_PERMISSION = "bereavement.mailing.dispatch";

/** The four mailings a tenant can configure. `decedent_birthday` is deferred (M16 holds no date of birth), so it is never offered. */
export const CONFIGURABLE_MAILING_KEYS: readonly MailingKey[] = [
  "newsletter_quarterly",
  "holiday_december",
  "mothers_day",
  "fathers_day",
];

const MAILING_LABEL: Record<string, string> = {
  newsletter_quarterly: "Quarterly newsletter",
  holiday_december: "December holiday card",
  mothers_day: "Mother's Day letter",
  fathers_day: "Father's Day letter",
};

export const mailingLabel = (key: string | null | undefined): string =>
  key ? (MAILING_LABEL[key] ?? humanize(key)) : "Mailing";

/** When each mailing falls, as the server computes it (the tenant overrides only the two with a configurable date). */
export const MAILING_WHEN_HINT: Record<string, string> = {
  newsletter_quarterly: "Four issues a year. Default dates: 01-15, 04-15, 07-15 and 10-15.",
  holiday_december: "One card a year. Default date: 12-15.",
  mothers_day: "The second Sunday of May.",
  fathers_day: "The third Sunday of June.",
};

/** The relationships a mailing's audience can name (the server's closed set; `RELATIONSHIP_CODES` carries the same values as strings). */
export const AUDIENCE_RELATIONSHIPS: readonly BereavementRelationshipCode[] = [
  "spouse",
  "domestic_partner",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
  "aunt_uncle",
  "cousin",
  "in_law",
  "friend",
  "neighbor",
  "clergy",
  "colleague",
  "caregiver_non_family",
  "other",
];

/** The lead time the server accepts (days before the mailing's date that its draft run is opened). */
export const LEAD_DAYS_MIN = 3;
export const LEAD_DAYS_MAX = 60;
/** The most newsletter dates a tenant may name. */
export const NEWSLETTER_DATES_MAX = 12;
export const MONTH_DAY_PATTERN = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

// ── run + item statuses ────────────────────────────────────────────────────────────────────────────────

export const RUN_STATUSES: readonly MailingRunStatus[] = [
  "draft",
  "generating",
  "ready",
  "mailed",
  "cancelled",
  "failed",
];

export const RUN_STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  generating: "progress",
  ready: "warning",
  mailed: "success",
  cancelled: "neutral",
  failed: "error",
};

/** Generation can be asked for from these states; the others are in flight or done. */
export const canGenerate = (status: MailingRunStatus): boolean =>
  status === "draft" || status === "failed";
/** A ready batch can be selected and rendered again (route 48 takes a ready run): after an opt-out, or a refused stale download. */
export const canRegenerate = (status: MailingRunStatus): boolean => status === "ready";
export const canDownload = (status: MailingRunStatus): boolean =>
  status === "ready" || status === "mailed";
export const canConfirmMailed = (status: MailingRunStatus): boolean => status === "ready";
export const canCancel = (status: MailingRunStatus): boolean =>
  status === "draft" || status === "ready" || status === "failed";
export const canEditWording = (status: MailingRunStatus): boolean => status === "draft";

export const ITEM_STATUSES: readonly MailingItemStatus[] = [
  "included",
  "excluded",
  "logged",
  "excluded_after_render",
  "email_sent",
  "email_failed",
];

const ITEM_STATUS_LABEL: Record<string, string> = {
  included: "In the batch",
  excluded: "Left out",
  logged: "Logged as mailed",
  excluded_after_render: "Left out after printing",
  email_sent: "Email sent",
  email_failed: "Email failed",
};
export const itemStatusLabel = (status: string): string =>
  ITEM_STATUS_LABEL[status] ?? humanize(status);

export const ITEM_STATUS_TONE: Record<string, StatusTone> = {
  included: "progress",
  excluded: "neutral",
  logged: "success",
  excluded_after_render: "warning",
  email_sent: "success",
  email_failed: "error",
};

const EXCLUSION_LABEL: Record<string, string> = {
  plan_not_active: "The bereavement plan is not active",
  contact_not_engageable: "The contact can no longer be contacted",
  opted_out: "The contact opted out of the program",
  no_mailings: "The contact asked for no mailings",
  channel_opted_out: "The contact opted out of this channel",
  channel_not_allowed: "This channel is not allowed for the contact",
  no_mailing_address: "No mailing address on file",
  no_email_address: "No email address on file",
  email_channel_unavailable: "Email is not available for this mailing",
  not_in_audience: "The relationship is not in this mailing's audience",
};
export const exclusionLabel = (reason: string | null | undefined): string =>
  reason ? (EXCLUSION_LABEL[reason] ?? humanize(reason)) : "—";

/** A failed run's machine code, in words. An unknown code is shown as itself, never guessed at. */
export function failureLabel(code: string | null | undefined): string {
  if (code === "NO_RECIPIENTS")
    return "Nobody was eligible for this mailing, so there was nothing to print.";
  return code ? `The batch could not be rendered (${code}).` : "The batch could not be rendered.";
}

// ── the contact timeline ───────────────────────────────────────────────────────────────────────────────

const ACTIVITY_LABEL: Record<string, string> = {
  newsletter_mailing: "Newsletter mailing",
  holiday_mailing: "Holiday mailing",
  memorial_invitation_mailing: "Memorial invitation mailing",
  support_group_session: "Support group session",
  memorial_service_attendance: "Memorial service attendance",
};
export const activityLabel = (kind: string | null | undefined): string =>
  kind ? (ACTIVITY_LABEL[kind] ?? humanize(kind)) : "Program activity";

const TIMELINE_OUTCOME_LABEL: Record<string, string> = {
  engaged: "Engaged",
  brief_acknowledgement: "Brief acknowledgement",
  declined: "Declined",
  no_response: "No response",
  voicemail_left: "Voicemail left",
  wrong_number: "Wrong number",
  returned_undeliverable: "Returned undeliverable",
  requested_followup: "Requested follow-up",
  requested_no_further_contact: "Requested no further contact",
  crisis_referral: "Crisis referral",
  artifact_rendered: "Letter prepared",
  mailed: "Mailed",
  emailed: "Emailed",
  attended: "Attended",
};

/** The words for a timeline entry's outcome. ABSENT (`undefined`) is a withheld clinical outcome, said as such and never guessed. */
export function timelineOutcomeLabel(entry: TimelineEntry): string {
  if (entry.outcome === undefined) return "Not shown to you";
  return TIMELINE_OUTCOME_LABEL[entry.outcome] ?? humanize(entry.outcome);
}

// ── a mailing's wording ────────────────────────────────────────────────────────────────────────────────

/** Limits mirror the server's (`BEREAVEMENT_MAILING_CONTENT_LIMITS`): a body past any of them is a 422. */
export const CONTENT_LIMITS = {
  title: 200,
  greeting: 200,
  paragraph: 2000,
  paragraphs: 12,
  signoff: 400,
} as const;

/** The token a greeting may carry; the server replaces it with each recipient's display name when the letter is built. */
export const GREETING_NAME_TOKEN = "{name}";

/** The editor's blank page. Blank is not default wording: it is what Generate refuses. */
export const BLANK_WORDING: MailingLocaleContent = {
  title: "",
  greeting: "",
  paragraphs: [],
  signoff: "",
};

export const wordingOf = (content: MailingContent): MailingLocaleContent =>
  content.en ?? BLANK_WORDING;

/** The server's own rule: a title and at least one non-blank paragraph are the minimum a letter needs. */
export const isWordingComplete = (wording: MailingLocaleContent): boolean =>
  wording.title.trim().length > 0 && wording.paragraphs.some((p) => p.trim().length > 0);

/** What is sent: every string trimmed, blank paragraphs dropped, and a wholly blank page as `{}` (nothing written yet). */
export function contentForSave(wording: MailingLocaleContent): MailingContent {
  const next: MailingLocaleContent = {
    title: wording.title.trim(),
    greeting: wording.greeting.trim(),
    paragraphs: wording.paragraphs.map((p) => p.trim()).filter((p) => p.length > 0),
    signoff: wording.signoff.trim(),
  };
  const blank =
    next.title === "" &&
    next.greeting === "" &&
    next.signoff === "" &&
    next.paragraphs.length === 0;
  return blank ? {} : { en: next };
}

/** Whether two drafts would send the same thing (a trailing space or an empty extra paragraph is not an edit). */
export const sameWording = (a: MailingLocaleContent, b: MailingLocaleContent): boolean =>
  JSON.stringify(contentForSave(a)) === JSON.stringify(contentForSave(b));

/** What stops the wording being saved: each entry is a sentence the editor shows. Empty when it may be sent. */
export function wordingProblems(wording: MailingLocaleContent): string[] {
  const problems: string[] = [];
  if (wording.title.trim().length > CONTENT_LIMITS.title)
    problems.push(`The title is over ${CONTENT_LIMITS.title} characters.`);
  if (wording.greeting.trim().length > CONTENT_LIMITS.greeting)
    problems.push(`The greeting is over ${CONTENT_LIMITS.greeting} characters.`);
  if (wording.signoff.trim().length > CONTENT_LIMITS.signoff)
    problems.push(`The sign-off is over ${CONTENT_LIMITS.signoff} characters.`);
  if (wording.paragraphs.length > CONTENT_LIMITS.paragraphs)
    problems.push(`A letter has at most ${CONTENT_LIMITS.paragraphs} paragraphs.`);
  wording.paragraphs.forEach((p, i) => {
    if (p.trim().length > CONTENT_LIMITS.paragraph)
      problems.push(`Paragraph ${i + 1} is over ${CONTENT_LIMITS.paragraph} characters.`);
  });
  return problems;
}
