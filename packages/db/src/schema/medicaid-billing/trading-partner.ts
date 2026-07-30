// @wardenx/db — M24 Billing — Medicaid §3.3 — per-PE per-state per-channel trading-partner credentials
// (NON-partitioned; org/PE-level configuration, NOT patient PHI). Mirrors M23's mac_submitter_credential.
// All *_cipher columns are KMS-wrapped under the per-tenant DEK (M1 §6) and audit-denylisted (§3.6).
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id (M1 core) get real FKs; mco_id (M40) is logical.
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { m24Channel } from "./enums";

export const stateMedicaidTradingPartnerCredential = pgTable(
  "state_medicaid_trading_partner_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    serviceState: varchar("service_state", { length: 2 }).notNull(),
    channel: m24Channel("channel").notNull(),
    mcoId: uuid("mco_id"), // logical FK → M40 (when channel='cco_clearinghouse')

    tradingPartnerId: varchar("trading_partner_id", { length: 64 }).notNull(),
    clientId: varchar("client_id", { length: 128 }),
    clientSecretCipher: text("client_secret_cipher"), // KMS-wrapped (denylisted)
    sftpHost: varchar("sftp_host", { length: 200 }),
    sftpUser: varchar("sftp_user", { length: 64 }),
    sftpKeyCipher: text("sftp_key_cipher"), // KMS-wrapped (denylisted)
    portalUrl: text("portal_url"),
    additionalConfigCipher: text("additional_config_cipher"), // KMS-wrapped (denylisted)

    activeFrom: timestamp("active_from", { withTimezone: true, mode: "date" }).notNull(),
    activeTo: timestamp("active_to", { withTimezone: true, mode: "date" }),

    lastSandboxTestAt: timestamp("last_sandbox_test_at", { withTimezone: true }),
    lastSandboxTestResult: varchar("last_sandbox_test_result", { length: 32 }),
    lastSandboxTestError: text("last_sandbox_test_error"),

    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    updatedByMembershipId: uuid("updated_by_membership_id").notNull(),
  },
  (t) => ({
    byPeState: index("state_medicaid_tp_by_pe_state").on(t.providerEntityId, t.serviceState),
    activeRange: check(
      "state_medicaid_tp_active_range",
      sql`active_to IS NULL OR active_from <= active_to`,
    ),
  }),
);
