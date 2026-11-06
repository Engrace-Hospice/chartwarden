// @chartwarden/db — M16 SUPPORT GROUPS (ADR-0109 D10, blueprint PR 3, migration 1390): `bereavement_support_group`, `_session`, `_enrollment`,
// `_attendance`.
//
// GROUP and SESSION are ORG-LEVEL (agency programming that serves families across every provider entity; no patient, plan or contact), the 1374
// config/run precedent. ENROLLMENT and ATTENDANCE name a plan and a contact and carry the three tenancy columns, denormalized from the plan.
// Attendance writes a contact-log ACTIVITY row (`support_group_session`, outcome `attended`): it satisfies no cadence item. `log_id` is that row on
// the partitioned contact log (logical, no FK). Facilitator columns hold MEMBERSHIP ids (the `assigned_counselor_user_id` convention).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavedContact } from "./bereaved-contacts";
import { bereavementPlan } from "./bereavement-plans";

export const BEREAVEMENT_GROUP_FORMATS = ["recurring", "drop_in"] as const;
export const BEREAVEMENT_PROGRAM_MODALITIES = ["in_person", "virtual"] as const;
export const BEREAVEMENT_GROUP_FACILITATOR_KINDS = ["staff", "volunteer"] as const;
export const BEREAVEMENT_GROUP_STATUSES = ["draft", "open", "completed", "cancelled"] as const;
export const BEREAVEMENT_GROUP_SESSION_STATUSES = ["scheduled", "held", "cancelled"] as const;
export const BEREAVEMENT_GROUP_ENROLLMENT_STATUSES = ["enrolled", "withdrawn"] as const;
export const BEREAVEMENT_GROUP_WITHDRAWN_REASONS = [
  "requested",
  "staff_removed",
  "opted_out",
  "plan_closed",
  "group_ended",
] as const;

export const bereavementSupportGroup = pgTable(
  "bereavement_support_group",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"), // agency prose; audit-scrubbed
    format: text("format", { enum: BEREAVEMENT_GROUP_FORMATS }).notNull(),
    modality: text("modality", { enum: BEREAVEMENT_PROGRAM_MODALITIES }).notNull(),
    enrollmentRequired: boolean("enrollment_required").notNull().default(true),
    facilitatorKind: text("facilitator_kind", {
      enum: BEREAVEMENT_GROUP_FACILITATOR_KINDS,
    }).notNull(),
    facilitatorUserId: uuid("facilitator_user_id").notNull(), // membership id (logical → M2)
    coFacilitatorUserId: uuid("co_facilitator_user_id"),
    capacity: integer("capacity"),
    status: text("status", { enum: BEREAVEMENT_GROUP_STATUSES }).notNull().default("draft"),
    recurrenceJsonb: jsonb("recurrence_jsonb"),
    timezone: text("timezone").notNull().default("UTC"),
    venueText: text("venue_text"),
    joinUrlCipher: text("join_url_cipher"),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgStatusIdx: index("berv_group_org_status_idx").on(t.organizationId, t.status, t.createdAt),
    facilitatorIdx: index("berv_group_facilitator_idx").on(t.facilitatorUserId),
    coFacilitatorIdx: index("berv_group_cofacilitator_idx")
      .on(t.coFacilitatorUserId)
      .where(sql`co_facilitator_user_id IS NOT NULL`),
    nameLen: check("berv_group_name_chk", sql`char_length(name) BETWEEN 1 AND 120`),
    formatValues: check("berv_group_format_chk", sql`format IN ('recurring','drop_in')`),
    modalityValues: check("berv_group_modality_chk", sql`modality IN ('in_person','virtual')`),
    statusValues: check(
      "berv_group_status_chk",
      sql`status IN ('draft','open','completed','cancelled')`,
    ),
    recurrence: check(
      "berv_group_recurrence_chk",
      sql`(format = 'recurring') = (recurrence_jsonb IS NOT NULL)`,
    ),
  }),
);

export const bereavementSupportGroupSession = pgTable(
  "bereavement_support_group_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => bereavementSupportGroup.id, { onDelete: "restrict" }),
    sessionNo: integer("session_no").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: BEREAVEMENT_GROUP_SESSION_STATUSES })
      .notNull()
      .default("scheduled"),
    heldAt: timestamp("held_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    noUniq: uniqueIndex("berv_group_session_no_uniq").on(t.groupId, t.sessionNo),
    groupStartsIdx: index("berv_group_session_group_starts_idx").on(t.groupId, t.startsAt),
    orgStartsIdx: index("berv_group_session_org_starts_idx").on(t.organizationId, t.startsAt),
    window: check("berv_group_session_window_chk", sql`ends_at > starts_at`),
  }),
);

export const bereavementSupportGroupEnrollment = pgTable(
  "bereavement_support_group_enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => bereavementSupportGroup.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),
    bereavedContactId: uuid("bereaved_contact_id")
      .notNull()
      .references(() => bereavedContact.id, { onDelete: "restrict" }),
    status: text("status", { enum: BEREAVEMENT_GROUP_ENROLLMENT_STATUSES })
      .notNull()
      .default("enrolled"),
    withdrawnReason: text("withdrawn_reason", { enum: BEREAVEMENT_GROUP_WITHDRAWN_REASONS }),
    enrolledByMembershipId: uuid("enrolled_by_membership_id").notNull(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnByMembershipId: uuid("withdrawn_by_membership_id"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    liveUniq: uniqueIndex("berv_group_enrollment_live_uniq")
      .on(t.groupId, t.bereavedContactId)
      .where(sql`status = 'enrolled'`),
    orgIdx: index("berv_group_enrollment_org_ix").on(t.organizationId, t.createdAt),
    groupIdx: index("berv_group_enrollment_group_idx").on(t.groupId, t.status),
    planIdx: index("berv_group_enrollment_plan_idx").on(t.planId),
    contactIdx: index("berv_group_enrollment_contact_idx").on(t.bereavedContactId),
    providerEntityIdx: index("berv_group_enrollment_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("berv_group_enrollment_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),
    withdrawn: check(
      "berv_group_enrollment_withdrawn_chk",
      sql`(status = 'withdrawn') = (withdrawn_reason IS NOT NULL AND withdrawn_at IS NOT NULL)`,
    ),
  }),
);

export const bereavementSupportGroupAttendance = pgTable(
  "bereavement_support_group_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => bereavementSupportGroupSession.id, { onDelete: "restrict" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => bereavementSupportGroup.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),
    bereavedContactId: uuid("bereaved_contact_id")
      .notNull()
      .references(() => bereavedContact.id, { onDelete: "restrict" }),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    logId: uuid("log_id"), // the activity row on the partitioned contact log (logical)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionContactUniq: uniqueIndex("berv_group_attendance_session_contact_uniq").on(
      t.sessionId,
      t.bereavedContactId,
    ),
    orgIdx: index("berv_group_attendance_org_ix").on(t.organizationId, t.createdAt),
    groupIdx: index("berv_group_attendance_group_idx").on(t.groupId),
    planIdx: index("berv_group_attendance_plan_idx").on(t.planId),
    contactIdx: index("berv_group_attendance_contact_idx").on(t.bereavedContactId),
    providerEntityIdx: index("berv_group_attendance_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("berv_group_attendance_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),
  }),
);

export type BereavementSupportGroupRow = typeof bereavementSupportGroup.$inferSelect;
export type BereavementSupportGroupSessionRow = typeof bereavementSupportGroupSession.$inferSelect;
export type BereavementSupportGroupEnrollmentRow =
  typeof bereavementSupportGroupEnrollment.$inferSelect;
export type BereavementSupportGroupAttendanceRow =
  typeof bereavementSupportGroupAttendance.$inferSelect;
