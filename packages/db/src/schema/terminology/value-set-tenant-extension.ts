// @wardenx/db — `value_set_tenant_extension` (M38 Terminology §3.5). The ONLY tenant-scoped
// table in M38: a tenant's add-only extension to a platform value set (§7.6 — extensions
// add, never weaken; canonical members are immutable to tenants per §7.4). It carries
// `organization_id`, lives under `app.org_id` RLS (M38-T03, §3.7), and gets a write-audit
// trigger (M38-T03, §3.8). `removed_at` is the soft-delete marker (the active-row partial
// unique index keys on removed_at IS NULL). It is NOT PHI (carries only a code reference,
// no patient data), so the three-column rule's provider_entity_id/location_id do not apply.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { codeSystemId } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { valueSets } from "./value-sets";

export const valueSetTenantExtension = pgTable(
  "value_set_tenant_extension",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    valueSetId: text("value_set_id")
      .notNull()
      .references(() => valueSets.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    systemId: codeSystemId("system_id").notNull(),
    code: text("code").notNull(),
    reason: text("reason").notNull(),
    addedBy: uuid("added_by").references(() => users.id),
    removedAt: timestamp("removed_at", { withTimezone: true }), // soft delete
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeUnique: uniqueIndex("vs_tenant_ext_active_unique")
      .on(t.valueSetId, t.organizationId, t.systemId, t.code)
      .where(sql`removed_at IS NULL`),
    orgIdx: index("vs_tenant_ext_org_idx").on(t.organizationId),
    valueSetIdx: index("vs_tenant_ext_value_set_idx").on(t.valueSetId),
  }),
);

export type ValueSetTenantExtension = typeof valueSetTenantExtension.$inferSelect;
export type NewValueSetTenantExtension = typeof valueSetTenantExtension.$inferInsert;
