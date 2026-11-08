// @chartwarden/db — `tenant_clearinghouse_credential_reservation` (M23 Billing-Medicare; migration 1404). Every credential a tenant
// sealed, held to that tenant until a platform operator releases it: the partial unique index spans organizations, so a second
// organization cannot seal a key another one holds (switching to `outside` or rotating does NOT free it). The fingerprint is a keyed
// HMAC (never a plain hash), never returned or audited. The migration's CHECKs and final-row trigger are the authority.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantClearinghouseCredentialReservation = pgTable(
  "tenant_clearinghouse_credential_reservation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vendor: text("vendor").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    /** Public id of the fingerprint key (migration 1405); null = recorded before 1405 under the KEK current then. */
    credentialFingerprintKeyId: text("credential_fingerprint_key_id"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedByUserId: uuid("released_by_user_id"),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenant_clearinghouse_credential_reservation_held_uq")
      .on(t.credentialFingerprint)
      .where(sql`released_at IS NULL`),
    index("tenant_clearinghouse_credential_reservation_org_idx").on(t.organizationId, t.releasedAt),
  ],
);

export type TenantClearinghouseCredentialReservationRow =
  typeof tenantClearinghouseCredentialReservation.$inferSelect;
