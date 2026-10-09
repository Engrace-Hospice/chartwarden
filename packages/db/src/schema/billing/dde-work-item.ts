import { sql } from "drizzle-orm";
// @wardenx/db — `dde_work_item` (M23 Billing-Medicare; ADR-0052; non-partitioned; retention class
// `compliance`). One piece of Medicare Direct Data Entry (FISS) work a biller must key by hand: an NOE/NOTR,
// a claim entry, an RTP correction, an adjustment, a cancel or an ADR response. HUMAN WORK TRACKING ONLY — no
// DDE credential or integration exists; `submitted` is an operator attestation.
// ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS, ENABLED + FORCEd).
//
// CROSS-MODULE FK POLICY: only `organization_id` (core) gets a real `.references(...)`. `provider_entity_id`
// (M40), `patient_id` (M5), the assignee membership (core) and the subject pointer (claim / noe_record /
// notr_record) are LOGICAL FKs — plain uuid validated at runtime. NO MBI is ever stored (ADR-0052 D7); the
// free-text `notes` are capped by a CHECK, screened for MBI-shaped text in the service, and never copied
// into an event or log.
import {
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const DDE_ITEM_TYPE_VALUES = [
  "noe",
  "notr",
  "claim_entry",
  "rtp_correction",
  "adjustment",
  "cancel",
  "adr_response",
] as const;
export type DdeItemTypeValue = (typeof DDE_ITEM_TYPE_VALUES)[number];

export const DDE_SUBJECT_KIND_VALUES = ["claim", "noe_record", "notr_record"] as const;
export type DdeSubjectKindValue = (typeof DDE_SUBJECT_KIND_VALUES)[number];

export const DDE_STATE_VALUES = [
  "queued",
  "assigned",
  "in_progress",
  "submitted",
  "accepted",
  "returned",
  "closed",
  "cancelled",
] as const;
export type DdeStateValue = (typeof DDE_STATE_VALUES)[number];

export const DDE_SOURCE_VALUES = ["manual", "watchdog"] as const;
export type DdeSourceValue = (typeof DDE_SOURCE_VALUES)[number];

export const ddeWorkItem = pgTable(
  "dde_work_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40
    patientId: uuid("patient_id").notNull(), // logical FK → M5

    itemType: text("item_type").$type<DdeItemTypeValue>().notNull(),
    subjectKind: text("subject_kind").$type<DdeSubjectKindValue>().notNull(),
    subjectId: uuid("subject_id").notNull(), // logical FK → claim / noe_record / notr_record

    state: text("state").$type<DdeStateValue>().notNull().default("queued"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    assigneeMembershipId: uuid("assignee_membership_id"), // logical FK → core membership
    priority: smallint("priority").notNull().default(2), // 1 high, 2 normal, 3 low
    source: text("source").$type<DdeSourceValue>().notNull().default("manual"),

    // The deadline: an NOE/NOTR item copies the notice's `window_target_at` (met only by a MAC acceptance date
    // on or before it, ADR-0052 D5). Other item types carry an operator-set date or none.
    deadlineAt: date("deadline_at"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    macAcceptedOn: date("mac_accepted_on"),

    // Outcome facts (codes only; never names or free text).
    dcn: text("dcn"),
    rtpReasonCode: text("rtp_reason_code"),
    outcomeCode: text("outcome_code"),
    notes: text("notes"),
    // The closed item this one re-queues (filing-window watch only); at most one respawn per closed item.
    respawnedFromId: uuid("respawned_from_id"),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one OPEN item per (subject, type): the watchdog and the manual create can never duplicate work.
    openSubjectUq: uniqueIndex("dde_work_item_open_subject_uq")
      .on(t.subjectKind, t.subjectId, t.itemType)
      .where(sql`state IN ('queued','assigned','in_progress','submitted','returned')`),
    respawnOnceUq: uniqueIndex("dde_work_item_respawn_once_uq")
      .on(t.respawnedFromId)
      .where(sql`respawned_from_id IS NOT NULL`),
    worklistIdx: index("dde_work_item_worklist_idx").on(t.organizationId, t.state, t.deadlineAt),
    assigneeIdx: index("dde_work_item_assignee_idx")
      .on(t.organizationId, t.assigneeMembershipId)
      .where(sql`assignee_membership_id IS NOT NULL`),
    subjectIdx: index("dde_work_item_subject_idx").on(
      t.organizationId,
      t.subjectKind,
      t.subjectId,
      t.itemType,
    ),
    patientIdx: index("dde_work_item_patient_idx").on(t.organizationId, t.patientId),
  }),
);

export type DdeWorkItem = typeof ddeWorkItem.$inferSelect;
export type NewDdeWorkItem = typeof ddeWorkItem.$inferInsert;
