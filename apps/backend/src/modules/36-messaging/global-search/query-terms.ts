// WP 2.7b C3 (ADR-0058 decision 8.2) - turning the query text into search terms and, per key version, into tags.
//   * the query is tokenised by the SAME code as the index (no indexable token -> 422 INVALID_SEARCH_QUERY);
//   * at most MAX_QUERY_TERMS distinct terms;
//   * every term but the last is a WHOLE-WORD tag; the last is a PREFIX tag of its first L characters, L = the largest of {3,5,8,12} <= len;
//   * a body matches only if each non-last term is a whole token of it and the last is a prefix of some token (this is what
//     drops truncation collisions and dummies after decryption).
// Nothing here is logged or stored; the terms live for one request.
import {
  type SearchKeyProvider,
  prefixTagLengthFor,
  tagForPrefix,
  tagForWord,
  tokenizeForSearch,
} from "@wardenx/messaging";
import { WardenXError } from "@wardenx/types";

export const MAX_QUERY_TERMS = 8;

const invalid = (message: string) => new WardenXError("INVALID_SEARCH_QUERY", message, 422);

/** The query's distinct index tokens, in the order typed. The LAST one is the (possibly partial) prefix term. */
export function parseQueryTerms(q: string): string[] {
  const terms = tokenizeForSearch(q);
  if (terms.length === 0) {
    throw invalid(
      "no searchable word: search matches whole words and word beginnings of at least 3 letters (numbers and codes are not searchable)",
    );
  }
  if (terms.length > MAX_QUERY_TERMS) {
    throw invalid(`a search can use at most ${MAX_QUERY_TERMS} different words`);
  }
  return terms;
}

/** One tag per term for one key version's key and tag width (the last term is the prefix tag). */
export function tagsForTerms(key: Buffer, terms: readonly string[], tagBits: number): number[] {
  return terms.map((term, i) =>
    i === terms.length - 1
      ? tagForPrefix(key, [...term].slice(0, prefixTagLengthFor([...term].length)).join(""), tagBits)
      : tagForWord(key, term, tagBits),
  );
}

export interface VersionQuery {
  readonly keyVersion: string;
  /** Distinct tag values for this version (two terms can collide at T bits; the body check still decides). */
  readonly tags: readonly number[];
  /** Per-term tags in term order (for the head-bucket test). */
  readonly termTags: readonly number[];
}

export async function buildVersionQueries(
  keys: SearchKeyProvider,
  organizationId: string,
  versions: readonly { readonly keyVersion: string; readonly tagBits: number }[],
  terms: readonly string[],
): Promise<VersionQuery[]> {
  return Promise.all(
    versions.map(async ({ keyVersion, tagBits }) => {
      const key = await keys.tagKey(organizationId, keyVersion);
      const termTags = tagsForTerms(key, terms, tagBits);
      return { keyVersion, termTags, tags: [...new Set(termTags)] };
    }),
  );
}

/** True when every term of the active version's query lands in a head bucket (single-term head queries included). */
export function isHeadBucketQuery(
  termTags: readonly number[],
  headBuckets: ReadonlySet<number>,
): boolean {
  return termTags.length > 0 && termTags.every((tag) => headBuckets.has(tag));
}

/** The verification of a decrypted body against the query terms (whole-word for all but the last, prefix for the last). */
export function bodyMatchesQueryTerms(plaintext: string, terms: readonly string[]): boolean {
  const tokens = tokenizeForSearch(plaintext);
  const whole = new Set(tokens);
  const last = terms[terms.length - 1];
  if (last === undefined) return false;
  for (const term of terms.slice(0, -1)) if (!whole.has(term)) return false;
  return tokens.some((token) => token.startsWith(last));
}
