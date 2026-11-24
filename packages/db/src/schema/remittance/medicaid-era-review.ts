import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claimmdEraM25Stage } from "./claimmd-era";

/** Tenant-owned, nonposting assessment. The only supported artifact source in L6B is Claim.MD raw X12. */
export const medicaidEraReview = pgTable(
  "medicaid_era_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => claimmdEraM25Stage.id, { onDelete: "restrict" }),
    vendor: varchar("vendor", { length: 16 }).notNull(),
    accountReference: varchar("account_reference", { length: 128 }).notNull(),
    sourceEnvironment: varchar("source_environment", { length: 16 }).notNull(),
    canonicalPayerId: uuid("canonical_payer_id").notNull(),
    programId: varchar("program_id", { length: 80 }).notNull(),
    sourceDigest: varchar("source_digest", { length: 64 }).notNull(),
    assessmentFingerprint: varchar("assessment_fingerprint", { length: 64 }).notNull(),
    /** Hash of the complete server-owned evaluator snapshot; this is provenance, not a signature/current authorization. */
    assessmentEvidenceFingerprint: varchar("assessment_evidence_fingerprint", { length: 64 }),
    assessmentObservedAt: timestamp("assessment_observed_at", { withTimezone: true }),
    assessmentVersion: varchar("assessment_version", { length: 32 }).notNull(),
    assessmentTrustStatus: varchar("assessment_trust_status", { length: 24 })
      .notNull()
      .default("legacy_unverified"),
    decisionStatus: varchar("decision_status", { length: 32 }).notNull(),
    reasonCodes: jsonb("reason_codes").notNull().$type<string[]>(),
    claimMatchStatus: varchar("claim_match_status", { length: 32 }).notNull(),
    duplicateStatus: varchar("duplicate_status", { length: 16 }).notNull(),
    safeSummary: jsonb("safe_summary").notNull().$type<Record<string, unknown>>(),
    workflowState: varchar("workflow_state", { length: 32 }).notNull().default("needs_review"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identity: unique("medicaid_era_review_stage_digest_uq").on(
      t.organizationId,
      t.providerEntityId,
      t.stageId,
      t.sourceDigest,
    ),
    fingerprint: check(
      "medicaid_era_review_assessment_fingerprint_ck",
      sql`assessment_fingerprint ~ '^[0-9a-f]{64}$'`,
    ),
    evidenceFingerprint: check(
      "medicaid_era_review_evidence_fingerprint_ck",
      sql`(assessment_evidence_fingerprint IS NULL AND assessment_observed_at IS NULL)
          OR (assessment_evidence_fingerprint IS NOT NULL
              AND assessment_evidence_fingerprint ~ '^[0-9a-f]{64}$'
              AND assessment_observed_at IS NOT NULL)`,
    ),
    decisionStatus: check(
      "medicaid_era_review_decision_status_ck",
      sql`decision_status IN ('review_required', 'payment_reported')`,
    ),
    worklist: index("medicaid_era_review_worklist_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.workflowState,
      t.createdAt,
    ),
  }),
);

/** Append-only operator and assessment history; no posting action is representable. */
export const medicaidEraReviewHistory = pgTable(
  "medicaid_era_review_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => medicaidEraReview.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    action: varchar("action", { length: 32 }).notNull(),
    reasonCode: varchar("reason_code", { length: 64 }),
    note: varchar("note", { length: 1000 }),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }),
    trustStatus: varchar("trust_status", { length: 24 }).notNull().default("legacy_unverified"),
    operationFingerprint: varchar("operation_fingerprint", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    version: unique("medicaid_era_review_history_version_uq").on(t.reviewId, t.version),
    idempotency: unique("medicaid_era_review_history_idempotency_uq").on(
      t.organizationId,
      t.idempotencyKeyHash,
    ),
    read: index("medicaid_era_review_history_read_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.reviewId,
      t.version,
    ),
  }),
);

/** Durable request-key reservations; unlike review history, an identical no-op assessment needs no event. */
export const medicaidEraReviewIdempotency = pgTable(
  "medicaid_era_review_idempotency",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => medicaidEraReview.id, { onDelete: "restrict" }),
    idempotencyKeyHash: varchar("idempotency_key_hash", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 16 }).notNull(),
    operationFingerprint: varchar("operation_fingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    key: primaryKey({
      name: "medicaid_era_review_idempotency_pkey",
      columns: [t.organizationId, t.idempotencyKeyHash],
    }),
    keyHash: check(
      "medicaid_era_review_idempotency_key_hash_ck",
      sql`idempotency_key_hash ~ '^[0-9a-f]{64}$'`,
    ),
    operation: check(
      "medicaid_era_review_idempotency_operation_ck",
      sql`operation IN ('evaluate','note','transition')`,
    ),
    fingerprint: check(
      "medicaid_era_review_idempotency_fingerprint_ck",
      sql`operation_fingerprint ~ '^[0-9a-f]{64}$'`,
    ),
    review: index("medicaid_era_review_idempotency_review_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.reviewId,
    ),
  }),
);
