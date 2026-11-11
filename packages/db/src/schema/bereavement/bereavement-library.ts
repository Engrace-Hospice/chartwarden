// @chartwarden/db — the M16 GRIEF LIBRARY (ADR-0109 D10, blueprint PR 3, migration 1393): `bereavement_library_item`, M16's metadata over an M22
// document of aggregate type `bereavement_library_item` (migration 1392). ORG-LEVEL agency content (no person named). `document_id` and
// `transcript_document_id` are LOGICAL uuids to M22 (checked through the M22 seam at registration). Only `published` items reach the portal.
import { sql } from "drizzle-orm";
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
import { organizations } from "../organizations";

export const BEREAVEMENT_LIBRARY_CATEGORIES = [
  "understanding_grief",
  "coping",
  "children_and_teens",
  "holidays_and_anniversaries",
  "practical_matters",
  "other",
] as const;
export const BEREAVEMENT_LIBRARY_KINDS = ["pdf", "video", "other"] as const;
export const BEREAVEMENT_LIBRARY_STATUSES = ["draft", "published", "archived"] as const;

export const bereavementLibraryItem = pgTable(
  "bereavement_library_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    summary: text("summary"), // agency prose; audit-scrubbed
    category: text("category", { enum: BEREAVEMENT_LIBRARY_CATEGORIES }).notNull(),
    kind: text("kind", { enum: BEREAVEMENT_LIBRARY_KINDS }).notNull(),
    documentId: uuid("document_id").notNull(), // logical → M22 document
    mimeType: text("mime_type").notNull(),
    transcriptDocumentId: uuid("transcript_document_id"), // logical → M22 document (a PDF)
    status: text("status", { enum: BEREAVEMENT_LIBRARY_STATUSES }).notNull().default("draft"),
    sortOrder: integer("sort_order").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgDocumentUniq: uniqueIndex("berv_library_org_document_uniq").on(
      t.organizationId,
      t.documentId,
    ),
    orgStatusIdx: index("berv_library_org_status_idx").on(
      t.organizationId,
      t.status,
      t.sortOrder,
      t.title,
    ),
    statusValues: check("berv_library_status_chk", sql`status IN ('draft','published','archived')`),
  }),
);

export type BereavementLibraryItemRow = typeof bereavementLibraryItem.$inferSelect;
