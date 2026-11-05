// @chartwarden/db — `provider_npi_verification` (M23 Billing-Medicare; ADR-0053 amendment 2026-11-05, precondition 2;
// migration 1326). Platform staff's record that a provider entity owns an NPI. Keyed to the entity AND the NPI value, so a
// changed provider_entity.npi no longer matches and the Claim.MD sweep stops routing to it. Written only on the platform
// login (tenants hold SELECT on their own org's rows); revoked, never deleted. No PHI.
//
// CROSS-MODULE FK POLICY: only `organization_id` (core) gets a real `.references(...)`; `provider_entity_id` is a LOGICAL
// FK resolved from provider_entity by the service before it writes.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const providerNpiVerifications = pgTable(
  "provider_npi_verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    npi: text("npi").notNull(),
    evidence: text("evidence").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedByMembershipId: uuid("verified_by_membership_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByMembershipId: uuid("revoked_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_npi_verification_live_uq")
      .on(t.providerEntityId)
      .where(sql`${t.revokedAt} is null`),
    index("provider_npi_verification_entity_ix").on(t.providerEntityId, t.npi, t.verifiedAt),
    index("provider_npi_verification_org_ix").on(t.organizationId),
  ],
);

export type ProviderNpiVerificationRow = typeof providerNpiVerifications.$inferSelect;
