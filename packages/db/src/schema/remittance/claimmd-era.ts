// M25 Claim.MD account-wide ERA capture and no-post staging records.
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
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
  sourceFileDigest: varchar("source_file_digest", { length: 64 }),
  resolutionId: uuid("resolution_id"),
  resolutionVersion: integer("resolution_version"),
  idempotencyKey: varchar("idempotency_key", { length: 64 }),
  sourceEvidence: jsonb("source_evidence").notNull(),
  protectedDetailsCipher: text("protected_details_cipher"),
  protectedDetailsKeyId: varchar("protected_details_key_id", { length: 64 }),
  contentDigest: varchar("content_digest", { length: 64 }),
  paymentTraceDigest: varchar("payment_trace_digest", { length: 64 }),
  state: text("state").notNull(),
  safeReasonCode: varchar("safe_reason_code", { length: 64 }),
  possibleDuplicateAdviceId: uuid("possible_duplicate_advice_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceComponent: unique("claimmd_era_m25_stage_component_uq").on(t.sourceInboxId, t.fileIndex, t.transactionSetControlNumber),
  deliveryIdentity: unique("claimmd_era_m25_stage_delivery_key_uq").on(t.idempotencyKey),
  byTenant: index("claimmd_era_m25_stage_org_ix").on(t.organizationId, t.providerEntityId, t.createdAt),
  byState: index("claimmd_era_m25_stage_state_ix").on(t.organizationId, t.state, t.createdAt),
}));

/** Central recoverable prepare/commit receipt; tenant payloads remain in the M25-owned stage table. */
export const claimmdEraDelivery = pgTable("claimmd_era_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  inboxId: uuid("inbox_id").notNull().references(() => claimmdEraInbox.id, { onDelete: "restrict" }),
  resolutionId: uuid("resolution_id").notNull().references(() => claimmdEraResolution.id, { onDelete: "restrict" }),
  resolutionVersion: integer("resolution_version").notNull(),
  vendor: text("vendor").notNull().default("claimmd"),
  accountReference: varchar("account_reference", { length: 128 }).notNull(),
  usage: text("usage").notNull(),
  eraId: varchar("era_id", { length: 64 }).notNull(),
  original835Digest: varchar("original_835_digest", { length: 64 }).notNull(),
  organizationId: uuid("organization_id").notNull(),
  providerEntityId: uuid("provider_entity_id").notNull(),
  locationId: uuid("location_id"),
  idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
  state: text("state").notNull(),
  tenantFinalized: boolean("tenant_finalized").notNull().default(false),
  stageIds: uuid("stage_ids").array().notNull().default([]),
  existingAdviceId: uuid("existing_advice_id"),
  attemptCount: integer("attempt_count").notNull().default(0),
  safeErrorCode: varchar("safe_error_code", { length: 64 }),
  preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  accountEra: unique("claimmd_era_delivery_account_era_uq").on(t.vendor, t.accountReference, t.usage, t.eraId),
  inbox: unique("claimmd_era_delivery_inbox_uq").on(t.inboxId),
  key: unique("claimmd_era_delivery_key_uq").on(t.idempotencyKey),
  pending: index("claimmd_era_delivery_pending_ix").on(t.state, t.updatedAt),
}));

export const claimmdEraDeliveryHistory = pgTable("claimmd_era_delivery_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryId: uuid("delivery_id").notNull().references(() => claimmdEraDelivery.id, { onDelete: "restrict" }),
  state: text("state").notNull(),
  safeReasonCode: varchar("safe_reason_code", { length: 64 }),
  attemptCount: integer("attempt_count").notNull(),
  stageIds: uuid("stage_ids").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byDelivery: index("claimmd_era_delivery_history_ix").on(t.deliveryId, t.createdAt) }));

/** Append-only operator/service recovery request audit; central and readable only by the audited capture role. */
export const claimmdEraRecoveryAction = pgTable("claimmd_era_recovery_action", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionId: uuid("action_id").notNull(),
  inboxId: uuid("inbox_id").notNull().references(() => claimmdEraInbox.id, { onDelete: "restrict" }),
  accountReference: varchar("account_reference", { length: 128 }).notNull(),
  usage: text("usage").notNull(),
  eraId: varchar("era_id", { length: 64 }).notNull(),
  stage: text("stage").notNull(),
  actorId: uuid("actor_id").notNull(),
  reasonCode: varchar("reason_code", { length: 64 }).notNull(),
  expectedState: varchar("expected_state", { length: 64 }).notNull(),
  resultingState: varchar("resulting_state", { length: 64 }).notNull(),
  previousRetryCount: integer("previous_retry_count").notNull(),
  newRetryEligibility: boolean("new_retry_eligibility").notNull(),
  resolutionVersion: integer("resolution_version"),
  deliveryId: uuid("delivery_id"),
  deliveryAttemptCount: integer("delivery_attempt_count"),
  outcome: varchar("outcome", { length: 32 }).notNull(),
  safeFailureCode: varchar("safe_failure_code", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ action: unique("claimmd_era_recovery_action_id_uq").on(t.actionId),
  byInbox: index("claimmd_era_recovery_action_inbox_ix").on(t.inboxId, t.createdAt) }));

/** Central protected ownership decision. Claim references and identity evidence remain encrypted. */
export const claimmdEraResolution = pgTable("claimmd_era_resolution", {
  id: uuid("id").primaryKey().defaultRandom(),
  inboxId: uuid("inbox_id").notNull().references(() => claimmdEraInbox.id, { onDelete: "restrict" }),
  vendor: text("vendor").notNull().default("claimmd"),
  accountReference: varchar("account_reference", { length: 128 }).notNull(),
  usage: text("usage").notNull(),
  original835Digest: varchar("original_835_digest", { length: 64 }).notNull(),
  status: text("status").notNull(),
  organizationId: uuid("organization_id"),
  providerEntityId: uuid("provider_entity_id"),
  locationId: uuid("location_id"),
  reasonCode: varchar("reason_code", { length: 64 }),
  algorithmVersion: varchar("algorithm_version", { length: 32 }).notNull(),
  resolutionVersion: integer("resolution_version").notNull().default(1),
  decisionCipher: text("decision_cipher").notNull(),
  decisionKeyId: varchar("decision_key_id", { length: 64 }).notNull(),
  decisionDigest: varchar("decision_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ inbox: unique("claimmd_era_resolution_inbox_uq").on(t.inboxId),
  owner: index("claimmd_era_resolution_owner_ix").on(t.organizationId, t.providerEntityId, t.createdAt) }));

/** Append-only protected history of deterministic re-evaluations; never stores original 835 bytes. */
export const claimmdEraResolutionHistory = pgTable("claimmd_era_resolution_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  resolutionId: uuid("resolution_id").notNull().references(() => claimmdEraResolution.id, { onDelete: "restrict" }),
  resolutionVersion: integer("resolution_version").notNull(),
  status: text("status").notNull(),
  organizationId: uuid("organization_id"),
  providerEntityId: uuid("provider_entity_id"),
  reasonCode: varchar("reason_code", { length: 64 }),
  algorithmVersion: varchar("algorithm_version", { length: 32 }).notNull(),
  decisionCipher: text("decision_cipher").notNull(),
  decisionKeyId: varchar("decision_key_id", { length: 64 }).notNull(),
  decisionDigest: varchar("decision_digest", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ version: unique("claimmd_era_resolution_history_version_uq").on(t.resolutionId, t.resolutionVersion) }));
