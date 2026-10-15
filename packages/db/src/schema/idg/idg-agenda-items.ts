import { sql } from "drizzle-orm";
// @wardenx/db — `idg_agenda_item` (M14 §3.3.1 / §2.7). One ordered agenda row per meeting: a patient-review
// slot, a carried-forward overdue action item, or an administrative note. PHI-bearing when patient-scoped
// (`patient_id`) → the three-column tenancy rule (provider_entity_id + location_id), nullable here because
// administrative items are meeting/org-level (no patient), denormalized from the admission only for patient
// slots. FK to the meeting (cascade) + the tenancy spine; cross-module (M5 patient) and self/forward refs
// (carried_from_action_item_id) and actor refs (added_by_membership_id → M1 membership) are plain uuid
// app-validated, NOT cross-module FKs. `body_text` is free-text → denylisted in the M4 write-audit trigger
// (§3.3). RLS + grants + trigger land in the RLS migration (M14-T02).
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { idgAgendaItemKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { idgMeeting } from "./idg-meetings";

export const idgAgendaItem = pgTable(
  "idg_agenda_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Three-column rule — nullable: present (denormalized from the admission) for patient-review slots,
    // null for administrative/org-level items (which also carry no patient_id).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id")
      .notNull()
      .references(() => idgMeeting.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id"), // M5 patient (app-validated; no cross-module FK) — null for admin items
    sortOrder: integer("sort_order").notNull().default(0),
    title: text("title").notNull(),
    bodyText: text("body_text"), // DENYLISTED
    kind: idgAgendaItemKind("kind").notNull(),
    carriedFromActionItemId: uuid("carried_from_action_item_id"), // forward ref (app-validated; no FK)
    addedByMembershipId: uuid("added_by_membership_id").notNull(), // M1 membership (no cross-module FK)
    version: integer("version").notNull().default(0),
    // WP 3.7 (migration 1102): attribution when the item was added from a secure message proposed for the chart. A pointer
    // only (no message text is ever copied here); all-or-none, immutable, and an insert guard proves it equals the proposal.
    promotionRequestId: uuid("promotion_request_id"),
    sourceMessageId: uuid("source_message_id"),
    sourceAuthorUserId: uuid("source_author_user_id"),
    sourceSentAt: timestamp("source_sent_at", { withTimezone: true }),
    sourceBodySha256: text("source_body_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMeeting: index("idg_agenda_item_meeting_idx").on(
      t.organizationId,
      t.idgMeetingId,
      t.sortOrder,
    ),
    // 0285 — the carry-forward cron's idempotency key: ONE carry_forward row per (action item, meeting).
    carryForwardOnce: uniqueIndex("idg_agenda_item_carry_forward_uq")
      .on(t.organizationId, t.idgMeetingId, t.carriedFromActionItemId)
      .where(sql`${t.kind} = 'carry_forward' AND ${t.carriedFromActionItemId} IS NOT NULL`),
    promotionOnce: uniqueIndex("idg_agenda_item_promotion_uq")
      .on(t.organizationId, t.promotionRequestId)
      .where(sql`${t.promotionRequestId} IS NOT NULL`),
    promotionShape: check(
      "idg_agenda_item_promotion_shape",
      sql`(${t.promotionRequestId} IS NULL) = (${t.sourceMessageId} IS NULL) AND (${t.promotionRequestId} IS NULL) = (${t.sourceAuthorUserId} IS NULL) AND (${t.promotionRequestId} IS NULL) = (${t.sourceSentAt} IS NULL) AND (${t.promotionRequestId} IS NULL) = (${t.sourceBodySha256} IS NULL)`,
    ),
    promotionShaShape: check(
      "idg_agenda_item_promotion_sha_shape",
      sql`${t.sourceBodySha256} IS NULL OR ${t.sourceBodySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    promotionPatient: check(
      "idg_agenda_item_promotion_patient",
      sql`${t.promotionRequestId} IS NULL OR ${t.patientId} IS NOT NULL`,
    ),
  }),
);

export type IdgAgendaItem = typeof idgAgendaItem.$inferSelect;
export type NewIdgAgendaItem = typeof idgAgendaItem.$inferInsert;
