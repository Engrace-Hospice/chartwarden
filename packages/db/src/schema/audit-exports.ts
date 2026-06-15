// @wardenx/db — `audit_export` (M4 Audit §3.5, §3.6). A requested compliance export of audit
// rows: scope filter + format, building toward a watermarked artifact in object storage with a
// TTL. Org-scoped on organization_id (standard app.org_id RLS lands in M4-T05); managed actions
// require Compliance permissions. Not a PHI table (scope/refs only, no PE/location columns).
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditExportFormat } from "../enums";
import { organizations } from "./organizations";
import { users } from "./users";

export const auditExports = pgTable(
  "audit_export",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "set null" }),
    scope: jsonb("scope").notNull(), // filter: patients, actors, resource kinds, event types, from/to
    format: auditExportFormat("format").notNull(),
    watermarked: boolean("watermarked").notNull().default(true),
    fileRef: uuid("file_ref"), // MinIO object id (null until job completes)
    recordCount: integer("record_count"),
    status: text("status").notNull().default("pending"), // pending|building|ready|failed
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // artifact TTL (default +7d)
  },
  (t) => ({
    orgIdx: index("audit_export_org_idx").on(t.organizationId),
    statusIdx: index("audit_export_status_idx").on(t.status),
  }),
);

export type AuditExport = typeof auditExports.$inferSelect;
export type NewAuditExport = typeof auditExports.$inferInsert;
