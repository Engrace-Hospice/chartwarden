// @chartwarden/db — `tenant_clearinghouse_config` (M23 Billing-Medicare; ADR-0053 amendment 2026-11-06; migration 1350).
// The clearinghouse a tenant chose: `stedi`, `claimmd` or `outside` ("bills outside ChartWarden"), its mode, its sealed
// vendor credential and where the config is in draft -> verified -> active. One row per organization. The CHECKs in the
// migration are the authority on which column combinations are legal; this file mirrors the shape for Drizzle.
//
// `secret_cipher` is write-only: no service view ever returns it (a `hasSecret` flag is derived). The membership ids are
// logical FKs (a platform operator's membership lives in the platform org). Only `organization_id` has a real FK.
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantClearinghouseConfig = pgTable(
  "tenant_clearinghouse_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    vendor: text("vendor").notNull(),
    mode: text("mode"),
    status: text("status").notNull().default("draft"),
    secretCipher: text("secret_cipher"),
    secretDekVersion: integer("secret_dek_version"),
    verificationKind: text("verification_kind"),
    verificationEvidence: text("verification_evidence"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOutcome: text("last_test_outcome"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedByMembershipId: uuid("activated_by_membership_id"),
    setByMembershipId: uuid("set_by_membership_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tenant_clearinghouse_config_org_uq").on(t.organizationId)],
);

export type TenantClearinghouseConfigRow = typeof tenantClearinghouseConfig.$inferSelect;
export type NewTenantClearinghouseConfigRow = typeof tenantClearinghouseConfig.$inferInsert;
