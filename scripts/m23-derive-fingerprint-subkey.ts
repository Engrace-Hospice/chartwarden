/**
 * Derive the M23 clearinghouse fingerprint SUBKEY of a credential KEK (ops runbook §8.3), for
 * `M23_CLEARINGHOUSE_RETIRED_FINGERPRINT_KEYS`. That setting lists derived subkeys, never a master KEK: a subkey only computes
 * fingerprints and opens nothing.
 *
 *   bun scripts/m23-derive-fingerprint-subkey.ts < old-kek-file      (or paste the old KEK and press Ctrl-D)
 *
 * Reads the KEK (base64, 32 bytes) from stdin and prints the subkey (base64) and its public key id (16 hex, the value reservations
 * record in `credential_fingerprint_key_id`). The KEK itself is never printed, and nothing is written anywhere.
 */
import { Buffer } from "node:buffer";
import { loadMacSecretKek } from "../apps/backend/src/modules/23-billing-medicare/routes/secret-cipher";
import {
  deriveFingerprintSubkey,
  fingerprintKeyIdOf,
} from "../apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/secret-cipher";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks).toString("utf8").trim();
if (!raw) {
  console.error("m23-derive-fingerprint-subkey: give the KEK (base64, 32 bytes) on stdin");
  process.exit(2);
}
let kek: Buffer;
try {
  kek = loadMacSecretKek(raw);
} catch {
  // the loader's own message is not echoed: it is generic, but this path never risks printing the input
  console.error("m23-derive-fingerprint-subkey: stdin is not a 32-byte base64 KEK");
  process.exit(2);
}
const subkey = deriveFingerprintSubkey(kek);
kek.fill(0);
console.log(`subkey=${subkey.toString("base64")}`);
console.log(`keyId=${fingerprintKeyIdOf(subkey)}`);
