// @chartwarden/db — `fhir_capability_snapshot` (M28 §3.3, D11). The platform-singleton CapabilityStatement:
// the boot-generated conformance JSON, its sha256 checksum, and an HMAC-SHA256 signature over the
// checksum. `/fhir/r4/metadata` returns the snapshot; the hourly validator detects tampering.
//
// PLATFORM-SHARED (the ONLY M28 table with no `organization_id` — a conformance statement is the same for
// every tenant): read-all `USING (true)` to chartwarden_app, writes only via chartwarden_admin (§3.5; the M32
// `ai_capability` / M38 `code_system` precedent — architecture wins over the spec's `app.role` policy,
// which the canonical-RLS-variable rule bans). No PHI, so the §3.6 denylist is empty; it audits through
// M1's baseline `chartwarden_audit_trigger()`, which resolves the (absent) org from the session. The
// `signature` is an HMAC, not a DEK cipher, so it is NOT in `M28_CIPHER_COLUMNS`.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { fhirVersionEnum } from "../../enums";
import { bytea } from "./cipher-column";

export const fhirCapabilitySnapshot = pgTable(
  "fhir_capability_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fhirVersion: fhirVersionEnum("fhir_version").notNull(),
    releaseTag: text("release_tag").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    capabilityStatement: jsonb("capability_statement").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    /** HMAC-SHA256(checksumSha256, platform_signing_key). */
    signature: bytea("signature").notNull(),
  },
  (t) => ({
    releaseIdx: index("fhir_capability_release_idx").on(t.fhirVersion, t.releaseTag),
  }),
);

export type FhirCapabilitySnapshotRow = typeof fhirCapabilitySnapshot.$inferSelect;
export type NewFhirCapabilitySnapshotRow = typeof fhirCapabilitySnapshot.$inferInsert;
