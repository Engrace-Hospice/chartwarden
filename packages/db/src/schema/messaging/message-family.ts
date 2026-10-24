// M36 WP 6.7 (ADR-0099, PROPOSED), slice S1 - family / caregiver messaging without an app (migration 1231): the tenant setting, the thread link per M5
// patient_caregiver, the one-time invitation, the contact's staged bearer session and an insert-only access trail. Names match the migration (pinned by a
// test); the lifecycle instants are set from the database clock by the guard triggers. The invite token, the session token and the code are stored as HASHES
// only; nothing here is a message body (the messages live in `message`, in a `family` channel).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { channels } from "./channels";

export const messageFamilySettings = pgTable(
  "message_family_setting",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agencyName: text("agency_name"),
    agencyPhone: text("agency_phone"),
    bereavementPhone: text("bereavement_phone"),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updatedByIdx: index("message_family_setting_updated_by_idx")
      .on(t.updatedBy)
      .where(sql`updated_by IS NOT NULL`),
    nameLen: check(
      "message_family_setting_name_len",
      sql`agency_name IS NULL OR char_length(btrim(agency_name)) BETWEEN 1 AND 120`,
    ),
    phoneLen: check(
      "message_family_setting_phone_len",
      sql`agency_phone IS NULL OR char_length(btrim(agency_phone)) BETWEEN 1 AND 120`,
    ),
    bervLen: check(
      "message_family_setting_berv_len",
      sql`bereavement_phone IS NULL OR char_length(btrim(bereavement_phone)) BETWEEN 1 AND 120`,
    ),
  }),
);

export const messageFamilyContacts = pgTable(
  "message_family_contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    /** M5 patient (logical pointer, server-validated at invite time). */
    patientId: uuid("patient_id").notNull(),
    /** M5 patient_caregiver (logical pointer): the ONE person this thread belongs to. */
    patientCaregiverId: uuid("patient_caregiver_id").notNull(),
    /** The lazily created `family` channel; named once. */
    channelId: uuid("channel_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** FAMILY_MODES in @chartwarden/types. */
    mode: text("mode").notNull().default("standard"),
    modeChangedAt: timestamp("mode_changed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockedBy: uuid("blocked_by").references(() => users.id),
    lastContactMessageAt: timestamp("last_contact_message_at", { withTimezone: true }),
    lastStaffReplyAt: timestamp("last_staff_reply_at", { withTimezone: true }),
    staffSeenThrough: timestamp("staff_seen_through", { withTimezone: true }),
  },
  (t) => ({
    orgIdUnique: unique("message_family_contact_org_id_unique").on(t.organizationId, t.id),
    personUnique: unique("message_family_contact_person_unique").on(
      t.organizationId,
      t.patientCaregiverId,
    ),
    channelUnique: unique("message_family_contact_channel_unique").on(
      t.organizationId,
      t.channelId,
    ),
    channelFk: foreignKey({
      name: "message_family_contact_channel_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("set null"),
    patientIdx: index("message_family_contact_patient_idx").on(t.organizationId, t.patientId),
    createdByIdx: index("message_family_contact_created_by_idx").on(t.createdBy),
    closedByIdx: index("message_family_contact_closed_by_idx")
      .on(t.closedBy)
      .where(sql`closed_by IS NOT NULL`),
    blockedByIdx: index("message_family_contact_blocked_by_idx")
      .on(t.blockedBy)
      .where(sql`blocked_by IS NOT NULL`),
    providerEntityIdx: index("message_family_contact_provider_entity_idx")
      .on(t.providerEntityId)
      .where(sql`provider_entity_id IS NOT NULL`),
    locationIdx: index("message_family_contact_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),
    modeCheck: check("message_family_contact_mode", sql`mode IN ('standard', 'bereavement')`),
    closedPair: check(
      "message_family_contact_closed_pair",
      sql`(closed_at IS NULL) = (closed_by IS NULL)`,
    ),
    blockedPair: check(
      "message_family_contact_blocked_pair",
      sql`(blocked_at IS NULL) = (blocked_by IS NULL)`,
    ),
  }),
);

export const messageFamilyInvitations = pgTable(
  "message_family_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    inviteTokenHash: text("invite_token_hash").notNull(),
    codeHash: text("code_hash").notNull(),
    codeAttempts: integer("code_attempts").notNull().default(0),
    inviteRedeemedAt: timestamp("invite_redeemed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
    /** FAMILY_REVOKE_REASONS in @chartwarden/types. */
    revokeReason: text("revoke_reason"),
  },
  (t) => ({
    orgIdUnique: unique("message_family_invitation_org_id_unique").on(t.organizationId, t.id),
    tokenUnique: unique("message_family_invitation_token_unique").on(t.inviteTokenHash),
    contactFk: foreignKey({
      name: "message_family_invitation_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [messageFamilyContacts.organizationId, messageFamilyContacts.id],
    }).onDelete("cascade"),
    oneLive: uniqueIndex("message_family_invitation_one_live")
      .on(t.organizationId, t.contactId)
      .where(sql`revoked_at IS NULL`),
    createdIdx: index("message_family_invitation_created_idx").on(t.organizationId, t.createdAt),
    createdByIdx: index("message_family_invitation_created_by_idx").on(t.createdBy, t.createdAt),
    revokedByIdx: index("message_family_invitation_revoked_by_idx")
      .on(t.revokedBy)
      .where(sql`revoked_by IS NOT NULL`),
    attempts: check("message_family_invitation_attempts", sql`code_attempts BETWEEN 0 AND 5`),
    expiry: check(
      "message_family_invitation_expiry",
      sql`expires_at > created_at AND expires_at <= created_at + interval '30 days'`,
    ),
    revokeReason: check(
      "message_family_invitation_revoke_reason",
      sql`revoke_reason IS NULL OR revoke_reason IN ('staff', 'superseded', 'blocked')`,
    ),
    revokePair: check(
      "message_family_invitation_revoke_pair",
      sql`(revoked_at IS NULL) = (revoke_reason IS NULL)`,
    ),
    revokedBy: check(
      "message_family_invitation_revoked_by",
      sql`revoked_by IS NULL OR revoked_at IS NOT NULL`,
    ),
  }),
);

export const messageFamilySessions = pgTable(
  "message_family_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    invitationId: uuid("invitation_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** FAMILY_SESSION_STAGES in @chartwarden/types. */
    stage: text("stage").notNull().default("enrolment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("message_family_session_org_id_unique").on(t.organizationId, t.id),
    tokenUnique: unique("message_family_session_token_unique").on(t.tokenHash),
    invitationFk: foreignKey({
      name: "message_family_session_invitation_fk",
      columns: [t.organizationId, t.invitationId],
      foreignColumns: [messageFamilyInvitations.organizationId, messageFamilyInvitations.id],
    }).onDelete("cascade"),
    invitationIdx: index("message_family_session_invitation_idx").on(
      t.organizationId,
      t.invitationId,
    ),
    stageCheck: check("message_family_session_stage", sql`stage IN ('enrolment', 'active')`),
    lifetime: check(
      "message_family_session_lifetime",
      sql`expires_at <= created_at + interval '12 hours'`,
    ),
    stagePair: check(
      "message_family_session_stage_pair",
      sql`(stage = 'active') = (activated_at IS NOT NULL)`,
    ),
  }),
);

export const messageFamilyAccess = pgTable(
  "message_family_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    /** FAMILY_ACCESS_ACTIONS in @chartwarden/types. */
    action: text("action").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    /** The message a send created (logical pointer, no FK so the retention eraser is never blocked). */
    messageId: uuid("message_id"),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    contactFk: foreignKey({
      name: "message_family_access_contact_fk",
      columns: [t.organizationId, t.contactId],
      foreignColumns: [messageFamilyContacts.organizationId, messageFamilyContacts.id],
    }).onDelete("cascade"),
    sessionFk: foreignKey({
      name: "message_family_access_session_fk",
      columns: [t.organizationId, t.sessionId],
      foreignColumns: [messageFamilySessions.organizationId, messageFamilySessions.id],
    }).onDelete("cascade"),
    contactIdx: index("message_family_access_contact_idx").on(
      t.organizationId,
      t.contactId,
      t.accessedAt,
    ),
    sessionIdx: index("message_family_access_session_idx").on(t.organizationId, t.sessionId),
    actionCheck: check("message_family_access_action", sql`action IN ('read', 'send')`),
    countCheck: check("message_family_access_count", sql`message_count >= 0`),
    sendShape: check(
      "message_family_access_send_shape",
      sql`(action = 'send') = (message_id IS NOT NULL)`,
    ),
  }),
);
