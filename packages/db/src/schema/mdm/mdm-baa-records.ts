// @wardenx/db — `mdm_baa_record` (M40 MDM §3.5, §7.7). The per-tenant BAA execution state for
// a canonical entity — ORG-SCOPED (each tenant's relationship with the entity is its own,
// §2.3 baa_execution_state). Keyed by (org, entity_kind, canonical_id); `baa_status` plus
// executed/expires dates drive the §7.7 disclosure gate (the BaaStatusProvider seam, M40-T06):
// where a BAA is required and the tenant's record is not `executed` (or has expired as-of the
// disclosure time), disclosure is denied. `document_ref` points at the M22 signed-document id.
// Standard app.org_id RLS + the M4 write-audit trigger land in M40-T03 (§3.6–3.7). Not a PHI
// table by the three-column rule — it carries only a BAA status + references, no patient field
// — so provider_entity_id / location_id do not apply.
import { sql } from "drizzle-orm";
import { date, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { mdmBaaStatus, mdmEntityKind } from "../../enums";
import { organizations } from "../organizations";

export const mdmBaaRecords = pgTable(
  "mdm_baa_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityKind: mdmEntityKind("entity_kind").notNull(),
    canonicalId: uuid("canonical_id").notNull(),
    baaStatus: mdmBaaStatus("baa_status").notNull(),
    executedOn: date("executed_on"),
    expiresOn: date("expires_on"),
    documentRef: uuid("document_ref"), // M22 doc id
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerOrgEntity: uniqueIndex("mdm_baa_unique").on(
      t.organizationId,
      t.entityKind,
      t.canonicalId,
    ),
    expiresIdx: index("mdm_baa_expires_idx")
      .on(t.expiresOn)
      .where(sql`expires_on IS NOT NULL`),
  }),
);

export type MdmBaaRecord = typeof mdmBaaRecords.$inferSelect;
export type NewMdmBaaRecord = typeof mdmBaaRecords.$inferInsert;
