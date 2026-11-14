// Encrypted exact X12 bytes for one immutable M23 notice render identity. Plaintext is never stored.
import { customType, pgTable, text, timestamp, uuid, integer, unique } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { medicareNoticeRenderIdentity } from "./medicare-notice-render-identity";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const medicareNoticeRenderArtifact = pgTable("medicare_notice_render_artifact", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  renderIdentityId: uuid("render_identity_id").notNull().references(() => medicareNoticeRenderIdentity.id, { onDelete: "restrict" }),
  ciphertext: bytea("ciphertext").notNull(),
  contentSha256: text("content_sha256").notNull(),
  plaintextByteLength: integer("plaintext_byte_length").notNull(),
  encryptionKeyVersion: text("encryption_key_version").notNull(),
  artifactVersion: text("artifact_version").notNull().default("m23-notice-x12-v1"),
  state: text("state").$type<"finalized" | "corrupt">().notNull().default("finalized"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("medicare_notice_render_artifact_identity_uq").on(t.organizationId, t.renderIdentityId),
]);
