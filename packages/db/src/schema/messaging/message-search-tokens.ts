// M36 WP 2.7b chunk C1 (ADR-0058) - the global blind-token search index (migration 1091; 1096 adds `channel_id` and the name
// exclusion columns). `message_search_token` has EXACTLY five columns and no surrogate key: a T-bit truncated HMAC (or a random
// dummy) per (message, key version), keyed PER CHANNEL, with the channel id in the clear (migration 1096). `tag` is derived data and never leaves the index path: never logged, never audited. wardenx_app
// has no UPDATE. RLS (FORCE) on organization_id, the statement-level audit trigger and the removal hook are in the migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

export const messageSearchTokens = pgTable(
  "message_search_token",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    keyVersion: text("key_version").notNull(),
    /** = message.channel_id (a message never changes channel); the key of the tag is derived per channel. Not a FK. */
    channelId: uuid("channel_id").notNull(),
    tag: integer("tag").notNull(),
    messageId: uuid("message_id").notNull(),
  },
  (t) => ({
    lookupIdx: index("message_search_token_lookup_idx").on(
      t.organizationId,
      t.keyVersion,
      t.channelId,
      t.tag,
      t.messageId,
    ),
    orgMessageIdx: index("message_search_token_org_message_idx").on(t.organizationId, t.messageId),
    messageOrgFk: foreignKey({
      name: "message_search_token_message_org_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    tagRange: check("message_search_token_tag_range", sql`${t.tag} >= 0 AND ${t.tag} < 1048576`),
    keyVersionShape: check(
      "message_search_token_key_version_shape",
      sql`char_length(${t.keyVersion}) BETWEEN 1 AND 32`,
    ),
  }),
);

export const messageSearchIndexStates = pgTable(
  "message_search_index_state",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    keyVersion: text("key_version").notNull(),
    tagBits: smallint("tag_bits").notNull().default(19),
    status: text("status").notNull().default("building"),
    checkpointCreatedAt: timestamp("checkpoint_created_at", { withTimezone: true }),
    checkpointMessageId: uuid("checkpoint_message_id"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    distinctTags: integer("distinct_tags"),
    /** Head (channel, tag) pairs as '<channel uuid>:<tag>': bucket numbers only (no plaintext, no token list); scrubbed from the audit images. */
    headBuckets: text("head_buckets").array().notNull().default(sql`'{}'::text[]`),
    /** Keyed digests (HMAC under K_search) of the excluded name tokens: never a name. Scrubbed from the audit images. */
    excludedNameDigests: text("excluded_name_digests").array().notNull().default(sql`'{}'::text[]`),
    /** Digests added since the messages that already contain them were reindexed. Scrubbed from the audit images. */
    exclusionPending: text("exclusion_pending").array().notNull().default(sql`'{}'::text[]`),
    exclusionPendingSince: timestamp("exclusion_pending_since", { withTimezone: true }),
    exclusionSyncedAt: timestamp("exclusion_synced_at", { withTimezone: true }),
    statsAt: timestamp("stats_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      name: "message_search_index_state_pk",
      columns: [t.organizationId, t.keyVersion],
    }),
    keyVersionShape: check(
      "message_search_index_state_key_version_shape",
      sql`char_length(${t.keyVersion}) BETWEEN 1 AND 32`,
    ),
    tagBitsRange: check(
      "message_search_index_state_tag_bits_range",
      sql`${t.tagBits} BETWEEN 12 AND 20`,
    ),
    statusValid: check(
      "message_search_index_state_status_valid",
      sql`${t.status} IN ('building', 'ready', 'stale')`,
    ),
    checkpointPair: check(
      "message_search_index_state_checkpoint_pair",
      sql`(${t.checkpointCreatedAt} IS NULL) = (${t.checkpointMessageId} IS NULL)`,
    ),
    distinctTagsNonneg: check(
      "message_search_index_state_distinct_tags_nonneg",
      sql`${t.distinctTags} IS NULL OR ${t.distinctTags} >= 0`,
    ),
  }),
);

export const tenantMessagingSearchSettings = pgTable(
  "tenant_messaging_search_setting",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /** `messaging.global_search_enabled`; default OFF, and a tenant with no row is OFF. */
    enabled: boolean("enabled").notNull().default(false),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    purgeRequestedAt: timestamp("purge_requested_at", { withTimezone: true }),
    purgeCompletedAt: timestamp("purge_completed_at", { withTimezone: true }),
    /** ADR-0058 review F5: the discoverability notice version the admin acknowledged when last switching ON, who, and when. */
    noticeAckVersion: text("notice_ack_version"),
    noticeAckByUserId: uuid("notice_ack_by_user_id").references(() => users.id),
    noticeAckAt: timestamp("notice_ack_at", { withTimezone: true }),
  },
  (t) => ({
    noticeAckAllOrNone: check(
      "tenant_messaging_search_setting_notice_ack_all_or_none",
      sql`(${t.noticeAckVersion} IS NULL) = (${t.noticeAckByUserId} IS NULL) AND (${t.noticeAckVersion} IS NULL) = (${t.noticeAckAt} IS NULL)`,
    ),
    purgeOrder: check(
      "tenant_messaging_search_setting_purge_order",
      sql`${t.purgeCompletedAt} IS NULL OR ${t.purgeRequestedAt} IS NOT NULL`,
    ),
  }),
);

export type MessageSearchToken = typeof messageSearchTokens.$inferSelect;
export type NewMessageSearchToken = typeof messageSearchTokens.$inferInsert;
export type MessageSearchIndexState = typeof messageSearchIndexStates.$inferSelect;
export type TenantMessagingSearchSetting = typeof tenantMessagingSearchSettings.$inferSelect;
