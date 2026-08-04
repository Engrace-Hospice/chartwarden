// @wardenx/db — `evv_event` (M18 §3.3 / §2.2.1 D2). The append-only discrete-capture ledger: one row per
// check-in and one per check-out (the visit-level EVV bracket is M17's domain, derived from these — D2).
// PHI-bearing (patient_id / patient_address_id / GPS coords) → ARCH-011: the three tenancy columns are
// present and provider_entity_id + location_id are NOT NULL (an EVV capture is always a field service at a
// known location). GPS coordinates are field-level encrypted at rest (`coords_cipher`, D10, separate
// `evv.read_coords` permission). Cross-module logical FKs (M5 patient / patient_address, M17 visit, M2
// device_attestation) are plain uuid app-validated (M18 dependsOn [17]); the `evv_device` FK is M18-owned;
// only the tenancy spine + posting membership carry SQL FKs.
//
// PARTITION BY RANGE (event_at) monthly (D12 — `evv_record` retention class, 7 years, longer than M17's
// `operational`): the Drizzle definition here is the LOGICAL shape (composite PK incl. the partition key);
// the PARTITION BY + monthly children + DEFAULT catch-all land in the RLS migration (M18-T02 / 0047), which
// drops the plain table drizzle-kit emits and re-creates it partitioned. Because it is partitioned, the
// partial-UNIQUE backstops (active-visit-kind D2; offline idempotency D5) cannot live on the partitioned
// PARENT (Postgres forbids a partial unique index that omits the partition key) — they are declared as plain
// indexes here and re-added as per-LEAF partial-UNIQUE in 0047 (the M17 per-leaf EXCLUDE precedent). The
// append-only immutability trigger (refuse UPDATE except superseded_at/superseded_by_event_id; refuse DELETE)
// also lands in 0047 (§3.2 Phase C). References TO `evv_event` (evv_geofence_evaluation.evv_event_id) carry
// NO SQL FK — plain uuid app-validated. RLS + grants + the M4 write-audit trigger land in 0047.
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { evvEventGpsQuality, evvEventKind } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { evvDevice } from "./evv-device";

export const evvEvent = pgTable(
  "evv_event",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with event_at (the partition key, D12)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // ARCH-011: NOT NULL — an EVV capture is a patient-scoped field service at a known location.
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    visitId: uuid("visit_id").notNull(), // M17 visit (app-validated; no cross-module FK)
    patientId: uuid("patient_id").notNull(), // M5 patient (cross-checked from visit)
    patientAddressId: uuid("patient_address_id"), // M5 patient_address — NULL for facility visits

    kind: evvEventKind("kind").notNull(),
    serviceTypeCode: text("service_type_code").notNull(), // M38 value-set code (Cures Act six-element #1)

    postingMembershipId: uuid("posting_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    postingDisciplineAtRecording: text("posting_discipline_at_recording").notNull(),
    evvDeviceId: uuid("evv_device_id")
      .notNull()
      .references(() => evvDevice.id, { onDelete: "restrict" }),

    // The two timestamps (D5):
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(), // device clock
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(), // server clock
    eventAt: timestamp("event_at", { withTimezone: true }).notNull(), // = capturedAt; the partition key

    // GPS coordinate, encrypted at rest (D10):
    coordsCipher: text("coords_cipher").notNull(), // base64 ciphertext of "lat,lng"; DENYLISTED (§3.6)
    coordsDekVersion: integer("coords_dek_version").notNull(),
    accuracyM: real("accuracy_m").notNull(), // device-reported accuracy (m); DENYLISTED (§3.6)
    gpsQuality: evvEventGpsQuality("gps_quality").notNull(),

    // Offline-capture markers (D5):
    offlineCapture: boolean("offline_capture").notNull().default(false),
    localId: uuid("local_id"), // device-generated; idempotency key
    syncedAt: timestamp("synced_at", { withTimezone: true }),

    // Correction-of-record (immutable rules per §2.3, enforced by the 0047 append-only trigger):
    replacesEventId: uuid("replaces_event_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByEventId: uuid("superseded_by_event_id"),
    correctionReason: text("correction_reason"), // ≥60 chars when replacesEventId set; DENYLISTED (§3.6)

    // Device-attestation snapshot at recording (D8):
    deviceAttestationIdAtRecord: uuid("device_attestation_id_at_record").notNull(), // M2 row (app-validated)

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.eventAt] }), // partition key must be in the PK (D12)
    // The hot path: "give me the check-in/check-out pair for this visit" (M17/M8/M23/M28 readers).
    orgVisit: index("evv_event_org_visit_idx").on(t.organizationId, t.visitId, t.kind),
    orgPatient: index("evv_event_org_patient_idx").on(t.organizationId, t.patientId, t.eventAt),
    // M20 field-safety "where is each clinician right now" path (EvvLocationProvider seam).
    orgMembership: index("evv_event_org_membership_idx").on(
      t.organizationId,
      t.postingMembershipId,
      t.eventAt,
    ),
    orgDevice: index("evv_event_org_device_idx").on(t.organizationId, t.evvDeviceId, t.eventAt),
    // The supervisor review queue: suspected-spoof / outside-geofence events (§3.4).
    orgGpsQuality: index("evv_event_org_gps_quality_idx").on(
      t.organizationId,
      t.gpsQuality,
      t.eventAt,
    ),
    // D2 active-pair invariant + D5 offline idempotency are partial-UNIQUE indexes that OMIT the
    // partition key (event_at), so they cannot live on the partitioned PARENT — declared plain here and
    // re-added as per-LEAF partial-UNIQUE in 0047 (`evv_event_active_visit_kind_uidx` ON
    // (organization_id, visit_id, kind) WHERE superseded_by_event_id IS NULL; `evv_event_offline_*` ON
    // (organization_id, evv_device_id, local_id) WHERE local_id IS NOT NULL). The M17 per-leaf precedent.
  }),
);

export type EvvEvent = typeof evvEvent.$inferSelect;
export type NewEvvEvent = typeof evvEvent.$inferInsert;
