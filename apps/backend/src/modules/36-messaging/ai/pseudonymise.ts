// apps/backend/src/modules/36-messaging/ai/pseudonymise.ts - WP 6.5 (ADR-0095 section 1.4): deterministic minimum-necessary pseudonymisation.
//
// The model needs CONTENT, not identity. This is plain code, not a prompt instruction: every sender becomes a role token plus a per-thread alias,
// the patient becomes [PATIENT], names of people in the thread become their alias, and the identifiers that free text commonly carries (phone,
// e-mail, address, dates, long numbers, links) become fixed tokens. It cannot remove every identifier a person may type (a relative's first name,
// a neighbourhood): that residual risk is why the call is BAA-only and why the summary is labelled unverified (ADR-0095 open decisions 3 and 5).
// PURE: no I/O, no clock, no randomness.
import { MESSAGING_AI_PATIENT_TOKEN } from "@chartwarden/types";

export type RoleToken = "[RN]" | "[SW]" | "[MD]" | "[CHAPLAIN]" | "[AIDE]" | "[FAMILY]" | "[STAFF]";

const ROLE_RULES: readonly (readonly [RegExp, RoleToken])[] = [
  [/(^|_)(rn|lpn|nurse|nursing|case_manager)(_|$)|director_of_nursing/, "[RN]"],
  [/social|(^|_)sw(_|$)/, "[SW]"],
  [/physician|medical_director|(^|_)(md|np|pa|doctor)(_|$)|attending/, "[MD]"],
  [/chaplain|spiritual/, "[CHAPLAIN]"],
  [/aide|(^|_)(hha|cna)(_|$)/, "[AIDE]"],
  [/family|caregiver|portal/, "[FAMILY]"],
];

/** One token per person from the role keys they hold (first rule that matches wins); anything unrecognised is [STAFF]. */
export function roleTokenFor(
  roleKeys: readonly string[],
  categories: readonly string[],
): RoleToken {
  if (categories.includes("patient_family")) return "[FAMILY]";
  for (const key of roleKeys) {
    const lower = key.toLowerCase();
    for (const [pattern, token] of ROLE_RULES) if (pattern.test(lower)) return token;
  }
  return "[STAFF]";
}

const ALIAS_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Sender A, Sender B ... by first appearance; the 27th onward is Sender A2, B2 ... (never a name, never an id). */
export function aliasFor(index: number): string {
  const letter = ALIAS_LETTERS[index % ALIAS_LETTERS.length];
  const round = Math.floor(index / ALIAS_LETTERS.length);
  return `Sender ${letter}${round === 0 ? "" : round + 1}`;
}

const DELIMITER = /\[\s*messages?\s+(begin|end)\s*\]/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const SLASH_DATE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;
const MONTH_DATE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b/gi;
const STREET =
  /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place)\b\.?/gi;
const LONG_NUMBER = /\b\d{6,}\b/g;
/** Control characters other than tab, newline and carriage return become a space (no regex literal: the range is a lint hazard and a char-code test is clearer). */
export function stripControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const control = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    out += control ? " " : ch;
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive, longest first, parts of 3+ letters only (so "Al" never rewrites "also"). */
function namePatterns(names: readonly string[]): RegExp[] {
  const parts = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length >= 3) parts.add(trimmed);
    for (const part of trimmed.split(/[\s,]+/)) if (part.length >= 3) parts.add(part);
  }
  return [...parts]
    .sort((a, b) => b.length - a.length)
    .map((part) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(part)}(?![\\p{L}\\p{N}])`, "giu"));
}

export interface ScrubContext {
  /** Every name the patient is known by (first, last, preferred, full). Replaced by [PATIENT]. */
  readonly patientNames: readonly string[];
  /** Display name of a person in the thread -> the label that replaces it (e.g. "Sender A [RN]"). */
  readonly participantLabels: ReadonlyMap<string, string>;
}

/**
 * One message body as the model may see it. Order matters: patient and participant names first (they are the most specific), then the
 * fixed-shape identifiers, then whitespace collapse (so a body can never forge a second message line) and delimiter neutralisation.
 */
export function scrubBody(raw: string, ctx: ScrubContext, maxChars: number): string {
  let text = stripControlChars(raw);
  for (const pattern of namePatterns(ctx.patientNames))
    text = text.replace(pattern, MESSAGING_AI_PATIENT_TOKEN);
  for (const [name, label] of ctx.participantLabels) {
    for (const pattern of namePatterns([name])) text = text.replace(pattern, label);
  }
  text = text
    .replace(EMAIL, "[EMAIL]")
    .replace(URL_LIKE, "[LINK]")
    .replace(SSN, "[ID]")
    .replace(PHONE, "[PHONE]")
    .replace(ISO_DATE, "[DATE]")
    .replace(MONTH_DATE, "[DATE]")
    .replace(SLASH_DATE, "[DATE]")
    .replace(STREET, "[ADDRESS]")
    .replace(LONG_NUMBER, "[ID]")
    .replace(DELIMITER, "[delimiter removed]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)} [cut]` : text;
}

/** "12 min before the last message" - never a clock time or a date. */
export function relativeLabel(lastMs: number, thisMs: number): string {
  const minutes = Math.max(0, Math.round((lastMs - thisMs) / 60_000));
  if (minutes === 0) return "at the last message";
  if (minutes < 60) return `${minutes} min before the last message`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h before the last message`;
  return `${Math.round(hours / 24)} d before the last message`;
}
