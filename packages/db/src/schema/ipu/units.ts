// @wardenx/db — M37 IPU bed hierarchy (§2.1, §3.3): inpatient_unit → ipu_room → ipu_bed, plus the
// ipu_bed_cleaning_event turnover ledger (§2.12 D13). All TENANT-SCOPED, RLS on canonical app.org_id
// (migration 0148/0149). `organization_id` is a logical uuid (its organization FK is declared in the
// migration SQL, matching the M35 convention); intra-module parent links (unit_id/room_id) are REAL FKs.
// `ipu_bed_cleaning_event` is MONTHLY-PARTITIONED by `at` (composite PK `(id, at)` declared in SQL) — its
// write-audit trigger is a GENERATED function that hard-codes the parent name (the M32 ai_token_ledger
// lesson). Column CHECKs and partial-index predicates are authoritative in the migration; the Drizzle
// view carries columns + the constraints Drizzle can express so `$inferSelect` types stay honest.
import {
  boolean,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ipuBedCleaningStatus, ipuRoomKind } from "../../enums";
import { bigintVersion } from "./shared";

export const inpatientUnit = pgTable(
  "inpatient_unit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    facilityId: uuid("facility_id").notNull(), // M40 Facility (seam reference)
    displayName: text("display_name").notNull(),
    bedCount: smallint("bed_count").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    featureFlagRequired: text("feature_flag_required").notNull().default("ipu_module_enabled"),
    rnCoverageHorizonHours: smallint("rn_coverage_horizon_hours").notNull().default(8),
    turnoverSlaMinutes: smallint("turnover_sla_minutes").notNull().default(120),
    gipReassessmentIntervalHours: smallint("gip_reassessment_interval_hours").notNull().default(24),
    ircCapOverrideMaxDays: smallint("irc_cap_override_max_days").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    orgFacilityUq: uniqueIndex("inpatient_unit_org_facility_uq").on(t.organizationId, t.facilityId),
  }),
);

export const ipuRoom = pgTable(
  "ipu_room",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => inpatientUnit.id, { onDelete: "restrict" }),
    roomNumber: text("room_number").notNull(),
    kind: ipuRoomKind("kind").notNull(),
    bedCount: smallint("bed_count").notNull(),
    hasWindow: boolean("has_window").notNull().default(false),
    hasPrivateBathroom: boolean("has_private_bathroom").notNull().default(false),
    familyAmenitiesPresent: boolean("family_amenities_present").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    unitRoomUq: uniqueIndex("ipu_room_unit_room_uq").on(t.unitId, t.roomNumber),
  }),
);

export const ipuBed = pgTable(
  "ipu_bed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => ipuRoom.id, { onDelete: "restrict" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => inpatientUnit.id, { onDelete: "restrict" }),
    bedLabel: text("bed_label").notNull(),
    cleaningStatus: ipuBedCleaningStatus("cleaning_status").notNull().default("ready"),
    cleaningStatusChangedAt: timestamp("cleaning_status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    geofenceLat: numeric("geofence_lat", { precision: 10, scale: 7 }),
    geofenceLon: numeric("geofence_lon", { precision: 11, scale: 7 }),
    geofenceRadiusMeters: smallint("geofence_radius_meters").default(25),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    roomBedUq: uniqueIndex("ipu_bed_room_label_uq").on(t.roomId, t.bedLabel),
    unitStatusIx: index("ipu_bed_unit_status_idx").on(t.unitId, t.cleaningStatus),
    roomIx: index("ipu_bed_room_idx").on(t.roomId),
  }),
);

// MONTHLY-PARTITIONED by `at`; composite PK (id, at) + PARTITION BY RANGE declared in migration 0149.
export const ipuBedCleaningEvent = pgTable(
  "ipu_bed_cleaning_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    bedId: uuid("bed_id").notNull(),
    fromStatus: ipuBedCleaningStatus("from_status"),
    toStatus: ipuBedCleaningStatus("to_status").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    byMembershipId: uuid("by_membership_id"),
    notes: text("notes"),
  },
  (t) => ({
    bedAtIx: index("ipu_bed_cleaning_event_bed_at_idx").on(t.bedId, t.at),
  }),
);

export type InpatientUnitRow = typeof inpatientUnit.$inferSelect;
export type NewInpatientUnitRow = typeof inpatientUnit.$inferInsert;
export type IpuRoomRow = typeof ipuRoom.$inferSelect;
export type NewIpuRoomRow = typeof ipuRoom.$inferInsert;
export type IpuBedRow = typeof ipuBed.$inferSelect;
export type NewIpuBedRow = typeof ipuBed.$inferInsert;
export type IpuBedCleaningEventRow = typeof ipuBedCleaningEvent.$inferSelect;
export type NewIpuBedCleaningEventRow = typeof ipuBedCleaningEvent.$inferInsert;
