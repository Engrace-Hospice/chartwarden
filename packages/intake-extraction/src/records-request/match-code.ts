// packages/intake-extraction/src/records-request/match-code.ts — the records-request CODE (F-238).
//
// Intake staff fax a request for a prospect's older records with a cover sheet carrying a short code
// ("RR-7KHM3XT"). The records come back days later by fax (rarely e-mail); when the code is on the first
// pages (or in the e-mail subject) the batch is filed under the request's referral without anyone typing.
//
// The ALPHABET is built so a fax/OCR round trip cannot turn one valid code into another:
//   · it never contains O/0/Q, I/1/L, S/5, B/8 — the pairs OCR swaps — nor U (U/V);
//   · Z/2 and G/6 keep ONE member each (the digit); a read Z or G folds onto it;
//   · 23 symbols (prime) and a weighted mod-23 CHECK character: every single substitution and every
//     adjacent transposition is detected, so a misread never lands on a different request.
// A read character outside the alphabet is expanded to the alphabet characters OCR commonly mistakes for
// it (a printed D read as 0/O/Q, a printed T/7/J read as 1/I/L …) and only candidates whose check
// character verifies are returned. The matcher is pure — the caller looks the candidates up org-scoped
// and files the batch only when exactly ONE open request answers.

/** 17 letters + 6 digits = 23 (prime). None of O 0 Q I 1 L S 5 B 8 U Z G. */
export const RECORDS_REQUEST_ALPHABET = "ACDEFHJKMNPRTVWXY234679";
export const RECORDS_REQUEST_PREFIX = "RR-";
/** Payload characters before the check character. 23^6 ≈ 148M codes per org. */
export const RECORDS_REQUEST_PAYLOAD_LENGTH = 6;
const BODY_LENGTH = RECORDS_REQUEST_PAYLOAD_LENGTH + 1;
const MOD = RECORDS_REQUEST_ALPHABET.length; // 23
const VALUE = new Map([...RECORDS_REQUEST_ALPHABET].map((c, i) => [c, i] as const));

/**
 * What OCR reads INSTEAD of a printed alphabet character → the printed characters it could have been.
 * Characters already in the alphabet are taken as read (the check character catches a wrong one).
 */
const CONFUSIONS: Readonly<Record<string, readonly string[]>> = {
  "0": ["D"],
  O: ["D"],
  Q: ["D"],
  "1": ["T", "7", "J"],
  I: ["T", "7", "J"],
  L: ["T", "7", "J"],
  "|": ["T", "7", "J"],
  "!": ["T", "7", "J"],
  "5": ["9", "3"],
  S: ["9", "3"],
  "8": ["3", "E"],
  B: ["3", "E"],
  Z: ["2"],
  G: ["6"],
  U: ["V"],
};
/** A read with more unreadable characters than this is not trusted at all. */
const MAX_EXPANDED_POSITIONS = 3;

/** Weighted sum (weights 1..7) — must be ≡ 0 (mod 23) for a valid body (payload + check). */
function weighted(values: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += (i + 1) * (values[i] as number);
  return s % MOD;
}

/** The check character for a payload of RECORDS_REQUEST_PAYLOAD_LENGTH alphabet characters. */
export function recordsRequestCheckChar(payload: string): string {
  if (payload.length !== RECORDS_REQUEST_PAYLOAD_LENGTH) throw new Error("bad payload length");
  const vals = [...payload].map((c) => {
    const v = VALUE.get(c);
    if (v === undefined) throw new Error("payload outside the records-request alphabet");
    return v;
  });
  // (S + 7·c) ≡ 0 (mod 23) → c ≡ −S · 7⁻¹; 7⁻¹ ≡ 10 (mod 23).
  const c = (((MOD - weighted(vals)) % MOD) * 10) % MOD;
  return RECORDS_REQUEST_ALPHABET[c] as string;
}

/** Is `code` (canonical, "RR-" + 7) a well-formed code whose check character verifies? */
export function isValidRecordsRequestCode(code: string): boolean {
  if (!code.startsWith(RECORDS_REQUEST_PREFIX)) return false;
  const body = code.slice(RECORDS_REQUEST_PREFIX.length);
  if (body.length !== BODY_LENGTH) return false;
  const vals: number[] = [];
  for (const ch of body) {
    const v = VALUE.get(ch);
    if (v === undefined) return false;
    vals.push(v);
  }
  return weighted(vals) === 0;
}

/**
 * A fresh code. `random` returns `n` uniformly random bytes (crypto in production); rejection sampling
 * keeps the alphabet uniform. Uniqueness per org is the database's (unique index) — the caller retries.
 */
export function generateRecordsRequestCode(random: (n: number) => Uint8Array): string {
  let payload = "";
  const limit = 256 - (256 % MOD);
  while (payload.length < RECORDS_REQUEST_PAYLOAD_LENGTH) {
    for (const b of random(16)) {
      if (b >= limit) continue;
      payload += RECORDS_REQUEST_ALPHABET[b % MOD];
      if (payload.length === RECORDS_REQUEST_PAYLOAD_LENGTH) break;
    }
  }
  return `${RECORDS_REQUEST_PREFIX}${payload}${recordsRequestCheckChar(payload)}`;
}

/** Every alphabet reading of a 7-character OCR body whose check character verifies. */
function resolveBody(raw: string): string[] {
  const options: string[][] = [];
  let expanded = 0;
  for (const ch of raw) {
    if (VALUE.has(ch)) {
      options.push([ch]);
      continue;
    }
    const alts = CONFUSIONS[ch];
    if (!alts) return [];
    expanded += 1;
    if (expanded > MAX_EXPANDED_POSITIONS) return [];
    options.push([...alts]);
  }
  let partial = [""];
  for (const opts of options) partial = partial.flatMap((p) => opts.map((o) => p + o));
  return partial.filter((b) => isValidRecordsRequestCode(`${RECORDS_REQUEST_PREFIX}${b}`));
}

const CODE_CHAR = /[A-Z0-9|!]/;
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Z0-9]/.test(c);

/**
 * Find records-request codes in free text (a fax page's OCR text, an e-mail subject). Returns canonical
 * codes, deduplicated, in order of first appearance — possibly more than one when a misread is ambiguous;
 * the caller must accept a match only when exactly one OPEN request answers.
 *
 * The anchor is "RR" standing alone as a word (so "CORRECT", "ERRATA" never anchor), then an optional
 * separator (- – — _ : . # or up to two spaces), then exactly seven code characters followed by a word
 * boundary. A respiratory rate ("RR 18", "RR: 22 bpm", "RR 20/min") cannot produce seven contiguous code
 * characters, and anything that does still has to pass the check character and then name a request that
 * exists in this organization.
 */
export function findRecordsRequestCodes(text: string): string[] {
  const up = text.toUpperCase();
  const out: string[] = [];
  const anchor = /R\s?R/g;
  for (let m = anchor.exec(up); m !== null; m = anchor.exec(up)) {
    const start = m.index;
    if (isAlnum(up[start - 1])) continue;
    let i = start + m[0].length;
    // separator
    let sep = 0;
    while (i < up.length && sep < 3 && /[\s\-–—_:.#]/.test(up[i] as string)) {
      i += 1;
      sep += 1;
    }
    const body = up.slice(i, i + BODY_LENGTH);
    if (body.length !== BODY_LENGTH || ![...body].every((c) => CODE_CHAR.test(c))) continue;
    if (isAlnum(up[i + BODY_LENGTH])) continue;
    for (const b of resolveBody(body)) {
      const code = `${RECORDS_REQUEST_PREFIX}${b}`;
      if (!out.includes(code)) out.push(code);
    }
  }
  return out;
}

/** Normalise a code a person TYPED (case, spaces, a missing dash, the same OCR folds). Null if invalid. */
export function normaliseRecordsRequestCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s\-–—_]/g, "");
  const body = compact.startsWith("RR") ? compact.slice(2) : compact;
  if (body.length !== BODY_LENGTH) return null;
  const found = resolveBody(body);
  return found.length === 1 ? `${RECORDS_REQUEST_PREFIX}${found[0]}` : null;
}
