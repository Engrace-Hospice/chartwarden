// @wardenx/db — the `bytea` column type M32's §3.6 cipher columns use.
//
// §3.6 registers four columns with M1's envelope-encryption helper: `ai_invocation`'s three payload
// ciphers and `ai_hallucination_report.reporter_narrative_cipher`. All four hold DEK-wrapped BYTES, not
// text — the encrypt happens in the M32 SDK BEFORE the insert and the decrypt at the M32 service route,
// so no database-side reader (a replica, a backup, an `ai_invocation` partition on cold storage) ever
// holds plaintext PHI.
//
// Declared ONCE for the module rather than per file (the M20 `safety-sos-alerts.ts` /
// `safety-check-ins.ts` pair copied it twice): two copies of a customType is two places a future
// `dataType()` change has to land, and the one that is missed silently writes a different column type.
import { customType } from "drizzle-orm/pg-core";

/** Envelope-encrypted payload under the per-tenant DEK, stored as PostgreSQL `bytea` (§3.6). */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
