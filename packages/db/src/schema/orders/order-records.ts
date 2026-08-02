// @wardenx/db — `order_record` (M11 §3.3). The one root table for all eight §2.1 non-medication order
// kinds (lab / dme / level_of_care_change / recertification / comfort_kit / supply / ancillary_service /
// idg_requested): the per-kind validated payload in `data` (discriminated by `kind` + `kind_version`,
// free-text denylisted from audit), the §2.2 D2 draft→pending_signature→verbal_pending→active→
// completed/discontinued lifecycle, and the orthogonal §3.5 lab transmission/results lifecycle columns.
// PHI-bearing → the three-column tenancy rule (provider_entity_id + location_id NOT NULL, denormalized
// from the admission at create-time, §3.3 tenancy note / M11-F04 / ARCH-011) drives location/PE access
// checks + downstream Q-code/claim attribution (M23). High-volume, retention-extended → PARTITION BY
// RANGE (created_at) monthly (§3.6/§3.7): the Drizzle definition is the logical shape (composite PK incl.
// the partition key); the actual PARTITION BY + monthly partitions + the §3.4 state-transition triggers
// (replace-supersede / verbal-set-pending / signature-apply / lab-initial-states) are emitted by the RLS
// migration (M11-T02). Append-only-ish — a correction inserts a new row (replaces_order_id) and the
// trigger discontinues the prior. Cross-module refs (M5 patient, M6 admission, M8 source_encounter, M9
// triggering_assessment, M10 triggering_hope_assessment, M14 triggering_idg_decision, M40 ordering
// physician) are plain uuid app-validated, NOT cross-module FKs (M11 dependsOn [6,36,38,40]); the only
// intra-module FK is standing_order_id; actor refs go to M1 `membership`. RLS + grants + the M4
// write-audit trigger (data / indication_text denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  orderKind,
  orderPriority,
  orderResultsStatus,
  orderStatus,
  orderTransmissionStatus,
} from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { standingOrders } from "./standing-orders";

export const orderRecords = pgTable(
  "order_record",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with created_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0131 (M11L): the write routes carry only admission + kind; siting backfills
    // from the M6 admission / M17 visit context when threaded.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)

    // Discriminator + payload.
    kind: orderKind("kind").notNull(),
    kindVersion: text("kind_version").notNull(), // e.g. 'lab.v1' — bumps if the TypeBox shape changes
    data: jsonb("data").notNull(), // validated by per-kind TypeBox (free-text denylisted from audit)
    priority: orderPriority("priority").notNull().default("routine"),
    indicationText: text("indication_text"), // denylisted in audit

    // Lifecycle.
    status: orderStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1), // optimistic concurrency

    // Authoring.
    drafterMembershipId: uuid("drafter_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    drafterDiscipline: text("drafter_discipline").notNull(),

    // Ordering practitioner (M40 MDM canonical; app-validated, no cross-module FK).
    orderingPhysicianMdmId: uuid("ordering_physician_mdm_id").notNull(),

    // Forward seams + triggering links (all app-validated; no cross-module FK).
    sourceEncounterId: uuid("source_encounter_id"), // M8 forward seam
    triggeringAssessmentId: uuid("triggering_assessment_id"), // M9
    triggeringHopeAssessmentId: uuid("triggering_hope_assessment_id"), // M10
    triggeringIdgDecisionId: uuid("triggering_idg_decision_id"), // M14 forward seam
    replacesOrderId: uuid("replaces_order_id"), // self-ref correction chain (loose; no SQL FK)
    standingOrderId: uuid("standing_order_id").references(() => standingOrders.id), // intra-module FK

    // Cosign control.
    cosignRequired: boolean("cosign_required").notNull().default(false),
    cosignStatus: text("cosign_status"), // null when !cosignRequired; 'pending' | 'attached' otherwise

    // Lab transmission lifecycle (orthogonal to status; lab orders only — §3.5).
    transmissionStatus: orderTransmissionStatus("transmission_status").notNull().default("not_required"),
    transmissionAckedAt: timestamp("transmission_acked_at", { withTimezone: true }),
    transmissionAckCode: text("transmission_ack_code"), // 'AA' | 'AE' | 'AR' once known
    transmissionFailureReason: text("transmission_failure_reason"),
    resultsStatus: orderResultsStatus("results_status").notNull().default("not_expected"),
    resultsFirstReceivedAt: timestamp("results_first_received_at", { withTimezone: true }),
    lastLabObservationAttachedId: uuid("last_lab_observation_attached_id"), // M29 forward seam; NO SQL FK (D14)

    // Document backref (M22 outbox handshake; null until reports rendered).
    documentId: uuid("document_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), // partition key + PK member
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    discontinuedAt: timestamp("discontinued_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }), // partition key must be in the PK
    byPatientStatus: index("order_record_patient_status_idx").on(t.organizationId, t.patientId, t.status),
    byAdmissionStatus: index("order_record_admission_status_idx").on(
      t.organizationId,
      t.admissionId,
      t.status,
    ),
    byKindStatus: index("order_record_kind_status_idx").on(t.organizationId, t.kind, t.status),
    byPhysicianPending: index("order_record_physician_pending_idx")
      .on(t.organizationId, t.orderingPhysicianMdmId, t.status)
      .where(sql`status IN ('pending_signature','verbal_pending')`),
    bySupersedeChain: index("order_record_replaces_idx").on(t.replacesOrderId),
    byStandingParent: index("order_record_standing_parent_idx").on(t.standingOrderId),
    byTriggeringAssessment: index("order_record_triggering_assessment_idx").on(t.triggeringAssessmentId),
    byTriggeringHope: index("order_record_triggering_hope_idx").on(t.triggeringHopeAssessmentId),
    byCreatedAt: index("order_record_created_idx").on(t.createdAt),
    byResultsStatusAwaiting: index("idx_order_results_status_awaiting")
      .on(t.organizationId, t.resultsStatus, t.signedAt)
      .where(sql`kind = 'lab' AND results_status IN ('awaiting_results', 'partial_results_received')`),
    byTransmissionStatus: index("idx_order_transmission_status")
      .on(t.organizationId, t.transmissionStatus, t.signedAt)
      .where(sql`kind = 'lab' AND transmission_status IN ('pending', 'pending_retry')`),
  }),
);

export type OrderRecord = typeof orderRecords.$inferSelect;
export type NewOrderRecord = typeof orderRecords.$inferInsert;
