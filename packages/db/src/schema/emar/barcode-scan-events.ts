// @wardenx/db — `barcode_scan_event` (M13 §3.3). BCMA (Barcode Medication Administration) capture: the scanned
// drug NDC/RxNorm/lot/expiration plus the patient-wristband scan (only a hash of the PHI-equivalent wristband
// payload is stored — the raw payload is never logged), and the five-rights match result. Org-scoped; standard
// app.org_id RLS. Non-partitioned. administration_record is partitioned, so `administration_record_id` is plain
// uuid (no SQL FK) and nullable (a scan may precede commit). RLS + grants + the M4 write-audit trigger land in
// the RLS migration.
import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
