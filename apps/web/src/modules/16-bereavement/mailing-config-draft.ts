// apps/web/src/modules/16-bereavement — the editable form of one mailing's standing config (ADR-0109 D10, route 43), as pure functions:
// the config the server returned → the strings and booleans the form edits → the body the server accepts (or the sentences that say why
// it cannot be sent yet). Nothing here supplies wording: a config with no wording stays blank.
import type {
  BereavementRelationshipCode,
  MailingConfig,
  MailingConfigBody,
  MailingLocaleContent,
} from "./bereavement-api";
import {
  LEAD_DAYS_MAX,
  LEAD_DAYS_MIN,
  MONTH_DAY_PATTERN,
  NEWSLETTER_DATES_MAX,
  contentForSave,
  sameWording,
  wordingOf,
  wordingProblems,
} from "./mailing-status";

export interface ConfigDraft {
  enabled: boolean;
  /** Kept as typed so a half-typed number is not rewritten under the reader's cursor. */
  leadDays: string;
  /** Everyone on the roster (`audienceRelationships: null`). */
  everyone: boolean;
  relationships: readonly BereavementRelationshipCode[];
  /** Newsletter issue dates as typed ("01-15, 04-15"); blank = the default four. */
  newsletterDates: string;
  /** The December card's date as typed ("12-15"); blank = the default. */
  decemberDate: string;
  wording: MailingLocaleContent;
}

export function draftOf(config: MailingConfig): ConfigDraft {
  return {
    enabled: config.enabled,
    leadDays: String(config.leadDays),
    everyone: config.audienceRelationships === null,
    relationships: config.audienceRelationships ?? [],
    newsletterDates: (config.schedule.monthDays ?? []).join(", "),
    decemberDate: config.schedule.monthDay ?? "",
    wording: wordingOf(config.content),
  };
}

const sortedUnique = (
  values: readonly BereavementRelationshipCode[],
): BereavementRelationshipCode[] => [...new Set(values)].sort();

/** What the form would send for `schedule`, per mailing: only the two dated mailings carry an override. */
function scheduleOf(
  key: string,
  draft: ConfigDraft,
  problems: string[],
): MailingConfigBody["schedule"] {
  if (key === "newsletter_quarterly") {
    const dates = draft.newsletterDates.split(/[\s,]+/).filter((d) => d !== "");
    if (dates.length === 0) return undefined;
    if (dates.length > NEWSLETTER_DATES_MAX)
      problems.push(`Name at most ${NEWSLETTER_DATES_MAX} issue dates.`);
    if (dates.some((d) => !MONTH_DAY_PATTERN.test(d)))
      problems.push("Write each issue date as MM-DD, for example 01-15.");
    return { monthDays: dates };
  }
  if (key === "holiday_december") {
    const date = draft.decemberDate.trim();
    if (date === "") return undefined;
    if (!MONTH_DAY_PATTERN.test(date))
      problems.push("Write the card's date as MM-DD, for example 12-15.");
    return { monthDay: date };
  }
  return undefined;
}

/** The body to send, or the problems that stop it. `problems` is empty exactly when `body` is present. */
export function buildBody(
  key: string,
  draft: ConfigDraft,
): { body: MailingConfigBody | null; problems: string[] } {
  const problems: string[] = [];
  const lead = draft.leadDays.trim();
  const leadDays = /^\d+$/.test(lead) ? Number(lead) : Number.NaN;
  if (!(leadDays >= LEAD_DAYS_MIN && leadDays <= LEAD_DAYS_MAX))
    problems.push(`Lead time is a whole number of days from ${LEAD_DAYS_MIN} to ${LEAD_DAYS_MAX}.`);
  if (!draft.everyone && draft.relationships.length === 0)
    problems.push("Choose at least one relationship, or choose everyone.");
  const schedule = scheduleOf(key, draft, problems);
  problems.push(...wordingProblems(draft.wording));
  if (problems.length > 0) return { body: null, problems };
  return {
    body: {
      enabled: draft.enabled,
      leadDays,
      ...(schedule === undefined ? {} : { schedule }),
      audienceRelationships: draft.everyone ? null : sortedUnique(draft.relationships),
      content: contentForSave(draft.wording),
    },
    problems,
  };
}

/** Whether two drafts would send the same thing: a retyped-then-reverted field is not an edit. */
export function sameDraft(a: ConfigDraft, b: ConfigDraft): boolean {
  return (
    a.enabled === b.enabled &&
    a.leadDays.trim() === b.leadDays.trim() &&
    a.everyone === b.everyone &&
    (a.everyone || sortedUnique(a.relationships).join() === sortedUnique(b.relationships).join()) &&
    a.newsletterDates
      .split(/[\s,]+/)
      .filter(Boolean)
      .join() ===
      b.newsletterDates
        .split(/[\s,]+/)
        .filter(Boolean)
        .join() &&
    a.decemberDate.trim() === b.decemberDate.trim() &&
    sameWording(a.wording, b.wording)
  );
}
