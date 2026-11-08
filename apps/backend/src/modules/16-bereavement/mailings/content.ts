// apps/backend/src/modules/16-bereavement/mailings/content.ts — ADR-0109 D10: the agency-authored wording of a mailing.
//
// PURE. NO DEFAULT WORDING SHIPS: a bereavement letter is the agency's own voice to a grieving family, so the platform provides the
// layout and the tenant provides the words. Generation REFUSES empty content: a blank letter sent to a family is worse than no letter.
import {
  BEREAVEMENT_MAILING_CONTENT_LIMITS,
  type BereavementMailingContent,
  type BereavementMailingLocaleContent,
} from "@chartwarden/types";
import { BereavementStateError } from "../lifecycle/errors";

/** The `{name}` token a greeting may carry; replaced by the recipient's display name when the letter is built. */
export const GREETING_NAME_TOKEN = "{name}";

const trimmed = (v: string): string => v.trim();

/** Trim every string and drop blank paragraphs. The shape stays `{ en: {...} }`; an absent locale stays absent. */
export function normalizeMailingContent(
  content: BereavementMailingContent,
): BereavementMailingContent {
  const en = content.en;
  if (en === undefined) return {};
  return {
    en: {
      title: trimmed(en.title),
      greeting: trimmed(en.greeting),
      paragraphs: en.paragraphs.map(trimmed).filter((p) => p.length > 0),
      signoff: trimmed(en.signoff),
    },
  };
}

/** Is there anything to mail? A title and at least one paragraph are the minimum a letter needs. */
export function isMailingContentComplete(
  content: BereavementMailingContent,
): content is { readonly en: BereavementMailingLocaleContent } {
  const en = content.en;
  return (
    en !== undefined && en.title.trim().length > 0 && en.paragraphs.some((p) => p.trim().length > 0)
  );
}

/** 422 `MAILING_CONTENT_EMPTY` when the run's wording is not complete (generation never ships a default). */
export function assertMailingContentComplete(
  content: BereavementMailingContent,
): BereavementMailingLocaleContent {
  const normalized = normalizeMailingContent(content);
  if (!isMailingContentComplete(normalized)) {
    throw new BereavementStateError(
      "MAILING_CONTENT_EMPTY",
      "write the mailing's title and at least one paragraph before generating it: no default wording ships",
    );
  }
  return normalized.en;
}

/** The greeting for one recipient: the `{name}` token becomes their display name; a blank greeting becomes just the name. */
export function personalizeGreeting(greeting: string, displayName: string): string {
  const name = displayName.trim();
  const base = greeting.trim();
  if (base.length === 0) return name.length > 0 ? name : "Dear family";
  return base.split(GREETING_NAME_TOKEN).join(name);
}

export { BEREAVEMENT_MAILING_CONTENT_LIMITS };
