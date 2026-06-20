// @wardenx/db — `mdm_baa_required` (M40 MDM §3.5, D8). The per-tenant "is a BAA required for
// this entity kind?" config — ORG-SCOPED, keyed by (org, entity_kind). Seeded with HIPAA
// defaults; Compliance tunes it per tenant. The §7.7 disclosure gate consults this together
// with `mdm_baa_record`: a missing/expired BAA only blocks disclosure where this row says one
// is required. Standard app.org_id RLS + the M4 write-audit trigger land in M40-T03 (§3.6–3.7).
// Not a PHI table by the three-column rule — it carries only a boolean policy flag, no patient
// field — so provider_entity_id / location_id do not apply.
import { boolean, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { mdmEntityKind } from "../../enums";
import { organizations } from "../organizations";

export const mdmBaaRequired = pgTable(
  "mdm_baa_required",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: mdmEntityKind("kind").notNull(),
    required: boolean("required").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerOrgKind: uniqueIndex("mdm_baa_required_unique").on(t.organizationId, t.kind),
  }),
);

export type MdmBaaRequired = typeof mdmBaaRequired.$inferSelect;
export type NewMdmBaaRequired = typeof mdmBaaRequired.$inferInsert;
