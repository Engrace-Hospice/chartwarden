// Tenant-owned Claim.MD response evidence. Source bytes are encrypted under the owning tenant DEK;
// this is intentionally separate from the platform-only unresolved response inbox (migration 1350).
import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { tenantClearinghouseConfig } from "./tenant-clearinghouse-config";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const claimMdTenantResponseAccounts = pgTable(
  "claimmd_tenant_response_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    tenantConfigId: uuid("tenant_config_id")
      .notNull()
      .references(() => tenantClearinghouseConfig.id, { onDelete: "restrict" }),
    vendor: text("vendor").$type<"claimmd">().notNull().default("claimmd"),
    usage: text("usage").$type<"test" | "production">().notNull(),
    state: text("state").$type<"verified" | "retired">().notNull(),
    verifiedByMembershipId: uuid("verified_by_membership_id").notNull(),
    verificationReference: text("verification_reference").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    coverageStartedAt: timestamp("coverage_started_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("claimmd_tenant_response_account_scope_uq").on(t.id, t.organizationId, t.usage),
    uniqueIndex("claimmd_tenant_response_account_active_uq")
      .on(t.organizationId, t.usage)
      .where(sql`${t.state} = 'verified'`),
    index("claimmd_tenant_response_account_config_ix").on(t.tenantConfigId, t.usage, t.createdAt),
  ],
);

/** Append-only, operator-confirmed credential-to-account bindings; raw keys are never stored here. */
export const claimMdTenantResponseAccountCredentials = pgTable(
  "claimmd_tenant_response_account_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accountId: uuid("account_id").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    fingerprintKeyId: text("fingerprint_key_id").notNull(),
    verifiedByMembershipId: uuid("verified_by_membership_id").notNull(),
    verificationReference: text("verification_reference").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.organizationId, t.usage],
      foreignColumns: [
        claimMdTenantResponseAccounts.id,
        claimMdTenantResponseAccounts.organizationId,
        claimMdTenantResponseAccounts.usage,
      ],
      name: "claimmd_tenant_response_account_credential_account_fk",
    }),
    unique("claimmd_tenant_response_account_credential_uq").on(
      t.accountId,
      t.credentialFingerprint,
      t.fingerprintKeyId,
    ),
    index("claimmd_tenant_response_account_credential_org_ix").on(
      t.organizationId,
      t.accountId,
      t.verifiedAt,
    ),
  ],
);

export const claimMdTenantResponseBatches = pgTable(
  "claimmd_tenant_response_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accountId: uuid("account_id").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    afterCursor: text("after_cursor").notNull(),
    nextCursor: text("next_cursor").notNull(),
    sourceFormat: text("source_format").$type<"json" | "xml">().notNull(),
    envelopeVersion: integer("envelope_version").notNull().default(1),
    keyVersion: text("key_version").notNull(),
    payloadCipher: bytea("payload_cipher").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    parentCount: integer("parent_count").notNull(),
    itemCount: integer("item_count").notNull(),
    captureId: uuid("capture_id").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.organizationId, t.usage],
      foreignColumns: [
        claimMdTenantResponseAccounts.id,
        claimMdTenantResponseAccounts.organizationId,
        claimMdTenantResponseAccounts.usage,
      ],
      name: "claimmd_tenant_response_batch_account_fk",
    }),
    unique("claimmd_tenant_response_batch_page_uq").on(
      t.accountId,
      t.usage,
      t.afterCursor,
      t.nextCursor,
    ),
    unique("claimmd_tenant_response_batch_scope_uq").on(t.id, t.organizationId, t.accountId),
    index("claimmd_tenant_response_batch_org_time_ix").on(
      t.organizationId,
      t.accountId,
      t.capturedAt,
    ),
  ],
);

export const claimMdTenantResponseItems = pgTable(
  "claimmd_tenant_response_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    accountId: uuid("account_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    responseId: text("response_id"),
    sourceCursor: text("source_cursor").notNull(),
    parentIndex: integer("parent_index").notNull(),
    messageIndex: integer("message_index").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    captureState: text("capture_state")
      .$type<"captured" | "needs_review" | "malformed">()
      .notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.batchId, t.organizationId, t.accountId],
      foreignColumns: [
        claimMdTenantResponseBatches.id,
        claimMdTenantResponseBatches.organizationId,
        claimMdTenantResponseBatches.accountId,
      ],
      name: "claimmd_tenant_response_item_batch_fk",
    }),
    uniqueIndex("claimmd_tenant_response_item_vendor_uq")
      .on(t.accountId, t.responseId)
      .where(sql`${t.responseId} IS NOT NULL`),
    unique("claimmd_tenant_response_item_fallback_uq").on(
      t.batchId,
      t.parentIndex,
      t.messageIndex,
      t.payloadDigest,
    ),
    index("claimmd_tenant_response_item_pending_ix").on(
      t.organizationId,
      t.accountId,
      t.captureState,
      t.capturedAt,
    ),
  ],
);

export type ClaimMdTenantResponseAccountRow = typeof claimMdTenantResponseAccounts.$inferSelect;
export type ClaimMdTenantResponseAccountCredentialRow =
  typeof claimMdTenantResponseAccountCredentials.$inferSelect;
export type ClaimMdTenantResponseBatchRow = typeof claimMdTenantResponseBatches.$inferSelect;
export type ClaimMdTenantResponseItemRow = typeof claimMdTenantResponseItems.$inferSelect;
