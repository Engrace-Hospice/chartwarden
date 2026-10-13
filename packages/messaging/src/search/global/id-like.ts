// ADR-0058 decision 3, "ID-like": a whitespace chunk that looks like an identifier is not indexed at all. Over-inclusive on
// purpose (a missed word is a search miss, an indexed identifier is a leak). Runs on the NFKC form BEFORE lowercasing,
// because case is part of rule (b).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /[^\s@]+@[^\s@]+/;
const URL_SHAPE = /:\/\/|^www\./i;
const PHONE_SHAPE = /^\+?[\d().\-/]+$/u;
const MRN_SHAPE = /^[a-z]{2,4}\d{5,}/i;
const DIGIT_RUN = /\d{6,}/u;
const ENCODED_ALPHABET = /^[A-Za-z0-9_\-+/=]+$/;
const ENCODED_EDGE = /^[^A-Za-z0-9_\-+/=]+|[^A-Za-z0-9_\-+/=]+$/g;
const MIN_ENCODED_LENGTH = 20;
const MIN_PHONE_DIGITS = 7;
const MIN_HEAVY_DIGITS = 6;
const ID_TRANSITIONS = 2;

function digitCount(chunk: string): number {
  return (chunk.match(/\p{Nd}/gu) ?? []).length;
}

/** Letter-to-digit and digit-to-letter changes over the letters and digits of the chunk (`hba1c` has 3). */
function letterDigitTransitions(chunk: string): number {
  let transitions = 0;
  let previous: "d" | "l" | null = null;
  for (const ch of chunk) {
    const kind = /\p{Nd}/u.test(ch) ? "d" : /\p{L}/u.test(ch) ? "l" : null;
    if (kind === null) continue;
    if (previous !== null && previous !== kind) transitions += 1;
    previous = kind;
  }
  return transitions;
}

/**
 * 20+ chars of hex, base32 or base64/base64url that carry a digit, an interior upper/lower mix, or one of `_-+/=`.
 * "Mixes upper and lower case" means an uppercase letter after the first character beside a lowercase one: a single leading
 * capital (a Titlecase word such as "Esophagogastroduodenoscopy") is not a mix, so a long letter-only word stays indexed.
 */
function looksEncoded(chunk: string): boolean {
  const body = chunk.replace(ENCODED_EDGE, "");
  if (body.length < MIN_ENCODED_LENGTH || !ENCODED_ALPHABET.test(body)) return false;
  const mixedCase = /[a-z]/.test(body) && /[A-Z]/.test(body.slice(1));
  return /\d/.test(body) || mixedCase || /[_\-+/=]/.test(body);
}

export function isIdLikeChunk(chunk: string): boolean {
  if (UUID.test(chunk) || EMAIL.test(chunk) || URL_SHAPE.test(chunk)) return true;
  const digits = digitCount(chunk);
  if (PHONE_SHAPE.test(chunk) && digits >= MIN_PHONE_DIGITS) return true;
  if (MRN_SHAPE.test(chunk) || DIGIT_RUN.test(chunk) || digits >= MIN_HEAVY_DIGITS) return true;
  if (looksEncoded(chunk)) return true;
  return letterDigitTransitions(chunk) >= ID_TRANSITIONS;
}
