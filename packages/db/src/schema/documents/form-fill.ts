// @wardenx/db — `form_fill` (M22 §3.3 / §2.2.4). The render-instance ledger: one row per render
// request (queued→rendering→rendered→delivered | failed), keyed to a template version + overlay +
// owning-module aggregate. Org-scoped; the typed `render_payload` is PHI-bearing → DENYLISTED in
// the audit trigger (§3.6). `template_version_id` carries a SQL FK to `form_template_version`;
// `tenant_overlay_id` / `result_document_id` / `aggregate_id` are plain uuid app-validated.
//
// PARTITION BY RANGE (created_at) monthly: the Drizzle definition here is the LOGICAL shape
// (composite PK incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all
// land in 0049, which drops the plain table 0048 emits and re-creates it partitioned (M18 precedent).
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { documentAggregateType, formFillStatus } from "../../enums";
import { formTemplateVersions } from "./form-template-version";

export const formFills = pgTable(
  "form_fill",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with created_at (the partition key)
    organizationId: uuid("organization_id").notNull(),
    templateVersionId: uuid("template_version_id")
      .notNull()
      .references(() => formTemplateVersions.id),
    tenantOverlayId: uuid("tenant_overlay_id"),
    aggregateType: documentAggregateType("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    renderPayload: jsonb("render_payload").notNull(), // DENYLISTED (§3.6) — PHI-bearing typed payload
    status: formFillStatus("status").notNull().default("queued"),
    resultDocumentId: uuid("result_document_id"), // populated on success
    failureReason: text("failure_reason"),
    renderAttempts: text("render_attempts").notNull().default("0"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }), // partition key must be in the PK
    // Idempotency is enforced at the service layer via a Sha256 dedup key over
    // (templateVersionId, aggregateType, aggregateId, payload-hash).
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
