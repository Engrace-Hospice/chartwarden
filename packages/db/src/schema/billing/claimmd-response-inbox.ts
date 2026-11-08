import { sql } from "drizzle-orm";
// M23 integration infrastructure: account-wide Claim.MD responses. No organization_id exists until
// BIL-1.2 resolves identity; only the claimmd_capture database role may read/write these rows.
import {
  bigint,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const claimmdResponseStreams = pgTable(
  "claimmd_response_stream",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    streamType: text("stream_type").notNull().default("claim_responses"),
    cursor: text("cursor").notNull(),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    generation: bigint("generation", { mode: "bigint" }).notNull().default(0n),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("claimmd_response_stream_identity_uq").on(t.accountReference, t.usage, t.streamType),
  ],
);

export const claimmdResponseBatches = pgTable(
  "claimmd_response_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamId: uuid("stream_id")
      .notNull()
      .references(() => claimmdResponseStreams.id, { onDelete: "restrict" }),
    afterCursor: text("after_cursor").notNull(),
    nextCursor: text("next_cursor").notNull(),
    payloadCipher: bytea("payload_cipher").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    parentCount: integer("parent_count").notNull(),
    eventCount: integer("event_count").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("claimmd_response_batch_stream_ix").on(t.streamId, t.capturedAt)],
);

export const claimmdResponseEvents = pgTable(
  "claimmd_response_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamId: uuid("stream_id")
      .notNull()
      .references(() => claimmdResponseStreams.id, { onDelete: "restrict" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => claimmdResponseBatches.id, { onDelete: "restrict" }),
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
    uniqueIndex("claimmd_response_event_vendor_uq")
      .on(t.streamId, t.responseId)
      .where(sql`${t.responseId} IS NOT NULL`),
    unique("claimmd_response_event_fallback_uq").on(
      t.streamId,
      t.sourceCursor,
      t.parentIndex,
      t.messageIndex,
      t.payloadDigest,
    ),
    index("claimmd_response_event_review_ix").on(t.streamId, t.captureState, t.capturedAt),
  ],
);
