// @chartwarden/db — `barcode_scan_event` (M13 §3.3). BCMA (Barcode Medication Administration) capture: the scanned
// drug NDC/RxNorm/lot/expiration plus the patient-wristband scan (only a hash of the PHI-equivalent wristband
// payload is stored — the raw payload is never logged), and the five-rights match result. Org-scoped; standard
// app.org_id RLS. Non-partitioned. administration_record is partitioned, so `administration_record_id` is plain
// uuid (no SQL FK) and nullable (a scan may precede commit). RLS + grants + the M4 write-audit trigger land in
// the RLS migration.
import { date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const barcodeScanEvents = pgTable(
  "barcode_scan_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    administrationRecordId: uuid("administration_record_id"), // nullable: scan may precede commit (no FK — partitioned)

    scannedNdc: text("scanned_ndc"),
    scannedRxnormRxcui: text("scanned_rxnorm_rxcui"),
    scannedLotNumber: text("scanned_lot_number"),
    scannedExpirationDate: date("scanned_expiration_date"),
    patientWristbandScannedAt: timestamp("patient_wristband_scanned_at", { withTimezone: true }),
    patientWristbandPayloadDigest: text("patient_wristband_payload_digest"), // hash; PHI-equivalent payload never logged

    matchResult: text("match_result").notNull(), // 'match' | 'wrong_drug' | 'wrong_patient' | 'expired' | 'no_order_active'

    // GAP-020 -- what M5's wristband verifier concluded (WristbandVerdictStatus | 'skipped_policy_off'), the
    // generation it matched, and -- for a scan of ANOTHER patient's band -- that patient (QAPI near miss).
    // `patient_id` / `medication_order_id` attribute a REFUSED scan, which has no administration row.
    wristbandCheck: text("wristband_check"),
    wristbandGeneration: integer("wristband_generation"),
    wristbandMatchedPatientId: uuid("wristband_matched_patient_id"),
    patientId: uuid("patient_id"),
    medicationOrderId: uuid("medication_order_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAdmin: index("barcode_admin_idx").on(t.administrationRecordId),
    byPatientWristband: index("barcode_wristband_idx").on(
      t.organizationId,
      t.patientWristbandPayloadDigest,
    ),
  }),
);

export type BarcodeScanEvent = typeof barcodeScanEvents.$inferSelect;
export type NewBarcodeScanEvent = typeof barcodeScanEvents.$inferInsert;
