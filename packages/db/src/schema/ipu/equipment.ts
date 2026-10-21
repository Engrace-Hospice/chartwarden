import { sql } from "drizzle-orm";
// @chartwarden/db — M37 equipment + biomed inspection (§2.9 D10, §3.3): ipu_equipment (the asset), its
// maintenance ledger, and its inspection ledger (an overdue inspection blocks bed assignment, §5.8).
// TENANT-SCOPED, RLS on app.org_id. inspection `notes` is PHI-denylisted. equipment_id is a REAL FK;
// current_unit/room/bed ids are intra-module FKs; current_assigned_patient_id and
// inspection_certificate_document_id (M22) are logical uuids.
import {
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ipuEquipmentInspectionKind,
  ipuEquipmentInspectionOutcome,
  ipuEquipmentLocationKind,
  ipuEquipmentStatus,
  ipuEquipmentType,
} from "../../enums";
import { bigintVersion } from "./shared";
import { inpatientUnit, ipuBed, ipuRoom } from "./units";

export const ipuEquipment = pgTable(
  "ipu_equipment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    serialNumber: text("serial_number").notNull(),
    equipmentType: ipuEquipmentType("equipment_type").notNull(),
    manufacturer: text("manufacturer").notNull(),
    modelNumber: text("model_number").notNull(),
    yearOfManufacture: smallint("year_of_manufacture"),
    currentLocationKind: ipuEquipmentLocationKind("current_location_kind")
      .notNull()
      .default("storage"),
    currentUnitId: uuid("current_unit_id").references(() => inpatientUnit.id),
    currentRoomId: uuid("current_room_id").references(() => ipuRoom.id),
    currentBedId: uuid("current_bed_id").references(() => ipuBed.id),
    currentAssignedPatientId: uuid("current_assigned_patient_id"),
    lastInspectionDate: date("last_inspection_date"),
    nextInspectionDueDate: date("next_inspection_due_date"),
    inspectionIntervalDays: smallint("inspection_interval_days").notNull().default(365),
    currentStatus: ipuEquipmentStatus("current_status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    orgSerialUq: uniqueIndex("ipu_equipment_org_serial_uq").on(t.organizationId, t.serialNumber),
    statusIx: index("ipu_equipment_status_idx")
      .on(t.currentStatus)
      .where(sql`current_status = 'active'`),
    inspectionDueIx: index("ipu_equipment_inspection_due_idx")
      .on(t.nextInspectionDueDate)
      .where(sql`current_status = 'active'`),
    bedIx: index("ipu_equipment_bed_idx")
      .on(t.currentBedId)
      .where(sql`current_assigned_patient_id IS NOT NULL`),
  }),
);

export const ipuEquipmentMaintenance = pgTable(
  "ipu_equipment_maintenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    equipmentId: uuid("equipment_id")
      .notNull()
      .references(() => ipuEquipment.id, { onDelete: "restrict" }),
    maintenanceKind: text("maintenance_kind").notNull(),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
    performedByMembershipId: uuid("performed_by_membership_id").notNull(),
    notes: text("notes"),
    partsReplaced: jsonb("parts_replaced"),
    vendorInvoiceReference: text("vendor_invoice_reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    equipmentIx: index("ipu_equipment_maintenance_equipment_idx").on(t.equipmentId, t.performedAt),
  }),
);

export const ipuEquipmentInspection = pgTable(
  "ipu_equipment_inspection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    equipmentId: uuid("equipment_id")
      .notNull()
      .references(() => ipuEquipment.id, { onDelete: "restrict" }),
    inspectionKind: ipuEquipmentInspectionKind("inspection_kind").notNull(),
    inspectedAt: timestamp("inspected_at", { withTimezone: true }).notNull().defaultNow(),
    inspectorMembershipId: uuid("inspector_membership_id").notNull(),
    outcome: ipuEquipmentInspectionOutcome("outcome").notNull(),
    notes: text("notes"), // PHI denylisted
    nextInspectionDueDate: date("next_inspection_due_date").notNull(),
    inspectionCertificateDocumentId: uuid("inspection_certificate_document_id"), // M22
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    equipmentIx: index("ipu_equipment_inspection_equipment_idx").on(t.equipmentId, t.inspectedAt),
  }),
);

export type IpuEquipmentRow = typeof ipuEquipment.$inferSelect;
export type NewIpuEquipmentRow = typeof ipuEquipment.$inferInsert;
export type IpuEquipmentMaintenanceRow = typeof ipuEquipmentMaintenance.$inferSelect;
export type NewIpuEquipmentMaintenanceRow = typeof ipuEquipmentMaintenance.$inferInsert;
export type IpuEquipmentInspectionRow = typeof ipuEquipmentInspection.$inferSelect;
export type NewIpuEquipmentInspectionRow = typeof ipuEquipmentInspection.$inferInsert;
