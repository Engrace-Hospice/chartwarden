// @wardenx/db — `hl7_message_inbound` + `hl7_message_outbound` (M29 §3.3). Every HL7 v2 wire message
// crossing an MLLP feed, stored raw (DEK-encrypted) for the §164.528 disclosure-accounting record.
//
// BOTH ARE MONTHLY PARTITIONED BY RANGE (M4 §3.6 PHI convention): inbound on `received_at`, outbound on
// `queued_at`. The composite primary key `(id, <partition_key>)` is declared in the SQL migration (0145 /
// 0146), so here `id` is Drizzle-`.primaryKey()` for clean $inferSelect types only — the real PK is
// composite. RLS + the GENERATED write-audit trigger are declared on the PARTITIONED PARENT and propagate
// to every partition (PG11+; the M32 ai_invocation / M28 fhir_client_session precedent).
//
// PARTITION-KEY DEVIATION (architecture wins over §3.2/§3.3). The spec partitions `hl7_message_outbound`
// by `transmitted_at`, but that column is NULL while a message sits `queued` — and a partition key that is
// part of the PRIMARY KEY must be NOT NULL. So the outbound partition key is `queued_at` (NOT NULL
// defaultNow, always present at insert); `transmitted_at` stays a nullable data column. `M29_PARTITIONED_TABLES`
// in @wardenx/types is updated to name `queued_at` so the one source of truth the T02 migration + the RLS
// proof iterate stays honest.
//
// §3.6 DENYLIST: `payload_cipher` / `parsed_segments_cipher` (inbound) and `payload_cipher` /
// `ack_payload_cipher` (outbound) are per-tenant DEK envelopes — denylisted from the audit value_capture;
// the audit reconstructs "what was transmitted" from the first-class `*_sha256` digest columns instead.
//
// FK POLICY (architecture §25.15): `feed_id` references the UNPARTITIONED `external_feed` — but a real FK
// FROM a partitioned child is avoided (the M28 partitioned-table precedent); `organization_id`, `feed_id`,
// `sending_facility_id`, `destination_facility_id`, `source_aggregate_id` and `matched_patient_id` are all
// LOGICAL uuids validated at the write boundary. No DB FK crosses a module or a partition edge.
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  hl7InboundMatchLevel,
  hl7InboundMatchOutcome,
  hl7InboundParseStatus,
  hl7OutboundAckStatus,
  hl7OutboundStatus,
} from "./enums";

export const hl7MessageInbound = pgTable(
  "hl7_message_inbound",
  {
    // Composite PK (id, received_at) declared in SQL (0145).
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    feedId: uuid("feed_id").notNull(),
    /** 'ADT^A01' | 'ADT^A08' | 'ORU^R01' | … */
    messageType: text("message_type").notNull(),
    /** MSH-10 — the HL7 wire dedup key. */
    messageControlId: text("message_control_id").notNull(),
    /** Per-tenant DEK envelope of the raw HL7 wire bytes — §3.6-denylisted. */
    payloadCipher: text("payload_cipher").notNull(),
    /** Digest for audit value-capture + dedup (the value the denylist substitutes). */
    payloadSha256: text("payload_sha256").notNull(),
    /** {segments:[{name:'PID',byteCount:128},…]} — segment shape only, NO PHI. */
    segmentsSummary: jsonb("segments_summary").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    parseStatus: hl7InboundParseStatus("parse_status").notNull().default("in_progress"),
    parseError: jsonb("parse_error"),
    /** M40 Facility, app-side resolution of MSH-4. */
    sendingFacilityId: uuid("sending_facility_id"),
    sendingFacilityRawId: text("sending_facility_raw_id").notNull(),
    /** hash(sending_facility_id, message_control_id) — the M1 idempotency-middleware key. */
    idempotencyKey: text("idempotency_key").notNull(),
    // ── Cascade result (populated by the T-29.05 parse worker; null until then) ──
    matchedPatientId: uuid("matched_patient_id"),
    matchLevel: hl7InboundMatchLevel("match_level"),
    matchOutcome: hl7InboundMatchOutcome("match_outcome"),
    matchConfidence: numeric("match_confidence", { precision: 4, scale: 3 }),
    cascadeRunMs: integer("cascade_run_ms"),
    // ── Parsed-segment tree (populated by the T-29.06 parse worker; null until then) ──
    parsedSegmentsCipher: text("parsed_segments_cipher"),
    parsedSegmentsSha256: text("parsed_segments_sha256"),
  },
  (t) => ({
    orgFeedIdx: index("idx_hmi_org_feed").on(t.organizationId, t.feedId, t.receivedAt),
    statusIdx: index("idx_hmi_parse_status").on(t.parseStatus),
    idempotencyIdx: index("idx_hmi_idempotency").on(t.idempotencyKey),
    shaIdx: index("idx_hmi_sha256").on(t.payloadSha256),
  }),
);

export const hl7MessageOutbound = pgTable(
  "hl7_message_outbound",
  {
    // Composite PK (id, queued_at) declared in SQL (0146).
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    feedId: uuid("feed_id").notNull(),
    messageType: text("message_type").notNull(),
    messageControlId: text("message_control_id").notNull(),
    payloadCipher: text("payload_cipher").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    segmentsSummary: jsonb("segments_summary").notNull(),
    /** 'm11.order_record' | … — the aggregate the ORM originates from (Phase 1: M11 orders). */
    sourceAggregateKind: text("source_aggregate_kind").notNull(),
    sourceAggregateId: uuid("source_aggregate_id").notNull(),
    destinationFacilityId: uuid("destination_facility_id"),
    /** When the row was queued — the PARTITION KEY (always present; `transmitted_at` is null while queued). */
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    transmittedAt: timestamp("transmitted_at", { withTimezone: true }),
    ackStatus: hl7OutboundAckStatus("ack_status"),
    ackReceivedAt: timestamp("ack_received_at", { withTimezone: true }),
    ackPayloadCipher: text("ack_payload_cipher"),
    /** §3.6 — the ack payload's digest, materialized at write time so the denylisted cipher is auditable. */
    ackPayloadSha256: text("ack_payload_sha256"),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    status: hl7OutboundStatus("status").notNull().default("queued"),
    /** hash(feed_id, source_aggregate_kind, source_aggregate_id) — the §2.6 dispatch dedup key. */
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (t) => ({
    orgFeedIdx: index("idx_hmo_org_feed").on(t.organizationId, t.feedId),
    statusIdx: index("idx_hmo_status").on(t.status),
    idempotencyIdx: index("idx_hmo_idempotency").on(t.idempotencyKey),
    nextRetryIdx: index("idx_hmo_next_retry").on(t.status, t.nextRetryAt),
    /** F-185 (0265) — serves F-183's order-level dispatch dedupe (`ormDispatchExistsForOrder`): equality on all three. */
    orgSourceAggregateIdx: index("idx_hmo_org_source_aggregate").on(
      t.organizationId,
      t.sourceAggregateKind,
      t.sourceAggregateId,
    ),
  }),
);

export type Hl7MessageInboundRow = typeof hl7MessageInbound.$inferSelect;
export type NewHl7MessageInboundRow = typeof hl7MessageInbound.$inferInsert;
export type Hl7MessageOutboundRow = typeof hl7MessageOutbound.$inferSelect;
export type NewHl7MessageOutboundRow = typeof hl7MessageOutbound.$inferInsert;
