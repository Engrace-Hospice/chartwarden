// @wardenx/db — `lab_observation` + `lab_observation_value` + `lab_observation_inbound_link` (M29 §3.3).
// An ORU^R01 lab result auto-attached to an M5 patient / M11 order (§2.2 auto-attach lifecycle,
// W-XI-05/06). A `lab_observation` row exists ONLY once the result matches a patient — an unmatched result
// stays as the inbound message + a `lab_observation_inbound_link` with a `candidate_patient_id`.
//
// PHI THREE-COLUMN RULE (ARCH-011, architecture wins over §3.3). `lab_observation` carries `patient_id`, so
// it is PHI-bearing and — unlike the spec's literal schema — adds `provider_entity_id` NOT NULL (the
// patient's agency, always resolvable once matched) + `location_id` (nullable; a lab is not location-scoped),
// the same shape the tenancy gate forces on every patient-bearing table.
//
// PARTITIONING. `lab_observation` and its child `lab_observation_value` are MONTHLY PARTITIONED BY RANGE
// (`received_at`), co-partitioned on a denormalized receive timestamp; the composite PK `(id, received_at)`
// is declared in SQL (0145). `lab_observation_inbound_link` is UNPARTITIONED (0144). All three carry
// `organization_id` — the two child tables ADD it (the spec omitted it) so each gets its own app.org_id RLS
// policy + audit trigger and the tenancy gate's `missing-organization_id` rule is satisfied.
//
// FK POLICY (architecture §25.15): on the partitioned tables `organization_id` / `provider_entity_id` /
// `location_id` / `patient_id` / `order_id` / `source_message_id` / `performing_lab_facility_id` /
// `attached_document_id` are LOGICAL uuids validated at the write boundary (no DB FK from a partitioned
// child); the unpartitioned link table carries a REAL `organization` FK, its `observation_id` /
// `source_message_id` staying logical (they reference partitioned parents).
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import {
  hl7InboundMatchLevel,
  labAbnormalFlag,
  labAbnormalSummary,
  labMatchMethod,
  labResultStatus,
  labTerminologyValidation,
  labUnmatchedResolution,
  labValueType,
} from "./enums";

export const labObservation = pgTable(
  "lab_observation",
  {
    // Composite PK (id, received_at) declared in SQL (0145).
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    /** ARCH-011 — the patient's agency (always resolvable once the result is matched). Logical M40 ref. */
    providerEntityId: uuid("provider_entity_id").notNull(),
    /** ARCH-011 — nullable: a lab result is not location-scoped. Logical M1 ref. */
    locationId: uuid("location_id"),
    sourceMessageId: uuid("source_message_id").notNull(),
    /** Logical M5 ref — a lab_observation row exists only once matched to a patient. */
    patientId: uuid("patient_id").notNull(),
    /** Logical M11 ref; nullable — unsolicited results have no placer order. */
    orderId: uuid("order_id"),
    observationDate: timestamp("observation_date", { withTimezone: true }).notNull(),
    collectionDate: timestamp("collection_date", { withTimezone: true }),
    resultStatus: labResultStatus("result_status").notNull(),
    performingLabFacilityId: uuid("performing_lab_facility_id"),
    orderingPhysicianNpi: text("ordering_physician_npi"),
    loincCode: text("loinc_code").notNull(),
    loincDisplayText: text("loinc_display_text").notNull(),
    terminologyValidation: labTerminologyValidation("terminology_validation").notNull(),
    abnormalSummary: labAbnormalSummary("abnormal_summary").notNull(),
    attachedDocumentId: uuid("attached_document_id"),
    /** SUD segments stripped at the wire boundary before persist (D15, W-XI-14). */
    sudRedactedAtIngest: boolean("sud_redacted_at_ingest").notNull().default(false),
    previousObservationId: uuid("previous_observation_id"),
    /** GAP-152 (migration 0461) — the RN's abnormal-flag acknowledgement (D7); logical M2 membership ref. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByMembershipId: uuid("acknowledged_by_membership_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
  },
  (t) => ({
    orgPatientIdx: index("idx_lo_org_patient").on(t.organizationId, t.patientId),
    patientDateIdx: index("idx_lo_patient_date").on(t.patientId, t.observationDate),
    orderIdx: index("idx_lo_order").on(t.orderId),
    abnormalIdx: index("idx_lo_abnormal").on(t.abnormalSummary),
  }),
);

export const labObservationValue = pgTable(
  "lab_observation_value",
  {
    // Composite PK (id, received_at) declared in SQL (0145); co-partitioned with the parent.
    id: uuid("id").primaryKey().defaultRandom(),
    /** Added vs §3.3 (ARCH-011 / tenancy gate): the child carries its own org for its RLS policy. */
    organizationId: uuid("organization_id").notNull(),
    /** app-side ref → partitioned `lab_observation`. */
    observationId: uuid("observation_id").notNull(),
    obxSetId: integer("obx_set_id").notNull(),
    loincCode: text("loinc_code").notNull(),
    loincDisplayText: text("loinc_display_text").notNull(),
    terminologyValidation: labTerminologyValidation("terminology_validation").notNull(),
    valueType: labValueType("value_type").notNull(),
    numericValue: numeric("numeric_value", { precision: 18, scale: 6 }),
    stringValue: text("string_value"),
    units: text("units"),
    referenceRange: text("reference_range"),
    abnormalFlag: labAbnormalFlag("abnormal_flag"),
    performedAt: timestamp("performed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
  },
  (t) => ({
    observationIdx: index("idx_lov_observation").on(t.observationId, t.obxSetId),
    loincIdx: index("idx_lov_loinc").on(t.loincCode),
  }),
);

export const labObservationInboundLink = pgTable(
  "lab_observation_inbound_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Added vs §3.3 (ARCH-011 / tenancy gate): its own org for its RLS policy. REAL FK (unpartitioned). */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** app-side refs → partitioned `lab_observation` / `hl7_message_inbound`. */
    observationId: uuid("observation_id").notNull(),
    sourceMessageId: uuid("source_message_id").notNull(),
    sourceOrderId: uuid("source_order_id"),
    obrPlacerOrderNumber: text("obr_placer_order_number"),
    matchMethod: labMatchMethod("match_method").notNull(),
    matchConfidence: numeric("match_confidence", { precision: 4, scale: 3 }),
    // ── Candidate routing (populated by T-29.07 when a lab matches an L4/L5 candidate) ──
    candidatePatientId: uuid("candidate_patient_id"),
    candidateMatchLevel: hl7InboundMatchLevel("candidate_match_level"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // ── §4.2 review-queue EXIT (GAP-044, migration 0200) ──
    // `resolved_at IS NULL` IS the unmatched queue. All three of resolution/resolved_at/resolved_by are
    // written together or not at all (`lol_resolution_consistent`); a discard additionally requires a
    // ≥10-char reason (`lol_discard_reason_required`, §5.2.4). Both CHECKs live in SQL — Drizzle cannot
    // express the cross-column shape, and the queue's audit trail is exactly what must not drift.
    resolution: labUnmatchedResolution("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByMembershipId: uuid("resolved_by_membership_id"),
    /** The bind's optional note or the discard's REQUIRED reason — one reviewer justification column. */
    resolutionReason: text("resolution_reason"),
  },
  (t) => ({
    observationIdx: index("idx_lol_observation").on(t.observationId),
    placerIdx: index("idx_lol_placer").on(t.obrPlacerOrderNumber),
  }),
);

export type LabObservationRow = typeof labObservation.$inferSelect;
export type NewLabObservationRow = typeof labObservation.$inferInsert;
export type LabObservationValueRow = typeof labObservationValue.$inferSelect;
export type NewLabObservationValueRow = typeof labObservationValue.$inferInsert;
export type LabObservationInboundLinkRow = typeof labObservationInboundLink.$inferSelect;
export type NewLabObservationInboundLinkRow = typeof labObservationInboundLink.$inferInsert;
