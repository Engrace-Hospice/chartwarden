// @wardenx/db — `form_fill` (M22 §3.3 / §7.2 W2). One row per render request: a typed `render_payload` for a
// (template_version, aggregate) pair, driven through the queued→rendering→rendered render-worker machine, with
// `result_document_id` back-referencing the produced `document` on success. Org-scoped; the `render_payload` is
// the PHI-bearing typed payload (DENYLISTED in the §3.6 write-audit trigger) but there is no `patient_id`
// column → only org-scope RLS applies. PARTITION BY RANGE (created_at) monthly — the Drizzle shape here is
// logical (composite PK incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all land
// in the RLS migration (0049). RLS + grants + the M4 write-audit trigger land in 0049.
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { documentAggregateType, formFillStatus } from "../../enums";
import { organizations } from "../organizations";
import { formTemplateVersions } from "./form-template-versions";

export const formFills = pgTable(
  "form_fill",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with created_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    templateVersionId: uuid("template_version_id")
      .notNull()
      .references(() => formTemplateVersions.id, { onDelete: "restrict" }),
    tenantOverlayId: uuid("tenant_overlay_id"),
    aggregateType: documentAggregateType("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    renderPayload: jsonb("render_payload").notNull(), // PHI-bearing typed payload → DENYLISTED (§3.6)
    status: formFillStatus("status").notNull().default("queued"),
    resultDocumentId: uuid("result_document_id"), // populated on success
    failureReason: text("failure_reason"),
    renderAttempts: text("render_attempts").notNull().default("0"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), // partition key
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }), // partition key must be in the PK
    // Idempotency (one fill per template_version+aggregate+payload-hash) is enforced at the service layer.
    byAggregate: index("form_fill_aggregate_idx").on(
      t.organizationId,
      t.aggregateType,
      t.aggregateId,
      t.createdAt.desc(),
    ),
    byStatus: index("form_fill_status_idx")
      .on(t.status, t.createdAt.desc())
      .where(sql`status IN ('queued','rendering','failed')`),
  }),
);

export type FormFill = typeof formFills.$inferSelect;
export type NewFormFill = typeof formFills.$inferInsert;
