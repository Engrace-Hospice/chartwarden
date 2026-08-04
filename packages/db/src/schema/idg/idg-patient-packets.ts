// @wardenx/db — `idg_patient_packet` (M14 §3.3.1 / §2.4 D1 / D12). One frozen pre-meeting packet per
// patient per meeting: the §2.4 PacketSnapshot (since-last-IDG join across M7/M8/M9/M10/M12), the per-
// discipline view blocks (D7), the two-layer cover summary, and the M22 rendered-PDF back-ref. Carries the
// M14-F01 / ADR-0018 D2 per-patient (per-POC) 15-day review anchor (`last_idg_reviewed_at`) — a column, not
// a table, so the owned-table count stays 9. PHI-bearing (patient_id + admission_id NOT NULL) → the three-
// column tenancy rule (provider_entity_id + location_id NOT NULL, denormalized from the admission).
//
// PARTITION BY RANGE (built_at) monthly (D12 — matches the M4 PHI-table convention + M9/M10/M11/M13
// precedent): the Drizzle definition here is the LOGICAL shape (composite PK incl. the partition key); the
// PARTITION BY + monthly children + DEFAULT catch-all land in the RLS migration (M14-T02), which drops the
// plain table drizzle-kit emits and re-creates it partitioned. Because it is partitioned, every reference TO
// it (none in M14) carries no SQL FK and the "one packet per meeting+patient" rule is a PLAIN index +
// app-enforced (a cross-partition UNIQUE is illegal without the partition key). Cross-module (M5 patient,
// M6 admission), intra-module (idg_meeting_id), and the M22 packet_document_id refs are plain uuid
// app-validated; only the tenancy spine (organization / provider_entity / location) carries FKs. Snapshot
// narrative free-text (cover_summary_layer1/2 + the built_snapshot discipline_views / sinceLastIdg keys) is
// denylisted in the M4 write-audit trigger (§3.3). RLS + grants + trigger + partition land in M14-T02.
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const idgPatientPacket = pgTable(
  "idg_patient_packet",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with built_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    idgMeetingId: uuid("idg_meeting_id").notNull(), // intra-module (no FK — packet is partitioned)
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)
    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(), // monthly partition key (D12)
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    // M14-F01 / ADR-0018 D2 — per-patient (per-POC) 15-day review anchor (CoP §418.56(b)/(d)). The per-
    // patient floor is `last_idg_reviewed_at + 15 days`; stamped at adjournment, carried forward to the next
    // packet. NULL until the first review (cursor falls back to admission `activated_at`, like since_cursor_iso).
    lastIdgReviewedAt: timestamp("last_idg_reviewed_at", { withTimezone: true }),
    sinceCursorIso: text("since_cursor_iso").notNull(),
    builtSnapshot: jsonb("built_snapshot").notNull(), // PacketSnapshot — nested narrative keys denylisted (§3.3)
    disciplineViews: jsonb("discipline_views").notNull(), // Record<DisciplineKey, DisciplineViewBlock>
    coverSummaryLayer1: text("cover_summary_layer1").notNull(), // DENYLISTED
    coverSummaryLayer2: text("cover_summary_layer2"), // DENYLISTED
    packetDocumentId: uuid("packet_document_id"), // M22 PDF back-ref (app-validated; no FK)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.builtAt] }), // partition key must be in the PK
    // "Packet for meeting + patient" — a PLAIN index (uniqueness app-enforced; cross-partition UNIQUE is
    // illegal without the partition key).
    byMeetingPatient: index("idg_patient_packet_meeting_patient_idx").on(
      t.organizationId,
      t.idgMeetingId,
      t.patientId,
    ),
    // M14-F01 / ADR-0018 D2: per-patient review-clock lookup — "most recent reviewed-at for an admission".
    byAdmissionReviewed: index("idg_patient_packet_admission_reviewed_idx").on(
      t.organizationId,
      t.admissionId,
      t.lastIdgReviewedAt.desc(),
    ),
  }),
);

export type IdgPatientPacket = typeof idgPatientPacket.$inferSelect;
export type NewIdgPatientPacket = typeof idgPatientPacket.$inferInsert;
