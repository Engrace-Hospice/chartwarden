// apps/backend/src/bootstrap/strict-key-base64.ts — the ONE strict reader of a comma-separated list of 32-byte keys, shared by the
// boot env validation (bootstrap/env.ts) and the M23 clearinghouse cipher (retired fingerprint subkeys), so the two cannot drift.
import { Buffer } from "node:buffer";

/**
 * Exactly a 32-byte key in padded standard base64 (44 characters, one `=`). `Buffer.from(x, "base64")` skips characters it does not
 * know, so a typo'd entry could still decode to 32 bytes and protect nothing; this refuses it.
 */
export const STRICT_KEY_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/** The problem text for a malformed list. It never echoes the value (an entry may be key material). */
export const STRICT_KEY_LIST_PROBLEM =
  "must be comma-separated 32-byte keys, each padded standard base64 (44 chars)";

/** The decoded keys, or null when any entry is not a strict 32-byte key. Entries are trimmed. */
export function parseStrictKeyList(raw: string): Buffer[] | null {
  const keys: Buffer[] = [];
  for (const entry of raw.split(",").map((e) => e.trim())) {
    if (!STRICT_KEY_BASE64.test(entry)) return null;
    const key = Buffer.from(entry, "base64");
    if (key.length !== 32) return null;
    keys.push(key);
  }
  return keys;
}
