// @wardenx/db — `message` (M36 Secure Messaging §3.4). The org-scoped, encrypted message row.
// `body_cipher` is envelope-encrypted under the tenant DEK (bytea); `body_sha256` is the hex
// SHA-256 of the PLAINTEXT body computed PRE-ENCRYPTION at write time and re-computed on edit
// (M36-F03 / ARCH-206 / ARCH-240 — HIPAA §164.312(c) integrity). The §4.4 hash-verification
// job decrypts each cipher and asserts the digest matches; mismatches are logged as
// `m36.integrity.hash_mismatch`. On delete the row is a TOMBSTONE — status flips to 'deleted'
// + deleted_at is set, but body_cipher is RETAINED through the retention window (M36-F02 /
// ADR-0004 / §164.530(j)); body_sha256 is likewise never zeroed. RLS + the M4 write-audit
// trigger land in M36-T03. Org-scoped (organization_id) but not subject to the three-column
// PE/location rule — it carries no patient field, only the channel reference.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { messageAuthorKind, messageBodyKind, messageStatus } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { channels } from "./channels";

// Envelope-encrypted message body, stored as PostgreSQL bytea.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const messages = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id").notNull(), // composite FK (organization_id, channel_id) below
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    authorUserId: uuid("author_user_id").references(() => users.id), // null = system author
    authorKind: messageAuthorKind("author_kind").notNull(),
    bodyCipher: bytea("body_cipher").notNull(), // envelope-encrypted under tenant DEK
    bodySha256: text("body_sha256").notNull(), // hex SHA-256 of plaintext pre-encryption
    bodyKind: messageBodyKind("body_kind").notNull().default("plain"),
    parentMessageId: uuid("parent_message_id"), // composite same-channel FK below (1083)
    quotedMessageId: uuid("quoted_message_id"), // composite same-channel FK below (1083)
    // WP 1.2: client-minted, stable across retries; the DB backstop behind the Idempotency-Key middleware.
    clientMessageId: uuid("client_message_id"),
    status: messageStatus("status").notNull().default("sent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    byChannelCreatedIdx: index("message_channel_created_idx").on(t.channelId, t.createdAt),
    byAuthorIdx: index("message_author_idx")
      .on(t.authorUserId)
      .where(sql`author_user_id IS NOT NULL`),
    byOrgIdx: index("message_org_idx").on(t.organizationId),
    // 1080: keyset paging for the hash_verify rotation (tenant, created_at, id).
    byOrgCreatedIdIdx: index("message_org_created_id_idx").on(t.organizationId, t.createdAt, t.id),
    orgIdIdUnique: unique("message_org_id_id_unique").on(t.organizationId, t.id),
    // 1083 (WP 2.2 / D6): the referenced side of the same-channel reply/quote edges below.
    orgChannelIdUnique: unique("message_org_channel_id_unique").on(
      t.organizationId,
      t.channelId,
      t.id,
    ),
    // 1072: every edge carries organization_id, so the database (not only the app) refuses a
    // cross-tenant link; an FK check bypasses RLS, a composite FK cannot.
    channelOrgFk: foreignKey({
      name: "message_channel_org_fk",
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete("restrict"),
    // 1083: a reply's parent and a quote's target must be in the SAME channel (and org); the database refuses
    // anything else, whatever the caller (supersedes the (organization_id, id) edges of 1072).
    parentChannelFk: foreignKey({
      name: "message_parent_channel_fk",
      columns: [t.organizationId, t.channelId, t.parentMessageId],
      foreignColumns: [t.organizationId, t.channelId, t.id],
    }),
    quotedChannelFk: foreignKey({
      name: "message_quoted_channel_fk",
      columns: [t.organizationId, t.channelId, t.quotedMessageId],
      foreignColumns: [t.organizationId, t.channelId, t.id],
    }),
    byOrgChannelIdx: index("message_org_channel_idx").on(t.organizationId, t.channelId),
    // 1083: FK-supporting and the thread-read / reply-count index (replaces 1072's narrower pair).
    byOrgChannelParentIdx: index("message_org_channel_parent_idx")
      .on(t.organizationId, t.channelId, t.parentMessageId, t.createdAt, t.id)
      .where(sql`parent_message_id IS NOT NULL`),
    byOrgChannelQuotedIdx: index("message_org_channel_quoted_idx")
      .on(t.organizationId, t.channelId, t.quotedMessageId)
      .where(sql`quoted_message_id IS NOT NULL`),
    clientMessageUnique: unique("message_client_message_unique").on(
      t.organizationId,
      t.authorUserId,
      t.clientMessageId,
    ),
    byParentIdx: index("message_parent_idx")
      .on(t.parentMessageId)
      .where(sql`parent_message_id IS NOT NULL`),
    authorShape: check(
      "message_author_shape",
      sql`(author_kind = 'user') = (author_user_id IS NOT NULL)`,
    ),
    // M36-F02: 'deleted' merely flips status + sets deleted_at; the cipher is retained.
    statusShape: check(
      "message_status_shape",
      sql`
      (status = 'edited') = (edited_at IS NOT NULL)
      AND (status = 'deleted') = (deleted_at IS NOT NULL)
    `,
    ),
    // M36-F03: body_sha256 must be a 64-char lowercase hex string (SHA-256).
    sha256Shape: check("message_sha256_shape", sql`body_sha256 ~ '^[0-9a-f]{64}$'`),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
