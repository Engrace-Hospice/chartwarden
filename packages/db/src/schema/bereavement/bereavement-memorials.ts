// @chartwarden/db — M16 MEMORIAL SERVICES (ADR-0109 D10, blueprint PR 3, migration 1391): `bereavement_memorial_service`,
// `bereavement_memorial_invitation`.
//
// SERVICE is ORG-LEVEL (agency programming; the 1374 / 1390 precedent). INVITATION names a plan and a contact and carries the three tenancy columns,
// denormalized from the plan. Publishing invites the families of deaths within `invite_window_months` and drafts one `memorial_invitation` mailing
// run (`mailing_run_id`) for those who can receive post. Attendance writes a contact-log ACTIVITY row (`memorial_service_attendance`).
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
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
import { bereavementMailingRun } from "./bereavement-mailings";
import { bereavementPlan } from "./bereavement-plans";
import { BEREAVEMENT_PROGRAM_MODALITIES } from "./bereavement-support-groups";

export const BEREAVEMENT_MEMORIAL_STATUSES = ["draft", "published", "held", "cancelled"] as const;
export const BEREAVEMENT_MEMORIAL_DELIVERIES = ["mailing", "portal_only"] as const;
export const BEREAVEMENT_MEMORIAL_INVITATION_STATUSES = [
  "invited",
  "rsvp_yes",
  "rsvp_no",
  "rsvp_maybe",
  "attended",
  "no_show",
  "withdrawn",
] as const;
export const BEREAVEMENT_MEMORIAL_RSVP_SOURCES = ["staff_phone", "portal"] as const;

export const bereavementMemorialService = pgTable(
  "bereavement_memorial_service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"), // agency prose; audit-scrubbed
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    modality: text("modality", { enum: BEREAVEMENT_PROGRAM_MODALITIES }).notNull(),
    venueText: text("venue_text"),
    joinUrlCipher: text("join_url_cipher"),
    capacity: integer("capacity"),
    rsvpBy: date("rsvp_by"),
    inviteWindowMonths: integer("invite_window_months").notNull().default(12),
    status: text("status", { enum: BEREAVEMENT_MEMORIAL_STATUSES }).notNull().default("draft"),
    invitedCount: integer("invited_count").notNull().default(0),
    mailingRunId: uuid("mailing_run_id").references(() => bereavementMailingRun.id, {
      onDelete: "restrict",
    }),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByMembershipId: uuid("published_by_membership_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgStartsIdx: index("berv_memorial_org_starts_idx").on(t.organizationId, t.startsAt, t.id),
    mailingRunIdx: index("berv_memorial_mailing_run_idx")
      .on(t.mailingRunId)
      .where(sql`mailing_run_id IS NOT NULL`),
    window: check("berv_memorial_window_chk", sql`ends_at > starts_at`),
    statusValues: check(
      "berv_memorial_status_chk",
      sql`status IN ('draft','published','held','cancelled')`,
    ),
  }),
);

export const bereavementMemorialInvitation = pgTable(
  "bereavement_memorial_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => bereavementMemorialService.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),
    bereavedContactId: uuid("bereaved_contact_id")
      .notNull()
      .references(() => bereavedContact.id, { onDelete: "restrict" }),
    delivery: text("delivery", { enum: BEREAVEMENT_MEMORIAL_DELIVERIES }).notNull(),
    status: text("status", { enum: BEREAVEMENT_MEMORIAL_INVITATION_STATUSES })
      .notNull()
      .default("invited"),
    guests: integer("guests").notNull().default(0),
    rsvpSource: text("rsvp_source", { enum: BEREAVEMENT_MEMORIAL_RSVP_SOURCES }),
    rsvpAt: timestamp("rsvp_at", { withTimezone: true }),
    rsvpRecordedByMembershipId: uuid("rsvp_recorded_by_membership_id"),
    attendedAt: timestamp("attended_at", { withTimezone: true }),
    logId: uuid("log_id"), // the activity row on the partitioned contact log (logical)
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serviceContactUniq: uniqueIndex("berv_memorial_inv_service_contact_uniq").on(
      t.serviceId,
      t.bereavedContactId,
    ),
    orgIdx: index("berv_memorial_inv_org_ix").on(t.organizationId, t.createdAt),
    serviceStatusIdx: index("berv_memorial_inv_service_status_idx").on(t.serviceId, t.status),
    planIdx: index("berv_memorial_inv_plan_idx").on(t.planId),
    contactIdx: index("berv_memorial_inv_contact_idx").on(t.bereavedContactId),
    providerEntityIdx: index("berv_memorial_inv_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("berv_memorial_inv_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),
    guests: check("berv_memorial_inv_guests_chk", sql`guests BETWEEN 0 AND 10`),
  }),
);

export type BereavementMemorialServiceRow = typeof bereavementMemorialService.$inferSelect;
export type BereavementMemorialInvitationRow = typeof bereavementMemorialInvitation.$inferSelect;
