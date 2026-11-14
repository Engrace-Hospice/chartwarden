// M23-CM-4A: immutable, non-PHI identity for an internally rendered notice attempt. The X12 payload
// is never stored here; MBI and other beneficiary data remain transient in the renderer.
import { pgTable, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const medicareNoticeRenderIdentity = pgTable(
  "medicare_notice_render_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    noticeId: uuid("notice_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    noticeKind: text("notice_kind").$type<"noe" | "notr" | "transfer_notice" | "cancellation_notice">().notNull(),
    relatedSourceId: uuid("related_source_id").notNull(),
    providerEntityId: uuid("provider_entity_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    vendor: text("vendor").notNull(),
    accountReference: text("account_reference").notNull(),
    usage: text("usage").$type<"test" | "production">().notNull(),
    routeFingerprint: text("route_fingerprint").notNull(),
    sourceVersion: text("source_version").notNull(),
    mapperVersion: text("mapper_version").notNull(),
    controlNumber: text("control_number").notNull(),
    fingerprint: text("fingerprint").notNull(),
    isa13: text("isa13").notNull(),
    renderedAt: timestamp("rendered_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("medicare_notice_render_identity_attempt_uq").on(t.organizationId, t.submissionId),
    unique("medicare_notice_render_identity_isa13_uq").on(t.usage, t.isa13),
  ],
);

export type MedicareNoticeRenderIdentityRow = typeof medicareNoticeRenderIdentity.$inferSelect;
export type NewMedicareNoticeRenderIdentityRow = typeof medicareNoticeRenderIdentity.$inferInsert;
