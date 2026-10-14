// M36 WP 3.2 - clinical links: a message's pointer to a record owned by another module. Ids only; the record's title,
// status and detail are read through the owning module's seam at open time and are never stored here.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { messages } from "./messages";

export const clinicalLinks = pgTable(
  "clinical_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    linkKind: text("link_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    /** The patient the source belongs to; null only for an IDG meeting. */
    patientId: uuid("patient_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySource: index("clinical_link_source_idx").on(t.organizationId, t.linkKind, t.sourceId),
    uniqueTarget: unique("clinical_link_unique_target").on(
      t.organizationId,
      t.messageId,
      t.linkKind,
      t.sourceId,
    ),
    messageOrgFk: foreignKey({
      name: "clinical_link_message_org_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    kindShape: check(
      "clinical_link_kind_shape",
      sql`${t.linkKind} IN ('medication', 'order', 'care_plan', 'assessment', 'visit', 'document', 'idg_meeting')`,
    ),
  }),
);

export type ClinicalLinkRow = typeof clinicalLinks.$inferSelect;
export type NewClinicalLinkRow = typeof clinicalLinks.$inferInsert;
