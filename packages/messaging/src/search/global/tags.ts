// ADR-0058 decisions 2 and 3 - the per-tenant search key and the truncated HMAC tags.
//   K_search = HKDF-SHA256(ikm = DEK, salt = "", info = "wardenx-message-search:" || orgId || ":" || ringVersionLabel)
// The version part is the key ring's TEXT label (for example "v1"), appended verbatim: the ADR's `":v" || v` would produce
// "vv1" for a label that is already "v1". The info label is distinct from the body-encryption label, so the keys are
// domain-separated. Tag = first 32 bits of HMAC-SHA256(K_search, input), kept to the top T bits.
import { createHmac, hkdfSync } from "node:crypto";
import { padTags } from "./padding";
import { assertTagBits } from "./params";
import { indexTagStrings, prefixInput, tokenizeForSearch, wholeWordInput } from "./tokenizer";

const SEARCH_INFO_PREFIX = "wardenx-message-search:";
const KEY_LENGTH = 32;
const TAG_SOURCE_BITS = 32;

export function deriveSearchKey(dek: Buffer, orgId: string, versionLabel: string): Buffer {
  const derived = hkdfSync(
    "sha256",
    dek,
    Buffer.alloc(0),
    `${SEARCH_INFO_PREFIX}${orgId}:${versionLabel}`,
    KEY_LENGTH,
  );
  return Buffer.from(derived);
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

/** The tags stored for a message body: real whole-word and prefix tags, padded with fresh dummies. */
export function buildMessageTags(key: Buffer, body: string, tagBits: number): number[] {
  assertTagBits(tagBits);
  const real = indexTagStrings(tokenizeForSearch(body)).map((input) =>
    truncatedTag(key, input, tagBits),
  );
  return padTags(real, tagBits);
}
