// ADR-0058 decisions 2 and 3 - the per-tenant search key and the truncated HMAC tags.
//   K_search = HKDF-SHA256(ikm = DEK, salt = "", info = SEARCH_LABELS_WRITE.searchInfoPrefix ("wardenx-message-search:" until the flip) || orgId || ":" || ringVersionLabel)
// The version part is the key ring's TEXT label (for example "v1"), appended verbatim: the ADR's `":v" || v` would produce
// "vv1" for a label that is already "v1". The info label is distinct from the body-encryption label, so the keys are
// domain-separated. Tag = first 32 bits of HMAC-SHA256(K_search, input), kept to the top T bits.
import { createHmac, hkdfSync } from "node:crypto";
import { padTags } from "./padding";
import { assertTagBits } from "./params";
import {
  type ExcludedTokens,
  indexTagStrings,
  prefixInput,
  tokenizeForSearch,
  wholeWordInput,
} from "./tokenizer";

// ChartWarden rename of the HKDF info labels (release 1 = READ-SIDE). A label SET is the search-key label plus the
// channel-key label that were used together; the index writer uses SEARCH_LABELS_WRITE, a query probes SEARCH_LABELS_READ
// (current first), so rows indexed under either set stay searchable. Name digests are derived from the search key and so
// follow the writer's set. LEGACY(wardenx->chartwarden): remove the legacy set after the index has been rebuilt (release 3).
export interface SearchLabels {
  readonly searchInfoPrefix: string;
  readonly channelInfoPrefix: string;
}
export const SEARCH_LABELS_CURRENT: SearchLabels = {
  searchInfoPrefix: "chartwarden-message-search:",
  channelInfoPrefix: "chartwarden-message-search-channel:",
};
export const SEARCH_LABELS_LEGACY: SearchLabels = {
  searchInfoPrefix: "wardenx-message-search:",
  channelInfoPrefix: "wardenx-message-search-channel:",
};
// Release 2 (write-side flip): set to SEARCH_LABELS_CURRENT, then rebuild the whole index (tags are derived data).
export const SEARCH_LABELS_WRITE: SearchLabels = SEARCH_LABELS_LEGACY;
export const SEARCH_LABELS_READ: readonly SearchLabels[] = [
  SEARCH_LABELS_CURRENT,
  SEARCH_LABELS_LEGACY,
];
const NAME_DIGEST_INPUT_PREFIX = "n\u0000";
const NAME_DIGEST_BYTES = 8;
const KEY_LENGTH = 32;
const TAG_SOURCE_BITS = 32;

export function deriveSearchKey(
  dek: Buffer,
  orgId: string,
  versionLabel: string,
  labels: SearchLabels = SEARCH_LABELS_WRITE,
): Buffer {
  const derived = hkdfSync(
    "sha256",
    dek,
    Buffer.alloc(0),
    `${labels.searchInfoPrefix}${orgId}:${versionLabel}`,
    KEY_LENGTH,
  );
  return Buffer.from(derived);
}

/**
 * ADR-0058 per-channel keys: K_ch = HKDF-SHA256(ikm = K_search, salt = "", info = SEARCH_LABELS_WRITE.channelInfoPrefix ("wardenx-message-search-channel:" until the flip) || version || ":t" ||
 * tagBits || ":" || channelId). The version label and T are bound into the info (security review L3), so a rebuild at another T or
 * under another ring version produces unrelated tags and a tag in one channel says nothing about the same word in another.
 */
export function deriveChannelKey(
  searchKey: Buffer,
  versionLabel: string,
  tagBits: number,
  channelId: string,
  labels: SearchLabels = SEARCH_LABELS_WRITE,
): Buffer {
  const bits = assertTagBits(tagBits);
  return Buffer.from(
    hkdfSync(
      "sha256",
      searchKey,
      Buffer.alloc(0),
      `${labels.channelInfoPrefix}${versionLabel}:t${bits}:${channelId}`,
      KEY_LENGTH,
    ),
  );
}

/** Keyed digest of one excluded name token (16 hex chars). The input prefix `n\0` is disjoint from the tag inputs `w\0` and `p\0`. */
export function nameTokenDigest(searchKey: Buffer, token: string): string {
  return createHmac("sha256", searchKey)
    .update(`${NAME_DIGEST_INPUT_PREFIX}${token}`, "utf8")
    .digest()
    .subarray(0, NAME_DIGEST_BYTES)
    .toString("hex");
}

/** An `ExcludedTokens` over a set of `nameTokenDigest`s: the plaintext names are never held, only their keyed digests. */
export function digestExclusion(searchKey: Buffer, digests: ReadonlySet<string>): ExcludedTokens {
  return { has: (token) => digests.size > 0 && digests.has(nameTokenDigest(searchKey, token)) };
}

function truncatedTag(key: Buffer, input: string, tagBits: number): number {
  const bits = assertTagBits(tagBits);
  const mac = createHmac("sha256", key).update(input, "utf8").digest();
  return mac.readUInt32BE(0) >>> (TAG_SOURCE_BITS - bits);
}

export const tagForWord = (key: Buffer, token: string, tagBits: number): number =>
  truncatedTag(key, wholeWordInput(token), tagBits);

export const tagForPrefix = (key: Buffer, prefix: string, tagBits: number): number =>
  truncatedTag(key, prefixInput(prefix), tagBits);

/**
 * The tags stored for a message body: real whole-word and prefix tags, padded with fresh dummies. `key` is the message's CHANNEL
 * key (`deriveChannelKey`); excluded name tokens contribute no tag of either kind.
 */
export function buildMessageTags(
  key: Buffer,
  body: string,
  tagBits: number,
  excluded?: ExcludedTokens,
): number[] {
  assertTagBits(tagBits);
  const real = indexTagStrings(tokenizeForSearch(body, excluded)).map((input) =>
    truncatedTag(key, input, tagBits),
  );
  return padTags(real, tagBits);
}
