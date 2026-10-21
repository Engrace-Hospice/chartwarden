// @chartwarden/db — `entity_relationship` (M40 MDM §3.5). The canonical real-world hierarchy
// between two MDM entities of the same kind — facility→parent chain, plan→payer, etc. The
// `entity_kind` discriminator fixes which canonical table `src_id`/`dst_id` reference (the
// FK is enforced application-side, kind-switched, since a polymorphic FK cannot point at one
// of several tables). Canonical structure → org-less (NON_ORG_SCOPED allowlist): it reflects
// the real world, the same for every tenant (§2.3 hierarchy_parent). RLS/audit triggers land
// in M40-T03 (§3.6). Not PHI.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { mdmEntityKind } from "../../enums";

export const entityRelationships = pgTable(
  "entity_relationship",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityKind: mdmEntityKind("entity_kind").notNull(), // 'physician'|'facility'|'payer'|'pharmacy'
    srcId: uuid("src_id").notNull(), // FK enforced application-side (kind-switched)
    dstId: uuid("dst_id").notNull(),
    relationship: text("relationship").notNull(), // 'parent'|'chain'|'plan_under_payer'|...
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    srcIdx: index("entity_relationship_src_idx").on(t.entityKind, t.srcId),
    dstIdx: index("entity_relationship_dst_idx").on(t.entityKind, t.dstId),
    notSelf: check("entity_relationship_not_self", sql`src_id <> dst_id`),
  }),
);

export type EntityRelationship = typeof entityRelationships.$inferSelect;
export type NewEntityRelationship = typeof entityRelationships.$inferInsert;
