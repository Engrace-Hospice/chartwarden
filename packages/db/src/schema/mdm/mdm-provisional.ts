// @chartwarden/db — `mdm_provisional` (M40 MDM §3.5, §2.4.3). A tenant-proposed entity with no
// identifier match yet — staged here, ORG-SCOPED, until an admin promotes it to a canonical
// row or merges/rejects it (§2.4.3 lifecycle). Provisional is the one cross-cutting workflow
// table that IS org-scoped by design (§2.5 NOT NULL): only canonical is org-less. The
// `entity_kind` discriminator records which canonical table a promotion will target;
// `promoted_canonical_id` is a kind-switched FK app-side. Standard app.org_id RLS + the M4
// write-audit trigger land in M40-T03 (§3.6–3.7). Not a PHI table by the three-column rule —
// it carries proposed master-data fields, no patient field — so provider_entity_id /
// location_id do not apply.
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { mdmEntityKind, mdmProvisionalStatus } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";

export const mdmProvisional = pgTable(
  "mdm_provisional",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityKind: mdmEntityKind("entity_kind").notNull(),
    proposedFields: jsonb("proposed_fields").notNull(),
    resolution: mdmProvisionalStatus("resolution").notNull().default("pending"),
    promotedCanonicalId: uuid("promoted_canonical_id"), // kind-switched FK app-side
    proposedBy: uuid("proposed_by").references(() => users.id),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    orgKindIdx: index("mdm_provisional_org_kind_idx").on(t.organizationId, t.entityKind),
    resolutionIdx: index("mdm_provisional_resolution_idx").on(t.resolution),
  }),
);

export type MdmProvisional = typeof mdmProvisional.$inferSelect;
export type NewMdmProvisional = typeof mdmProvisional.$inferInsert;
