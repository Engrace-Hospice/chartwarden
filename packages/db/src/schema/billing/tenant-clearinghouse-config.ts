// @chartwarden/db — `tenant_clearinghouse_config` (M23 Billing-Medicare; ADR-0053 amendment 2026-11-06; migration 1417).
// The clearinghouse a tenant chose: `stedi`, `claimmd` or `outside` ("bills outside ChartWarden"), its mode, its sealed
// vendor credential and where the config is in draft -> verified -> active. One row per organization. The CHECKs in the
// migration are the authority on which column combinations are legal; this file mirrors the shape for Drizzle.
//
// `secret_cipher` is write-only: no service view ever returns it (a `hasSecret` flag is derived). The membership ids are
// logical FKs (a platform operator's membership lives in the platform org). Only `organization_id` has a real FK.
import { sql } from "drizzle-orm";
import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantClearinghouseConfig = pgTable(
  "tenant_clearinghouse_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vendor: text("vendor").notNull(),
    mode: text("mode"),
    status: text("status").notNull().default("draft"),
    secretCipher: text("secret_cipher"),
    secretDekVersion: integer("secret_dek_version"),
    // Migration 1434: a keyed HMAC of the vendor and the account key (write-only, never returned or audited), unique ACROSS
    // organizations so one vendor account belongs to one tenant. NULL with no credential.
    credentialFingerprint: text("credential_fingerprint"),
    // Migration 1436: the public id of the key that fingerprint is under (null before 1436, or with no credential).
    credentialFingerprintKeyId: text("credential_fingerprint_key_id"),
    verificationKind: text("verification_kind"),
    verificationEvidence: text("verification_evidence"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOutcome: text("last_test_outcome"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedByMembershipId: uuid("activated_by_membership_id"),
    // The tenant-held vendor BAA: the tenant records it, a platform operator verifies it, and only then may the config go active.
    baaVendor: text("baa_vendor"),
    baaEffectiveDate: date("baa_effective_date"),
    baaDocumentRef: text("baa_document_ref"),
    baaRecordedAt: timestamp("baa_recorded_at", { withTimezone: true }),
    baaRecordedByMembershipId: uuid("baa_recorded_by_membership_id"),
    baaVerifiedAt: timestamp("baa_verified_at", { withTimezone: true }),
    baaVerifiedByMembershipId: uuid("baa_verified_by_membership_id"),
    // Migration 1468: a platform operator's revoke of the recorded BAA (the vendor ended it). All four or none; a revoked record holds no
    // verification, and the tenant clears it by recording a new BAA or leaving the vendor. NO free text: a closed reason code and a
    // ticket reference. Written only by the config store (the DB guard trigger needs its transaction-local setting).
    baaRevokedAt: timestamp("baa_revoked_at", { withTimezone: true }),
    baaRevokedByMembershipId: uuid("baa_revoked_by_membership_id"),
    baaRevokedReasonCode: text("baa_revoked_reason_code"),
    baaRevokedTicketRef: text("baa_revoked_ticket_ref"),
    // The history of the last revocation (survives a re-record and a vendor change; platform view only) and when the tenant left a
    // revoked vendor (the vendor / mode lock counts only attempts reserved at or after it).
    baaLastRevokedAt: timestamp("baa_last_revoked_at", { withTimezone: true }),
    baaLastRevokedDocumentRef: text("baa_last_revoked_document_ref"),
    revokedVendorLeftAt: timestamp("revoked_vendor_left_at", { withTimezone: true }),
    setByMembershipId: uuid("set_by_membership_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_clearinghouse_config_org_uq").on(t.organizationId),
    uniqueIndex("tenant_clearinghouse_config_fingerprint_uq")
      .on(t.credentialFingerprint)
      .where(sql`credential_fingerprint IS NOT NULL`),
  ],
);

export type TenantClearinghouseConfigRow = typeof tenantClearinghouseConfig.$inferSelect;
export type NewTenantClearinghouseConfigRow = typeof tenantClearinghouseConfig.$inferInsert;
