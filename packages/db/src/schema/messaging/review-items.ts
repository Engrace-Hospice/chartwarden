// M36 WP 3.8 - the lifecycle review queue (ADR-0065): one row per (trigger, open communication task). Ids and enums only
// (no free text); patient_id, item_id and trigger_ref are logical pointers (no FK). The CHECK/index names match migration
// 1103 (pinned by a test). wardenx_app has no DELETE: a decided row is final.
import { sql } from "drizzle-orm";
import {
  check,
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

export const messagingReviewItems = pgTable(
  "messaging_review_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    source: text("source").notNull(),
    cause: text("cause").notNull(),
    /** death: the patient id; discharge / transfer: the admission id; care_team_change: the assignment id. */
    triggerRef: uuid("trigger_ref").notNull(),
    patientId: uuid("patient_id").notNull(),
    /** The holder when queued (WP 3.9: the removed clinician). */
    subjectUserId: uuid("subject_user_id").notNull(),
    itemKind: text("item_kind").notNull(),
    itemId: uuid("item_id").notNull(),
    state: text("state").notNull().default("open"),
    resolution: text("resolution"),
    resolutionReason: text("resolution_reason"),
    reassignedToUserId: uuid("reassigned_to_user_id"),
    /** Null for closed_elsewhere (the closing trigger records no actor; the task event names who closed it). */
    resolvedByUserId: uuid("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("messaging_review_item_org_id_uq").on(t.organizationId, t.id),
    triggerUnique: uniqueIndex("messaging_review_item_trigger_uq").on(
      t.organizationId,
      t.source,
      t.triggerRef,
      t.itemKind,
      t.itemId,
    ),
    oneOpen: uniqueIndex("messaging_review_item_one_open")
      .on(t.organizationId, t.itemKind, t.itemId)
      .where(sql`${t.state} = 'open'`),
    byQueue: index("messaging_review_item_queue_idx").on(t.organizationId, t.state, t.createdAt),
    byItem: index("messaging_review_item_item_idx").on(t.organizationId, t.itemKind, t.itemId),
    byPatient: index("messaging_review_item_patient_idx").on(t.organizationId, t.patientId),
    bySubject: index("messaging_review_item_subject_idx").on(
      t.organizationId,
      t.subjectUserId,
      t.state,
    ),
    sourceCause: check(
      "messaging_review_item_source_cause",
      sql`(${t.source} = 'patient_lifecycle' AND ${t.cause} IN ('death', 'discharge', 'transfer')) OR (${t.source} = 'care_team_change' AND ${t.cause} = 'care_team_removed')`,
    ),
    kindShape: check("messaging_review_item_kind_shape", sql`${t.itemKind} IN ('task')`),
    stateShape: check("messaging_review_item_state_shape", sql`${t.state} IN ('open', 'resolved')`),
    resolutionShape: check(
      "messaging_review_item_resolution_shape",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('reassigned', 'closed', 'closed_elsewhere')`,
    ),
    resolvedShape: check(
      "messaging_review_item_resolved_shape",
      sql`((${t.state} = 'open') = (${t.resolvedAt} IS NULL)) AND ((${t.state} = 'open') = (${t.resolution} IS NULL))`,
    ),
    closedReason: check(
      "messaging_review_item_closed_reason",
      sql`${t.resolution} IS DISTINCT FROM 'closed' OR ${t.resolutionReason} IN ('action_taken', 'handled_elsewhere', 'no_action_needed', 'unable_to_complete', 'duplicate')`,
    ),
    reassignedTo: check(
      "messaging_review_item_reassigned_to",
      sql`(${t.resolution} = 'reassigned') = (${t.reassignedToUserId} IS NOT NULL)`,
    ),
    decidedBy: check(
      "messaging_review_item_decided_by",
      sql`${t.resolution} NOT IN ('reassigned', 'closed') OR ${t.resolvedByUserId} IS NOT NULL`,
    ),
  }),
);

export type MessagingReviewItemRow = typeof messagingReviewItems.$inferSelect;
export type NewMessagingReviewItemRow = typeof messagingReviewItems.$inferInsert;
