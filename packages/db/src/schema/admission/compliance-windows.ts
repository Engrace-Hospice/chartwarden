// @wardenx/db — `compliance_window` (M6 §3.3). The open-obligation ledger over an admission (CTI due,
// F2F due, NOR due, external-signal windows opened by the AdmissionEventApplier). Org-scoped (no
// direct patient identifier; tenancy via the admission FK). `severity` / `auto_acknowledge` /
// `payload` back the external-signal windows (D15); pre-v0.3 kinds default to `warning`. `closed_by`
// is an M1 user (FK); the admission FK is intra-M6. One open window per (admission, kind) (partial
// unique). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  complianceWindowKind,
  complianceWindowSeverity,
  complianceWindowStatus,
} from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { admissions } from "./admissions";

export const complianceWindows = pgTable(
  "compliance_window",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    windowKind: complianceWindowKind("window_kind").notNull(),
    severity: complianceWindowSeverity("severity").notNull().default("warning"),
    autoAcknowledge: boolean("auto_acknowledge").notNull().default(false),
    payload: jsonb("payload"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    mustCompleteBy: timestamp("must_complete_by", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    overrideReason: text("override_reason"),
    status: complianceWindowStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    admKindOpenUnique: uniqueIndex("cw_adm_kind_open_idx")
      .on(t.admissionId, t.windowKind)
      .where(sql`status <> 'closed'`),
    orgDueIdx: index("cw_org_due_idx")
      .on(t.organizationId, t.status, t.mustCompleteBy)
      .where(sql`status <> 'closed'`),
    admKindIdx: index("cw_adm_kind_idx").on(t.admissionId, t.windowKind),
  }),
);

export type ComplianceWindow = typeof complianceWindows.$inferSelect;
export type NewComplianceWindow = typeof complianceWindows.$inferInsert;
