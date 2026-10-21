// WP 2.7b C3 (ADR-0058 decision 8.2) - turning the query text into search terms and, per key version AND per channel, into tags.
//   * the query is tokenised by the SAME code as the index (no indexable token -> 422 INVALID_SEARCH_QUERY). Name exclusion is
//     deliberately NOT applied to the QUERY: a patient or contact name stays an ordinary term that matches nothing, because no
//     name is ever indexed and `bodyMatchesQueryTerms` never matches an excluded body token. It therefore takes exactly the
//     path of any unknown word (same SQL, same cost, same empty 200): no response, status code or timing says "this is a name",
//     so the roster of names cannot be enumerated through search (a 422 or a dropped term would be exactly that oracle);
//   * at most MAX_QUERY_TERMS distinct terms;
//   * every term but the last is a WHOLE-WORD tag; the last is a PREFIX tag of its first L characters, L = the largest of {3,5,8,12} <= len;
//   * PER-CHANNEL KEYS: every searched channel gets its own channel key (`deriveChannelKey`), so the same term has a different tag in
//     every channel; a channel is searched only if the caller is an active member of it or it is an announcement channel;
//   * a body matches only if each non-last term is a whole token of it and the last is a prefix of some token (this is what
//     drops truncation collisions and dummies after decryption). Excluded name tokens of the body never match.
// Nothing here is logged or stored; the terms live for one request.
import {
  type ExcludedTokens,
  type SearchKeyProvider,
  deriveChannelKey,
  prefixTagLengthFor,
  tagForPrefix,
  tagForWord,
  tokenizeForSearch,
} from "@chartwarden/messaging";
import { ChartWardenError } from "@chartwarden/types";
import { headPairKey } from "./stats";

export const MAX_QUERY_TERMS = 8;

const invalid = (message: string) => new ChartWardenError("INVALID_SEARCH_QUERY", message, 422);

/** The query's distinct index tokens, in the order typed. The LAST one is the (possibly partial) prefix term. */
export function parseQueryTerms(q: string): string[] {
  const terms = tokenizeForSearch(q);
  if (terms.length === 0) {
    throw invalid(
      "no searchable word: search matches whole words and word beginnings of at least 3 letters (numbers, codes and very common words are not searchable)",
    );
  }
  if (terms.length > MAX_QUERY_TERMS) {
    throw invalid(`a search can use at most ${MAX_QUERY_TERMS} different words`);
  }
  return terms;
}

/** One tag per term for one channel key and tag width (the last term is the prefix tag). */
export function tagsForTerms(key: Buffer, terms: readonly string[], tagBits: number): number[] {
  return terms.map((term, i) =>
    i === terms.length - 1
      ? tagForPrefix(
          key,
          [...term].slice(0, prefixTagLengthFor([...term].length)).join(""),
          tagBits,
        )
      : tagForWord(key, term, tagBits),
  );
}

export interface ChannelQuery {
  readonly channelId: string;
  /** Distinct tag values for this channel (two terms can collide at T bits; the body check still decides). */
  readonly tags: readonly number[];
}

export interface VersionQuery {
  readonly keyVersion: string;
  readonly channels: readonly ChannelQuery[];
}

export interface BuiltQueries {
  readonly queries: VersionQuery[];
  /** Channels left out because every term of the query is a head bucket in them (counted, never named). */
  readonly headSkipped: number;
}

/** True when every term of the query lands in a head bucket of this channel. */
export function isHeadBucketQuery(
  channelId: string,
  termTags: readonly number[],
  headBuckets: ReadonlySet<string>,
): boolean {
  return (
    termTags.length > 0 && termTags.every((tag) => headBuckets.has(headPairKey(channelId, tag)))
  );
}

export async function buildVersionQueries(
  keys: SearchKeyProvider,
  organizationId: string,
  versions: readonly {
    readonly keyVersion: string;
    readonly tagBits: number;
    readonly headBuckets: ReadonlySet<string>;
  }[],
  terms: readonly string[],
  channelIds: readonly string[],
): Promise<BuiltQueries> {
  let headSkipped = 0;
  const queries = await Promise.all(
    versions.map(async ({ keyVersion, tagBits, headBuckets }) => {
      const searchKey = await keys.tagKey(organizationId, keyVersion);
      const channels: ChannelQuery[] = [];
      for (const channelId of channelIds) {
        const termTags = tagsForTerms(
          deriveChannelKey(searchKey, keyVersion, tagBits, channelId),
          terms,
          tagBits,
        );
        if (isHeadBucketQuery(channelId, termTags, headBuckets)) {
          headSkipped += 1;
          continue;
        }
        channels.push({ channelId, tags: [...new Set(termTags)] });
      }
      return { keyVersion, channels };
    }),
  );
  return { queries, headSkipped };
}

/** The verification of a decrypted body against the query terms (whole-word for all but the last, prefix for the last). */
export function bodyMatchesQueryTerms(
  plaintext: string,
  terms: readonly string[],
  excluded?: ExcludedTokens,
): boolean {
  const tokens = tokenizeForSearch(plaintext, excluded);
  const whole = new Set(tokens);
  const last = terms[terms.length - 1];
  if (last === undefined) return false;
  for (const term of terms.slice(0, -1)) if (!whole.has(term)) return false;
  return tokens.some((token) => token.startsWith(last));
}
