// @chartwarden/db — `channel` (M36 Secure Messaging §3.3). The org-scoped container every
// message and membership row hangs off. `channel_kind` is the SINGLE discriminator (§2.3,
// M36-T01 / interfaces/kinds.ts) that fixes a channel's lifecycle, whether it carries a
// subject, and its retention class — enforced here by the `channel_kind_subject_shape`
// CHECK and kept immutable after insert (the M36-T03 trigger guards updates). RLS keyed on
// app.org_id + the M4 write-audit trigger land in M36-T03 (§3.7–3.9). Not a PHI table by
// the three-column rule — it carries only references (subject_id is a polymorphic, FK-less
// pointer), no patient field — so provider_entity_id/location_id do not apply.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { channelKind, channelRetentionClass } from "../../enums";
import { organizations } from "../organizations";

export const channels = pgTable(
  "channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    channelKind: channelKind("channel_kind").notNull(),
    // Polymorphic subject pointer (FK-less, resolved per kind): a patient, location,
    // provider entity, or bereavement-plan reference, or NULL for dm/announcement (§2.3).
    subjectId: uuid("subject_id"),
    // Canonical sorted participant pair for DMs. The database uniqueness constraint makes
    // open-or-create safe when two requests race; it is never accepted from a client.
    dmParticipantKey: text("dm_participant_key"),
    title: text("title").notNull(),
    retentionClass: channelRetentionClass("retention_class").notNull(),
    isArchived: boolean("is_archived").notNull().default(false),
    archivesAt: timestamp("archives_at", { withTimezone: true }), // pre-computed for bereavement
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdIdUnique: unique("channel_org_id_id_unique").on(t.organizationId, t.id), // 1072: composite-FK target
    orgKindIdx: index("channel_org_kind_idx").on(t.organizationId, t.channelKind),
    subjectIdx: index("channel_subject_idx")
      .on(t.channelKind, t.subjectId)
      .where(sql`subject_id IS NOT NULL`),
    uniqueSubject: uniqueIndex("channel_unique_subject")
      .on(t.organizationId, t.channelKind, t.subjectId)
      .where(
        sql`subject_id IS NOT NULL AND channel_kind IN ('care_team','on_call','bereavement','location','discipline')`,
      ),
    uniqueDmParticipants: uniqueIndex("channel_unique_dm_participants")
      .on(t.organizationId, t.dmParticipantKey)
      .where(sql`channel_kind = 'dm' AND dm_participant_key IS NOT NULL`),
    // M36-F02 / ADR-0004 / ARCH-185: retention classes by kind. `dm` is care_related (staff
    // DMs routinely discuss care and are care communication, 6+ yr); the ELSE branch
    // (discipline/location/on_call) is care_related too. Only the tenant-wide `announcement`
    // channel is operational. `bereavement` carries its own class + a pre-computed archive.
    kindSubjectShape: check(
      "channel_kind_subject_shape",
      sql`
      CASE channel_kind
        WHEN 'care_team'    THEN subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
        WHEN 'bereavement'  THEN subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'bereavement' AND archives_at IS NOT NULL
        WHEN 'dm'           THEN subject_id IS NULL AND dm_participant_key IS NOT NULL AND retention_class = 'care_related'
        WHEN 'group'        THEN subject_id IS NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
        WHEN 'announcement' THEN subject_id IS NULL AND dm_participant_key IS NULL AND retention_class = 'operational'
        ELSE                     subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
      END
    `,
    ),
  }),
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
