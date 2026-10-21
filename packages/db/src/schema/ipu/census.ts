import { sql } from "drizzle-orm";
// @chartwarden/db — M37 post-mortem body-release + daily census (§2.11/§2.13, §3.3): ipu_body_release
// (D12 coordination with M40 FuneralHome + M22 body-release authorization render) and
// ipu_census_snapshot (D14 per-(org × unit/remote × date) materialization published via outbox to M23
// per-diem, M26 inpatient cap, M27 cost report). TENANT-SCOPED, RLS on app.org_id.
// released_to_representative_name is PHI-denylisted. death_event_id/M6, pronouncing_physician_id/M40,
// funeral_home_id/M40, funeral_home_magic_link_session_id/M22, release_document_id/M22,
// provider_entity_id/M40 are logical uuids; ipu_admission_id is a REAL FK. The unit_xor_remote CHECK on
// the census snapshot lives in the migration.
import {
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ipuBodyReleaseState } from "../../enums";
import { ipuAdmission } from "./admission";
import { bigintVersion } from "./shared";
import { inpatientUnit } from "./units";

export const ipuBodyRelease = pgTable(
  "ipu_body_release",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // ARCH-011 (logical uuid; D17)
    locationId: uuid("location_id"),
    patientId: uuid("patient_id").notNull(),
    deathEventId: uuid("death_event_id").notNull(), // M6
    state: ipuBodyReleaseState("state").notNull().default("pending"),
    pronouncingPhysicianId: uuid("pronouncing_physician_id").notNull(), // M40 ExternalPhysician
    pronouncedAt: timestamp("pronounced_at", { withTimezone: true }).notNull(),
    funeralHomeId: uuid("funeral_home_id"), // M40 FuneralHome
    funeralHomeMagicLinkSessionId: uuid("funeral_home_magic_link_session_id"), // M22 magic-link session
    releaseDocumentId: uuid("release_document_id"), // M22 body_release_authorization
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedToRepresentativeName: text("released_to_representative_name"), // PHI denylisted
    releasedByMembershipId: uuid("released_by_membership_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    onePerAdmissionUq: uniqueIndex("body_release_one_per_admission").on(t.ipuAdmissionId),
    statePendingIx: index("body_release_state_pending_idx")
      .on(t.state)
      .where(sql`state != 'closed'`),
  }),
);

export const ipuCensusSnapshot = pgTable(
  "ipu_census_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    serviceDate: date("service_date").notNull(),
    unitId: uuid("unit_id").references(() => inpatientUnit.id),
    remoteFacilityId: uuid("remote_facility_id"),
    providerEntityId: uuid("provider_entity_id").notNull(), // M40 ProviderEntity
    censusCountGip: smallint("census_count_gip").notNull().default(0),
    censusCountIrc: smallint("census_count_irc").notNull().default(0),
    censusCountArrangedGip: smallint("census_count_arranged_gip").notNull().default(0),
    censusCountArrangedIrc: smallint("census_count_arranged_irc").notNull().default(0),
    bedDaysGip: smallint("bed_days_gip").notNull().default(0),
    bedDaysIrc: smallint("bed_days_irc").notNull().default(0),
    bedDaysArrangedGip: smallint("bed_days_arranged_gip").notNull().default(0),
    bedDaysArrangedIrc: smallint("bed_days_arranged_irc").notNull().default(0),
    roomTurnoverCount: smallint("room_turnover_count").notNull().default(0),
    restraintIncidentCount: smallint("restraint_incident_count").notNull().default(0),
    fallIncidentCount: smallint("fall_incident_count").notNull().default(0),
    infectionSurveillanceEventCount: smallint("infection_surveillance_event_count")
      .notNull()
      .default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    unitDateUq: uniqueIndex("ipu_census_snapshot_unit_date_uq").on(
      t.organizationId,
      t.serviceDate,
      t.unitId,
      t.remoteFacilityId,
    ),
    peDateIx: index("census_snapshot_pe_date_idx").on(t.providerEntityId, t.serviceDate),
  }),
);

export type IpuBodyReleaseRow = typeof ipuBodyRelease.$inferSelect;
export type NewIpuBodyReleaseRow = typeof ipuBodyRelease.$inferInsert;
export type IpuCensusSnapshotRow = typeof ipuCensusSnapshot.$inferSelect;
export type NewIpuCensusSnapshotRow = typeof ipuCensusSnapshot.$inferInsert;
