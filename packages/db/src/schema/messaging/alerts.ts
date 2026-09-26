// @wardenx/db — `alert` (M36 Secure Messaging §3.6). The org-scoped record of a dispatched
// alert: its event type, severity, fan-out `outcome`, and the field-tagged `payload`. The
// payload may carry PHI at the field level, but it NEVER leaves the perimeter unsanitized —
// the §4.7 sanitization wrapper is the only path to out-of-band channels (§7.2). The table
// itself carries no patient column, so the three-column PE/location rule does not apply. RLS
// + the M4 write-audit trigger land in M36-T03.
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { alertOutcome, alertSeverity } from "../../enums";
import { organizations } from "../organizations";

export const alerts = pgTable(
  "alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    severity: alertSeverity("severity").notNull(),
    payload: jsonb("payload").notNull(), // field-tagged; sanitizer enforces the perimeter
    correlationId: text("correlation_id").notNull(),
    // F-109 / migration 0241 — `pending` until the §2.4.3 roll-up settles it from the delivery children.
    // The previous default was `delivered`, written by nothing and corrected by nothing.
    outcome: alertOutcome("outcome").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgCreated: index("alert_org_created_idx").on(t.organizationId, t.createdAt),
    byEventType: index("alert_event_type_idx").on(t.eventType),
    uniqueCorrelation: uniqueIndex("alert_org_correlation_unique").on(
      t.organizationId,
      t.correlationId,
    ),
  }),
);

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
