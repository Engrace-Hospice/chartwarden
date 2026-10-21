// @chartwarden/db — `audit_event` (M1 Foundation §3.9). The append-only audit log,
// RANGE partitioned on created_at (monthly). HELPER-ONLY: written exclusively via
// packages/audit (audit()/auditRead()) under the wardenx_audit_writer role — never
// a direct insert/select from a feature module (HELPER_ONLY_TABLES, manifest).
// organization_id is nullable so platform/system events can be recorded; tenant
// reads are scoped by RLS on app.org_id (added with the initial migration, M1-T04).
// Drizzle does not emit partition DDL — `id` is therefore not a PK and there is no
// unique index here; the partitions + indexes are created in the M1-T04 migration.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditActorKind, auditOutcome, auditRetentionClass, auditSeverity } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const auditEvents = pgTable(
  "audit_event",
  {
    id: uuid("id").notNull().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorKind: auditActorKind("actor_kind").notNull(),
    actorRole: text("actor_role"),
    eventType: text("event_type").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id"),
    correlationId: text("correlation_id").notNull(),
    requestId: text("request_id"),
    traceId: text("trace_id"),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    outcome: auditOutcome("outcome").notNull(),
    severity: auditSeverity("severity").notNull().default("info"),
    before: jsonb("before"),
    after: jsonb("after"),
    context: jsonb("context").notNull().default({}),
    retentionClass: auditRetentionClass("retention_class").notNull().default("compliance"),
  },
  (t) => ({
    orgCreatedIdx: index("audit_event_org_created_idx").on(t.organizationId, t.createdAt),
    eventTypeCreatedIdx: index("audit_event_event_type_created_idx").on(t.eventType, t.createdAt),
    actorUserCreatedIdx: index("audit_event_actor_user_created_idx").on(t.actorUserId, t.createdAt),
    resourceIdx: index("audit_event_resource_idx").on(t.resourceKind, t.resourceId),
    correlationIdx: index("audit_event_correlation_idx").on(t.correlationId),
  }),
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
