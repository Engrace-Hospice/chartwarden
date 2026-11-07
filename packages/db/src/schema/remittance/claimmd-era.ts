// M25 Claim.MD account-wide ERA capture and no-post staging records.
import { bigint, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

/** Shared-account cursor; deliberately has no organization/provider column. */
export const claimmdEraStreams = pgTable("claimmd_era_stream", {
  id: uuid("id").primaryKey().defaultRandom(),
  vendor: text("vendor").notNull().default("claimmd"),
  accountReference: varchar("account_reference", { length: 128 }).notNull(),
  usage: text("usage").notNull(),
  streamKind: text("stream_kind").notNull().default("eras"),
  cursor: varchar("cursor", { length: 64 }).notNull(),
  generation: bigint("generation", { mode: "bigint" }).notNull().default(0n),
  leaseOwner: uuid("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  errorCode: varchar("error_code", { length: 64 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  identity: unique("claimmd_era_stream_identity_uq").on(t.vendor, t.accountReference, t.usage, t.streamKind),
  lease: index("claimmd_era_stream_lease_ix").on(t.leaseUntil),
}));

/** Account-wide encrypted ERA source inbox; only the audited claimmd_capture role has table access. */
export const claimmdEraInbox = pgTable("claimmd_era_inbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  streamId: uuid("stream_id").notNull().references(() => claimmdEraStreams.id, { onDelete: "restrict" }),
  vendor: text("vendor").notNull().default("claimmd"),
  accountReference: varchar("account_reference", { length: 128 }).notNull(),
  usage: text("usage").notNull(),
  eraId: varchar("era_id", { length: 64 }).notNull(),
  sourceMetadataCipher: text("source_metadata_cipher").notNull(),
  sourceMetadataKeyId: varchar("source_metadata_key_id", { length: 64 }).notNull(),
  sourceMetadataDigest: varchar("source_metadata_digest", { length: 64 }).notNull(),
  captureState: text("capture_state").notNull().default("discovered"),
  original835Cipher: text("original_835_cipher"),
  original835KeyId: varchar("original_835_key_id", { length: 64 }),
  original835Digest: varchar("original_835_digest", { length: 64 }),
  original835FileCount: integer("original_835_file_count"),
  structuredDetailsCipher: text("structured_details_cipher"),
  structuredDetailsKeyId: varchar("structured_details_key_id", { length: 64 }),
  structuredDetailsDigest: varchar("structured_details_digest", { length: 64 }),
  discoveryPageDigest: varchar("discovery_page_digest", { length: 64 }).notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  lastErrorCode: varchar("last_error_code", { length: 64 }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  identity: unique("claimmd_era_inbox_identity_uq").on(t.streamId, t.eraId),
  pending: index("claimmd_era_inbox_pending_ix").on(t.streamId, t.captureState, t.discoveredAt),
}));

/** Tenant-owned pointer to a verified M25 staging decision; contains no raw 835 or financial posting columns. */
export const claimmdEraM25Stage = pgTable("claimmd_era_m25_stage", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  providerEntityId: uuid("provider_entity_id").notNull(),
  locationId: uuid("location_id"),
  sourceInboxId: uuid("source_inbox_id").notNull(),
  vendor: text("vendor").notNull().default("claimmd"),
  accountReference: varchar("account_reference", { length: 128 }).notNull(),
  usage: text("usage").notNull(),
  eraId: varchar("era_id", { length: 64 }).notNull(),
  fileIndex: integer("file_index").notNull(),
  interchangeControlNumber: varchar("interchange_control_number", { length: 9 }).notNull(),
  transactionSetControlNumber: varchar("transaction_set_control_number", { length: 9 }).notNull(),
  original835Digest: varchar("original_835_digest", { length: 64 }).notNull(),
  sourceEvidence: jsonb("source_evidence").notNull(),
  state: text("state").notNull(),
  safeReasonCode: varchar("safe_reason_code", { length: 64 }),
  possibleDuplicateAdviceId: uuid("possible_duplicate_advice_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceComponent: unique("claimmd_era_m25_stage_component_uq").on(t.sourceInboxId, t.fileIndex, t.transactionSetControlNumber),
  byTenant: index("claimmd_era_m25_stage_org_ix").on(t.organizationId, t.providerEntityId, t.createdAt),
  byState: index("claimmd_era_m25_stage_state_ix").on(t.organizationId, t.state, t.createdAt),
}));
