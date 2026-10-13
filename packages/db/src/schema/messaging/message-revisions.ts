// M36 WP 1.3 / ADR-0055 — append-only revision chain. Revision n is the body edit n replaced (1 = the original);
// the head lives on `message`. The app role has SELECT + INSERT only (see migration 1070).
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { messageBodyKind } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
import { messages } from "./messages";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const messageRevisions = pgTable(
  "message_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").notNull(),
    revisionNo: integer("revision_no").notNull(),
    bodyCipher: bytea("body_cipher").notNull(),
    bodySha256: text("body_sha256").notNull(),
    // 1089 (WP 2.13): GENERATED from body_cipher's first byte: 0 erased, 1 legacy HKDF envelope, 2 M34 ring envelope.
    bodyEnvelopeVersion: smallint("body_envelope_version").generatedAlwaysAs(
      sql`CASE WHEN octet_length(body_cipher) = 0 THEN 0 ELSE get_byte(body_cipher, 0) END`,
    ),
    bodyKind: messageBodyKind("body_kind").notNull(),
    referencesSnapshot: jsonb("references_snapshot").notNull().default(sql`'[]'::jsonb`),
    bodyWrittenAt: timestamp("body_written_at", { withTimezone: true }).notNull(),
    editedBy: uuid("edited_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueNo: unique("message_revision_unique_no").on(t.organizationId, t.messageId, t.revisionNo),
    byEditor: index("message_revision_edited_by_idx").on(t.editedBy),
    // 1080: hash_verify rotation (keyset) and its by-primary-key random page, both within a tenant.
    byOrgCreatedIdIdx: index("message_revision_org_created_id_idx").on(
      t.organizationId,
      t.createdAt,
      t.id,
    ),
    byOrgIdIdx: index("message_revision_org_id_idx").on(t.organizationId, t.id),
    // 1089: the legacy-envelope revisions only (see message_body_legacy_idx).
    legacyBodyIdx: index("message_revision_body_legacy_idx")
      .on(t.organizationId, t.id)
      .where(sql`body_envelope_version = 1`),
    messageOrgFk: foreignKey({
      name: "message_revision_message_org_fk",
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete("cascade"),
    noPositive: check("message_revision_no_positive", sql`${t.revisionNo} >= 1`),
    sha256Shape: check("message_revision_sha256_shape", sql`${t.bodySha256} ~ '^[0-9a-f]{64}$'`),
  }),
);

export type MessageRevision = typeof messageRevisions.$inferSelect;
export type NewMessageRevision = typeof messageRevisions.$inferInsert;
