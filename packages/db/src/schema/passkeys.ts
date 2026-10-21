// @chartwarden/db — `passkey` (M2 Identity §3.4). A user's registered WebAuthn credential.
// Like `two_factor`, passkeys are USER-level and work at every org the user belongs to
// (M02-F01), so this table is user-owned and NON_ORG_SCOPED in check-tenancy.ts —
// protected by a user-ownership RLS predicate, not by `app.org_id`. Only the public key
// + credential metadata are stored; the private key never leaves the authenticator.
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const passkey = pgTable(
  "passkey",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Nullable (migration 0234, F-081): a user-given label, e.g. "iPhone Face ID". Better Auth's
    // passkey plugin takes it as OPTIONAL and inserts the column default when absent, and this was
    // NOT NULL with no default — so every enrolment 23502'd and the platform's only enrollable
    // step-up factor could not be enrolled at all. The management screen already renders
    // `name ?? "Passkey"`.
    name: text("name"),
    credentialId: text("credential_id").notNull(), // base64url
    publicKey: text("public_key").notNull(), // COSE public key, base64url
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    deviceType: text("device_type"), // singleDevice | multiDevice
    backedUp: boolean("backed_up").notNull().default(false),
    transports: jsonb("transports").notNull().default([]), // ["internal","hybrid",...]
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // AUTH-T06 (ADR-0033): Better Auth passkey-model column (authenticator AAGUID). Full passkey
    // field reconciliation + enrollment is a follow-up alongside the 2FA-encryption (Option C) work.
    aaguid: text("aaguid"),
  },
  (t) => ({
    credUnique: uniqueIndex("passkey_credential_id_idx").on(t.credentialId),
    userIdx: index("passkey_user_idx").on(t.userId),
  }),
);

export type Passkey = typeof passkey.$inferSelect;
export type NewPasskey = typeof passkey.$inferInsert;
