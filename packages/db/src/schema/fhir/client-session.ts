// @wardenx/db — `fhir_client_session` (M28 §3.3). One row per minted access token (JTI), the SMART
// Backend Services / API-key session ledger. MONTHLY-PARTITIONED by `issued_at` (§3.3): high volume,
// routine-purged past 90 days (`operational` retention, §3.7).
//
// PARTITIONED, so the composite primary key `(jti, issued_at)` is declared in SQL (migration
// 0135) — PostgreSQL requires the partition key in every unique/primary constraint, and Drizzle cannot
// express a partitioned table. The `.primaryKey()` on `jti` below is the ORM's view of row identity; the
// audit trigger (on the parent) is a GENERATED function that hard-codes the parent name, because M1's
// baseline trigger would otherwise stamp `TG_TABLE_NAME` = the dated partition (the M32 `ai_token_ledger`
// lesson).
//
// TENANT-SCOPED: `organization_id` NOT NULL on canonical app.org_id RLS (§3.5). NO PHI — the JTI, scopes
// and key fingerprint are operational — so the §3.6 denylist is empty. `client_id` is a LOGICAL uuid (a
// real FK to the client would force this partitioned child to name the client's key, and the client is
// unpartitioned; the write boundary validates it).
import { index, inet, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const fhirClientSession = pgTable(
  "fhir_client_session",
  {
    // Composite PK (jti, issued_at) declared in SQL (0135) — see header.
    jti: uuid("jti").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    clientId: uuid("client_id").notNull(),
    /** string[] — the scopes actually granted (a subset of the client's allowedScopes ∩ requested). */
    scopesGranted: jsonb("scopes_granted").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipAtIssue: inet("ip_at_issue"),
    /** sha256 of the signing-key fingerprint that minted this token. */
    tokenKeyFingerprint: text("token_key_fingerprint").notNull(),
  },
  (t) => ({
    clientIdx: index("fhir_client_session_client_idx").on(t.clientId, t.expiresAt),
    expiryIdx: index("fhir_client_session_expiry_idx").on(t.expiresAt),
  }),
);
// Partition by RANGE (issued_at) monthly per M4 §3.6.

export type FhirClientSessionRow = typeof fhirClientSession.$inferSelect;
export type NewFhirClientSessionRow = typeof fhirClientSession.$inferInsert;
