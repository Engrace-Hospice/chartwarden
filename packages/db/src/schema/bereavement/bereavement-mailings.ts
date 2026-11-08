// @chartwarden/db — the M16 MAILING program (ADR-0109 D10, migration 1374): `bereavement_mailing_config`, `bereavement_mailing_run`,
// `bereavement_mailing_item`.
//
// CONFIG (one row per mailing key per tenant) and RUN (one batch per occurrence) are ORG-LEVEL: one batch spans every provider entity of the
// tenant, so neither carries provider_entity_id / location_id (the `tenant_bereavement_external_source_gate_override` precedent; ARCH-011's
// three-column rule applies to the rows that name a person). ITEM names a plan and a contact and carries the three columns, denormalized from
// the plan. No default wording ships: `content_jsonb` starts empty and generation refuses empty content.
//
// The run's `rendered_document_id` is the M22 batch PDF - a LOGICAL uuid. That PDF holds every recipient's name and address, so it is an
// INTERNAL-ONLY document (aggregate type `bereavement_mailing_batch`, migration 1375). Rows here hold counts and ids, never an address.
// The item's `log_id` is the activity row the sweep wrote on the (partitioned) contact log: logical, no FK.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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

/** `bereavement_mailing_config.mailing_key` / `bereavement_mailing_run.mailing_key`. `decedent_birthday` is deferred (nothing builds it). */
export const BEREAVEMENT_MAILING_KEYS = [
  "newsletter_quarterly",
  "holiday_december",
  "mothers_day",
  "fathers_day",
  "decedent_birthday",
] as const;
export const BEREAVEMENT_MAILING_RUN_KINDS = [
  "newsletter",
  "holiday",
  "memorial_invitation",
] as const;
export const BEREAVEMENT_MAILING_RUN_STATUSES = [
  "draft",
  "generating",
  "ready",
  "mailed",
  "cancelled",
  "failed",
] as const;
export const BEREAVEMENT_MAILING_CHANNELS = ["postal", "email"] as const;
export const BEREAVEMENT_MAILING_ITEM_STATUSES = [
  "included",
  "excluded",
  "logged",
  "excluded_after_render",
  "email_sent",
  "email_failed",
] as const;
/** Why an item was excluded (the item CHECK mirrors this list; the pure `decideMailingEligibility` returns exactly these). */
export const BEREAVEMENT_MAILING_EXCLUSION_REASONS = [
  "plan_not_active",
  "contact_not_engageable",
  "opted_out",
  "no_mailings",
  "channel_opted_out",
  "channel_not_allowed",
  "no_mailing_address",
  "no_email_address",
  "email_channel_unavailable",
  "not_in_audience",
] as const;

const KEY_SQL = sql`'newsletter_quarterly','holiday_december','mothers_day','fathers_day','decedent_birthday'`;

export const bereavementMailingConfig = pgTable(
  "bereavement_mailing_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    mailingKey: text("mailing_key", { enum: BEREAVEMENT_MAILING_KEYS }).notNull(),
    enabled: boolean("enabled").notNull().default(false),
    leadDays: integer("lead_days").notNull().default(10),
    // Tenant overrides of the occurrence dates (`{ monthDays: ["01-15", ...] }` for the newsletter, `{ monthDay: "12-15" }` for December).
    scheduleJsonb: jsonb("schedule_jsonb").notNull().default(sql`'{}'::jsonb`),
    audienceRelationships: text("audience_relationships").array(), // NULL = every relationship
    contentJsonb: jsonb("content_jsonb").notNull().default(sql`'{}'::jsonb`), // {en:{title,greeting,paragraphs[],signoff}}; audit-denylisted
    configuredByMembershipId: uuid("configured_by_membership_id").notNull(), // logical M2 membership
    version: integer("version").notNull().default(0), // If-Match
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgKeyUniq: uniqueIndex("berv_mailing_config_org_key_uniq").on(t.organizationId, t.mailingKey),
    keyValues: check("berv_mailing_config_key_chk", sql`mailing_key IN (${KEY_SQL})`),
    leadRange: check("berv_mailing_config_lead_chk", sql`lead_days BETWEEN 3 AND 60`),
  }),
);

export const bereavementMailingRun = pgTable(
  "bereavement_mailing_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    runKind: text("run_kind", { enum: BEREAVEMENT_MAILING_RUN_KINDS }).notNull(),
    mailingKey: text("mailing_key", { enum: BEREAVEMENT_MAILING_KEYS }),
    occurrenceKey: text("occurrence_key").notNull(), // `<mailing key>:<scheduled date>` for the newsletter (e.g. `newsletter_quarterly:2026-10-15`), `<mailing key>:<year>` for the annual ones (e.g. `holiday_december:2026`); UNIQUE per org
    sourceRefId: uuid("source_ref_id"), // a memorial service id (a later PR)
    scheduledFor: date("scheduled_for").notNull(),
    status: text("status", { enum: BEREAVEMENT_MAILING_RUN_STATUSES }).notNull().default("draft"),
    contentJsonb: jsonb("content_jsonb").notNull(), // the wording SNAPSHOT the batch renders from; audit-denylisted
    renderedDocumentId: uuid("rendered_document_id"), // logical M22 document (the batch PDF; internal-only)
    recipientCount: integer("recipient_count").notNull().default(0),
    excludedCount: integer("excluded_count").notNull().default(0),
    failureCode: text("failure_code"),
    generatedByMembershipId: uuid("generated_by_membership_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    mailedByMembershipId: uuid("mailed_by_membership_id"),
    mailedAt: timestamp("mailed_at", { withTimezone: true }),
    version: integer("version").notNull().default(0), // If-Match
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    occurrenceUniq: uniqueIndex("berv_mailing_run_occurrence_uniq").on(
      t.organizationId,
      t.occurrenceKey,
    ),
    orgScheduledIdx: index("berv_mailing_run_org_sched_idx").on(
      t.organizationId,
      sql`${t.scheduledFor} DESC`,
      sql`${t.id} DESC`,
    ),
    mailedIdx: index("berv_mailing_run_mailed_idx")
      .on(t.organizationId, t.mailedAt)
      .where(sql`status = 'mailed'`),
    kindValues: check(
      "berv_mailing_run_kind_chk",
      sql`run_kind IN ('newsletter','holiday','memorial_invitation')`,
    ),
    keyValues: check(
      "berv_mailing_run_key_chk",
      sql`mailing_key IS NULL OR mailing_key IN (${KEY_SQL})`,
    ),
    statusValues: check(
      "berv_mailing_run_status_chk",
      sql`status IN ('draft','generating','ready','mailed','cancelled','failed')`,
    ),
    counts: check("berv_mailing_run_counts_chk", sql`recipient_count >= 0 AND excluded_count >= 0`),
    readyHasDocument: check(
      "berv_mailing_run_ready_chk",
      sql`status NOT IN ('ready','mailed') OR rendered_document_id IS NOT NULL`,
    ),
    mailedStamp: check(
      "berv_mailing_run_mailed_chk",
      sql`(status = 'mailed') = (mailed_at IS NOT NULL AND mailed_by_membership_id IS NOT NULL)`,
    ),
    failedHasCode: check(
      "berv_mailing_run_failed_chk",
      sql`status <> 'failed' OR failure_code IS NOT NULL`,
    ),
  }),
);

export const bereavementMailingItem = pgTable(
  "bereavement_mailing_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => bereavementMailingRun.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),
    bereavedContactId: uuid("bereaved_contact_id")
      .notNull()
      .references(() => bereavedContact.id, { onDelete: "restrict" }),
    channel: text("channel", { enum: BEREAVEMENT_MAILING_CHANNELS }).notNull(),
    status: text("status", { enum: BEREAVEMENT_MAILING_ITEM_STATUSES }).notNull(),
    exclusionReason: text("exclusion_reason", { enum: BEREAVEMENT_MAILING_EXCLUSION_REASONS }),
    ordinal: integer("ordinal"), // the letter's position in the batch PDF
    logId: uuid("log_id"), // the activity row on the partitioned contact log (logical)
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runContactUniq: uniqueIndex("berv_mailing_item_run_contact_uniq").on(
      t.runId,
      t.bereavedContactId,
    ),
    runOrdinalUniq: uniqueIndex("berv_mailing_item_run_ordinal_uniq")
      .on(t.runId, t.ordinal)
      .where(sql`ordinal IS NOT NULL`),
    runStatusIdx: index("berv_mailing_item_run_status_idx").on(t.runId, t.status),
    planIdx: index("berv_mailing_item_plan_idx").on(t.planId),
    contactIdx: index("berv_mailing_item_contact_idx").on(t.bereavedContactId),
    orgIdx: index("berv_mailing_item_org_ix").on(t.organizationId, t.createdAt),
    providerEntityIdx: index("berv_mailing_item_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("berv_mailing_item_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),
    channelValues: check("berv_mailing_item_channel_chk", sql`channel IN ('postal','email')`),
    statusValues: check(
      "berv_mailing_item_status_chk",
      sql`status IN ('included','excluded','logged','excluded_after_render','email_sent','email_failed')`,
    ),
    excludedHasReason: check(
      "berv_mailing_item_excluded_chk",
      sql`(status IN ('excluded','excluded_after_render')) = (exclusion_reason IS NOT NULL)`,
    ),
    attempts: check("berv_mailing_item_attempts_chk", sql`attempts >= 0`),
  }),
);

export type BereavementMailingConfigRow = typeof bereavementMailingConfig.$inferSelect;
export type BereavementMailingRunRow = typeof bereavementMailingRun.$inferSelect;
export type BereavementMailingItemRow = typeof bereavementMailingItem.$inferSelect;
