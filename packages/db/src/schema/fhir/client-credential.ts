// @wardenx/db — `fhir_client_credential` (M28 §3.3). The API-key / JWKS-pin material for a `fhir_client`.
// Rotation retires the prior row and opens a 30-day overlap window (§2.2).
//
// TENANT-SCOPED: `organization_id` NOT NULL on canonical app.org_id RLS (§3.5). `client_id` carries a
// REAL FK to `fhir_client` (ON DELETE cascade — a client's credentials die with it; the revocation
// cascade is W-FHIR-12). `secret_cipher` is the per-tenant DEK-encrypted secret and `secret_digest_sha256`
// the constant-time match digest — BOTH are §3.6-denylisted from the audit value_capture (a secret in the
// clear in an immutable audit log is still a leak); the eraser (§3.7) destroys both while keeping the
// `fingerprint` for ops display. It therefore audits through a generated scrubbing trigger, not the
// baseline.
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { fhirClientCredentialKind, fhirClientCredentialStatus } from "../../enums";
import { bytea } from "./cipher-column";
import { fhirClient } from "./client";

export const fhirClientCredential = pgTable("fhir_client_credential", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => fhirClient.id, { onDelete: "cascade" }),
  kind: fhirClientCredentialKind("kind").notNull(),
  /** Per-tenant DEK-encrypted; only the sha256 digest is matched at validate time (§3.6, denylisted). */
  secretCipher: bytea("secret_cipher"),
  /** sha256(plaintext) — the constant-time match digest at validate time (§3.6, denylisted). */
  secretDigestSha256: text("secret_digest_sha256"),
  /** First 8 chars for ops display — retained through the eraser (§3.7). */
  fingerprint: text("fingerprint").notNull(),
  status: fhirClientCredentialStatus("status").notNull().default("active"),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FhirClientCredentialRow = typeof fhirClientCredential.$inferSelect;
export type NewFhirClientCredentialRow = typeof fhirClientCredential.$inferInsert;
