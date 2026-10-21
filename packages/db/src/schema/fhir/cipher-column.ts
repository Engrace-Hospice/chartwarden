// @chartwarden/db — the `bytea` column type M28's §3.6 cipher columns use.
//
// §3.6 registers three DEK-wrapped columns with M1's envelope-encryption helper:
// `tenant_fhir_config.cursor_signing_key_cipher`, `fhir_client_credential.secret_cipher`, and the HMAC
// `fhir_capability_snapshot.signature`. The two ciphers hold DEK-wrapped BYTES, not text — the encrypt
// happens in the M28 service BEFORE the insert and the decrypt at the M28 route, so no database-side
// reader (a replica, a backup, a cold-storage partition) ever holds plaintext. The capability-snapshot
// `signature` is an HMAC-SHA256, not PHI, so it is NOT in `M28_CIPHER_COLUMNS`; it shares this column
// type only because it is likewise raw bytes.
//
// Declared ONCE for the module rather than per file (the M32 `cipher-column.ts` precedent): two copies
// of a customType is two places a future `dataType()` change has to land, and the one that is missed
// silently writes a different column type.
import { customType } from "drizzle-orm/pg-core";

/** Raw PostgreSQL `bytea` — a per-tenant-DEK envelope-encrypted payload (§3.6) or an HMAC signature. */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
