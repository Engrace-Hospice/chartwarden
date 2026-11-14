import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { m23MacJurisdiction } from "./types";

/** Non-secret, organization-scoped Medicare routing facts. Intervals are inclusive; overlap is guarded in SQL. */
export const medicareProviderRouting = pgTable(
  "medicare_provider_routing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical M40 reference, checked by the service
    macJurisdiction: m23MacJurisdiction("mac_jurisdiction").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"), // inclusive; NULL means no known end
    provenance: text("provenance").notNull(),
    sourceLegacyCredentialId: uuid("source_legacy_credential_id"),
    setByMembershipId: uuid("set_by_membership_id").notNull(),
    setReason: text("set_reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byProvider: index("medicare_provider_routing_lookup_idx").on(t.organizationId, t.providerEntityId, t.effectiveFrom),
    legacyUnique: uniqueIndex("medicare_provider_routing_legacy_source_uq").on(t.sourceLegacyCredentialId).where(sql`source_legacy_credential_id IS NOT NULL`),
    validity: check("medicare_provider_routing_validity_ck", sql`effective_to IS NULL OR effective_to >= effective_from`),
    provenanceCheck: check("medicare_provider_routing_provenance_ck", sql`provenance IN ('manual', 'legacy_mac_credential')`),
    reasonCheck: check("medicare_provider_routing_reason_ck", sql`set_reason IN ('provider_documentation', 'cms_notice', 'legacy_review', 'correction', 'legacy_import_unverified')`),
  }),
);

/** Durable, non-secret migration exceptions; resolved only by an administrator configuring routing explicitly. */
export const medicareProviderRoutingBackfillIssue = pgTable(
  "medicare_provider_routing_backfill_issue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id"),
    legacyCredentialId: uuid("legacy_credential_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    candidateJurisdictions: text("candidate_jurisdictions").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ legacyUnique: uniqueIndex("medicare_provider_routing_issue_legacy_idx").on(t.legacyCredentialId) }),
);
