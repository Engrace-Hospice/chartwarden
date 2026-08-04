import { sql } from "drizzle-orm";
// @wardenx/db — `mac_submitter_credential` (M23 Billing-Medicare §3.3; non-partitioned; retention class
// `operational`). Per-provider-entity MAC trading-partner identifiers + portal credentials. The portal
// client secret is stored ciphertext only (encrypted under a per-tenant DEK; never plaintext at rest);
// the DEK version is tracked for rotation. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): only organization_id (core) gets a real
// `.references(...)`. provider_entity_id (M40) and set_by_membership_id (core memberships) are LOGICAL
// FKs — plain uuid, validated at runtime (mirrors the M27 cost-report precedent). baa_record_ref is an
// opaque M4 BAA-registry reference string. No PHI / MBI is stored here (D13, D18).
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23MacJurisdiction } from "./types";

export const macSubmitterCredential = pgTable(
  "mac_submitter_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40

    macJurisdiction: m23MacJurisdiction("mac_jurisdiction").notNull(),

    // Submitter / trading-partner identifiers (not secret; kept plaintext for ops):
    submitterId: text("submitter_id").notNull(),
    tradingPartnerId: text("trading_partner_id").notNull(),

    // Portal credentials (encrypted under per-tenant DEK):
    clientId: text("client_id").notNull(),
    clientSecretCipher: text("client_secret_cipher").notNull(),
    clientSecretDekVersion: integer("client_secret_dek_version").notNull(),

    // BAA + lifecycle:
    baaRecordRef: text("baa_record_ref"), // M4 BAA registry ref
    credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
    lastSandboxTestAt: timestamp("last_sandbox_test_at", { withTimezone: true }),

    setByMembershipId: uuid("set_by_membership_id").notNull(), // logical FK → memberships

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerPe: uniqueIndex("mac_submitter_credential_pe_uq").on(t.providerEntityId),
    complete: sql`CHECK (length(client_id) > 0 AND length(client_secret_cipher) > 0)`,
  }),
);

export type MacSubmitterCredential = typeof macSubmitterCredential.$inferSelect;
export type NewMacSubmitterCredential = typeof macSubmitterCredential.$inferInsert;
