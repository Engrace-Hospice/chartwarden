// WP 2.7b / ADR-0058 decision 3 - the deterministic, server-side tokenizer of the global blind-token index. The query is
// tokenised by this same code. It deliberately does NOT reuse 2.7a's `normalizeSearchText`: that comparison form has no
// ID-like filter, no diacritic folding and no length bounds, and the global index must never hold a digit or an identifier.
import { isIdLikeChunk } from "./id-like";
import {
  MAX_PREFIX_TAG_LENGTH,
  MAX_TOKEN_LENGTH,
  MIN_QUERY_PREFIX_LENGTH,
  MIN_TOKEN_LENGTH,
} from "./params";
import { STOP_WORDS } from "./stop-words";

const COMBINING_MARKS = /\p{M}/gu;
const NON_LETTERS = /\P{L}+/u;

/** NFD, strip combining marks, recompose: "cafe" and "café" are one token (English launch policy, pluggable later). */
function foldDiacritics(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
}

/**
 * The distinct, ordered index tokens of a text:
 * ID-like chunks dropped (on the NFKC form, case intact) -> lowercase (locale-independent) -> diacritics folded -> split
 * on non-letters (a digit is a separator, so no token holds one) -> length 3..40 (longer is DROPPED, never truncated)
 * -> stop words dropped.
 */
export function tokenizeForSearch(text: string): string[] {
  const seen = new Set<string>();
  for (const chunk of text.normalize("NFKC").split(/\s+/u)) {
    if (chunk === "" || isIdLikeChunk(chunk)) continue;
    for (const piece of foldDiacritics(chunk.toLowerCase()).split(NON_LETTERS)) {
      const length = [...piece].length;
      if (length < MIN_TOKEN_LENGTH || length > MAX_TOKEN_LENGTH) continue;
      if (STOP_WORDS.has(piece)) continue;
      seen.add(piece);
    }
  }
  return [...seen];
}

/** The HMAC input of a whole-word tag: `w\0 token`. */
export function wholeWordInput(token: string): string {
  return `w\u0000${token}`;
}

/** The HMAC input of a prefix tag: `p\0 len \0 prefix`. */
export function prefixInput(prefix: string): string {
  return `p\u0000${[...prefix].length}\u0000${prefix}`;
}

/**
 * Every tag input a message holding these tokens produces, distinct and in a stable order: per token the whole-word tag,
 * then prefix tags for lengths 3..min(len, 12). `n` of the padding rule is the length of this list.
 */
export function indexTagStrings(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const token of tokens) {
    seen.add(wholeWordInput(token));
    const chars = [...token];
    const longest = Math.min(chars.length, MAX_PREFIX_TAG_LENGTH);
    for (let length = MIN_QUERY_PREFIX_LENGTH; length <= longest; length += 1) {
      seen.add(prefixInput(chars.slice(0, length).join("")));
    }
  }
  return [...seen];
}
