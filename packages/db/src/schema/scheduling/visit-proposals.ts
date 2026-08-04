import { sql } from "drizzle-orm";
// @wardenx/db — `visit_proposal` (M17 §3.3 / §2.2.4 D5). The scheduler's inbox: a system-generated
// suggestion to schedule a visit, sourced from M7 frequency (D5), M15 supervisory cadence, M11 order-
// required, or M14 IDG decision. Carries the typed upstream payload + idempotency key (one proposal per
// source event), the proposed discipline/date/duration, an optional best-fit membership suggestion, and the
// pending → published | dismissed | stale lifecycle. PHI-bearing (patient_id / admission_id) → M17-F01
// three tenancy columns, provider_entity_id + location_id NOT NULL. `source_payload` and `dismissal_reason`
// are DENYLISTED (§3.6 — the payload may carry narrative). Cross-module logical FKs are plain uuid; the
// tenancy spine carries SQL FKs. Not partitioned (TTL-trimmed via accept/reject, D14). RLS + grants + the M4
// write-audit trigger land in M17-T02.
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { visitProposalSource, visitProposalStatus, visitPurpose } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const visitProposal = pgTable(
  "visit_proposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)

    source: visitProposalSource("source").notNull(), // frequency_driven_m7 | supervisory_cadence_m15 | ...
    sourcePayload: jsonb("source_payload").notNull(), // upstream event id + typed payload — DENYLISTED (§3.6)
    sourceIdempotencyKey: text("source_idempotency_key").notNull(),

    proposedForDate: date("proposed_for_date").notNull(),
    proposedVisitPurpose: visitPurpose("proposed_visit_purpose").notNull(),
    proposedDiscipline: text("proposed_discipline").notNull(),
    proposedDurationMinutes: integer("proposed_duration_minutes").notNull(),
    suggestedMembershipId: uuid("suggested_membership_id"), // best-fit suggestion; scheduler may reassign

    status: visitProposalStatus("status").notNull().default("pending"),
    publishedAsVisitId: uuid("published_as_visit_id"),
    dismissedBy: uuid("dismissed_by"),
    dismissalReason: text("dismissal_reason"), // DENYLISTED (§3.6)
    staleAt: timestamp("stale_at", { withTimezone: true }), // pending after this is auto-marked stale

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgPending: index("vp_org_pending_idx")
      .on(t.organizationId, t.status, t.proposedForDate)
      .where(sql`status = 'pending'`),
    idempotency: uniqueIndex("vp_idempotency_uidx").on(
      t.organizationId,
      t.source,
      t.sourceIdempotencyKey,
    ),
  }),
);

export type VisitProposal = typeof visitProposal.$inferSelect;
export type NewVisitProposal = typeof visitProposal.$inferInsert;
