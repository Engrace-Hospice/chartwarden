// @wardenx/db — `audit_denylist_catalog` (M4 Audit §3.5, §5.1). Platform-shared registry of
// high-sensitivity columns each module declares: the write-audit trigger generator (M4-T02)
// resolves a table's `denylistCategories` against this catalog to know which column values to
// scrub to a change-marker. `conditional_check` carries the row-conditional expression for the
// `sud_value` category (§5.2). NON_ORG_SCOPED platform reference, read-all (writes via M4
// boot/migration under the platform role; check-tenancy allowlist).
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { phiDenylistCategory } from "../enums";

export const auditDenylistCatalog = pgTable("audit_denylist_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  tableName: text("table_name").notNull(),
  columnName: text("column_name").notNull(),
  category: phiDenylistCategory("category").notNull(),
  conditionalCheck: text("conditional_check"),
  registeredByModule: text("registered_by_module").notNull(),
  declaredAt: timestamp("declared_at").notNull().defaultNow(),
});

export type AuditDenylistEntry = typeof auditDenylistCatalog.$inferSelect;
export type NewAuditDenylistEntry = typeof auditDenylistCatalog.$inferInsert;
