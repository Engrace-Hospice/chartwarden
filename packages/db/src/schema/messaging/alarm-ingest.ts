// M36 WP 6.10 (ADR-0101) - alarm ingest, watch only (migration 1250): a sender credential (the HMAC secret sealed under the tenant ring DEK), its
// alarm-kind -> catalog-alert-type mappings with a severity ceiling, and one idempotency row per accepted event. Ids, enums, a body digest and
// counts only: no free text. Names match the migration (pinned by a test); timestamps and the guard transitions are set by database triggers.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const alarmSources = pgTable(
  "alarm_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    secretCipher: bytea("secret_cipher").notNull(),
    secretGeneration: integer("secret_generation").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotatedBy: uuid("rotated_by"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by"),
  },
  (t) => ({
    orgIdUnique: unique("alarm_source_org_id_uq").on(t.organizationId, t.id),
    byOrg: index("alarm_source_org_idx").on(t.organizationId, t.createdAt),
    nameLen: check("alarm_source_name_len", sql`char_length(btrim(${t.name})) BETWEEN 1 AND 120`),
    generation: check("alarm_source_generation", sql`${t.secretGeneration} >= 1`),
    disabledShape: check(
      "alarm_source_disabled_shape",
      sql`(${t.enabled} = (${t.disabledAt} IS NULL)) AND (${t.enabled} OR ${t.disabledBy} IS NOT NULL)`,
    ),
  }),
);

export const alarmSourceMappings = pgTable(
  "alarm_source_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id").notNull(),
    alarmKind: text("alarm_kind").notNull(),
    alertType: text("alert_type").notNull(),
    severityCeiling: text("severity_ceiling").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceFk: foreignKey({
      name: "alarm_source_mapping_source_fk",
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [alarmSources.organizationId, alarmSources.id],
    }).onDelete("cascade"),
    onePerKind: uniqueIndex("alarm_source_mapping_one_per_kind").on(
      t.organizationId,
      t.sourceId,
      t.alarmKind,
    ),
    kind: check("alarm_source_mapping_kind", sql`${t.alarmKind} ~ '^[a-z0-9_]{1,40}$'`),
    alertType: check(
      "alarm_source_mapping_alert_type",
      sql`${t.alertType} IN ('alarm_ingest.nurse_call', 'alarm_ingest.patient_sensor', 'alarm_ingest.equipment')`,
    ),
    ceiling: check("alarm_source_mapping_ceiling", sql`${t.severityCeiling} IN ('info', 'warn')`),
  }),
);

export const alarmIngestEvents = pgTable(
  "alarm_ingest_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id").notNull(),
    eventId: text("event_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    alarmKind: text("alarm_kind").notNull(),
    alertType: text("alert_type"),
    requestedSeverity: text("requested_severity"),
    effectiveSeverity: text("effective_severity"),
    status: text("status").notNull().default("received"),
    alertId: uuid("alert_id"),
    recipientCount: integer("recipient_count"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceFk: foreignKey({
      name: "alarm_ingest_event_source_fk",
      columns: [t.organizationId, t.sourceId],
      foreignColumns: [alarmSources.organizationId, alarmSources.id],
    }).onDelete("cascade"),
    onePerId: uniqueIndex("alarm_ingest_event_one_per_id").on(
      t.organizationId,
      t.sourceId,
      t.eventId,
    ),
    recent: index("alarm_ingest_event_recent_idx").on(t.organizationId, t.sourceId, t.createdAt),
    eventId: check("alarm_ingest_event_event_id", sql`${t.eventId} ~ '^[A-Za-z0-9._:-]{1,64}$'`),
    digest: check("alarm_ingest_event_digest", sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    kind: check("alarm_ingest_event_kind", sql`${t.alarmKind} ~ '^[a-z0-9_]{1,40}$'`),
    status: check(
      "alarm_ingest_event_status",
      sql`${t.status} IN ('received', 'alerted', 'no_recipients', 'unmapped')`,
    ),
    requestedSeverity: check(
      "alarm_ingest_event_requested_severity",
      sql`${t.requestedSeverity} IS NULL OR ${t.requestedSeverity} IN ('info', 'warn', 'critical')`,
    ),
    effectiveSeverity: check(
      "alarm_ingest_event_effective_severity",
      sql`${t.effectiveSeverity} IS NULL OR ${t.effectiveSeverity} IN ('info', 'warn')`,
    ),
    unmappedShape: check(
      "alarm_ingest_event_unmapped_shape",
      sql`(${t.status} = 'unmapped') = (${t.alertType} IS NULL AND ${t.effectiveSeverity} IS NULL)`,
    ),
    alertType: check(
      "alarm_ingest_event_alert_type",
      sql`${t.alertType} IS NULL OR ${t.alertType} IN ('alarm_ingest.nurse_call', 'alarm_ingest.patient_sensor', 'alarm_ingest.equipment')`,
    ),
    settledShape: check(
      "alarm_ingest_event_settled_shape",
      sql`(${t.status} IN ('alerted', 'no_recipients')) = (${t.recipientCount} IS NOT NULL)`,
    ),
    recipients: check(
      "alarm_ingest_event_recipients",
      sql`${t.recipientCount} IS NULL OR ${t.recipientCount} >= 0`,
    ),
  }),
);
