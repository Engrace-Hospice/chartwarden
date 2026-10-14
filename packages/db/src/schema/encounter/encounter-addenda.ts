// @wardenx/db — `encounter_addendum` (M8 §3.3). A correction/amendment drafted on a signed encounter
// (§2.4). PHI-bearing → three-column tenancy rule (provider_entity_id + location_id NOT NULL,
// denormalized from the parent encounter). `reason` is clinician free-text → denylisted in the M4
// write-audit trigger (M8-T03). RLS + trigger land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { encounterStatus } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounters } from "./encounters";

export const encounterAddenda = pgTable(
  "encounter_addendum",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0128 (M8L-T02): denormalized siting backfills from the parent encounter.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),

    authoredByMembershipId: uuid("authored_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),

    status: encounterStatus("status").notNull().default("draft"),
    signedAt: timestamp("signed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),

    // WP 3.7 (migration 1102): attribution when the addendum was authored from a secure message proposed for the chart.
    // All-or-none, immutable, and an insert guard proves it equals the proposal it claims. No message text is stored here.
    promotionRequestId: uuid("promotion_request_id"),
    sourceMessageId: uuid("source_message_id"),
    sourceAuthorUserId: uuid("source_author_user_id"),
    sourceSentAt: timestamp("source_sent_at", { withTimezone: true }),
    sourceBodySha256: text("source_body_sha256"),
  },
  (t) => ({
    encounterIdx: index("encounter_addendum_encounter_idx").on(t.encounterId, t.createdAt),
    reasonLen: check("encounter_addendum_reason_len", sql`char_length(reason) >= 20`),
    // Widened in mig 0128 (M8L-T02) to include 'finalized' — the §2.3 addendum machine is
    // draft → finalized → signed, and the DB is the machine's store (the `sign` transitions from
    // 'finalized', so it must be persistable). 'finalized' is already a legal encounter_status value.
    statusAllowed: check(
      "encounter_addendum_status_allowed",
      sql`status IN ('draft','finalized','signed','voided')`,
    ),
    signedHasTime: check(
      "encounter_addendum_signed_has_time",
      sql`(status <> 'signed') OR (signed_at IS NOT NULL)`,
    ),
    promotionShape: check(
      "encounter_addendum_promotion_shape",
      sql`(${t.promotionRequestId} IS NULL) = (${t.sourceMessageId} IS NULL) AND (${t.promotionRequestId} IS NULL) = (${t.sourceAuthorUserId} IS NULL) AND (${t.promotionRequestId} IS NULL) = (${t.sourceSentAt} IS NULL) AND (${t.promotionRequestId} IS NULL) = (${t.sourceBodySha256} IS NULL)`,
    ),
    promotionShaShape: check(
      "encounter_addendum_promotion_sha_shape",
      sql`${t.sourceBodySha256} IS NULL OR ${t.sourceBodySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    promotionOnce: uniqueIndex("encounter_addendum_promotion_uq")
      .on(t.organizationId, t.promotionRequestId)
      .where(sql`${t.promotionRequestId} IS NOT NULL AND ${t.status} <> 'voided'`),
  }),
);

export type EncounterAddendum = typeof encounterAddenda.$inferSelect;
export type NewEncounterAddendum = typeof encounterAddenda.$inferInsert;
