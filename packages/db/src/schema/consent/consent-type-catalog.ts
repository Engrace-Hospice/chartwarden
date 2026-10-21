// @chartwarden/db — `consent_type_catalog` (M39 Consent §3.3 #1). PLATFORM-SHARED reference: the ten
// v1 consent types + the post-mortem bereavement type + the tenant `custom` slot, each with its
// typed scope discriminator, platform-floor expiration / capture / reminder policy, and the M22
// form-template binding. Dual-grant pattern (M40 §3.6): PLATFORM-scope writes only, read-all within
// any tenant — so it carries NO organization_id by design (allow-listed in check-tenancy's
// NON_ORG_SCOPED, like M38's code_system). Seeded idempotently in M39-T09 / the migration §3.4.
// RLS dual-grant + the platform-shared role land in M39-T03 (§3.5).
import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { consentScopeDiscriminator, consentTypeKey } from "../../enums";

export const consentTypeCatalog = pgTable(
  "consent_type_catalog",
  {
    typeKey: consentTypeKey("type_key").primaryKey(),
    displayNameEn: text("display_name_en").notNull(),
    scopeDiscriminator: consentScopeDiscriminator("scope_discriminator").notNull(),
    defaultExpirationSeconds: integer("default_expiration_seconds"), // null = indefinite
    maxTermSeconds: integer("max_term_seconds"), // platform-floor ceiling
    captureMethodFloor: text("capture_method_floor").array().notNull(), // consent_capture_method[]
    reminderCadenceFloor: text("reminder_cadence_floor").array().notNull(), // consent_reminder_kind[]
    revocationCascadeKind: text("revocation_cascade_kind").notNull(),
    isPerRecipient: boolean("is_per_recipient").notNull(),
    isPerNamedAgent: boolean("is_per_named_agent").notNull(),
    isPostMortemEligible: boolean("is_post_mortem_eligible").notNull(),
    requiresJurisdictionCode: boolean("requires_jurisdiction_code").notNull(),
    cfr42Part2Compliant: boolean("cfr_42_part_2_compliant").notNull(),
    hipaa164508Compliant: boolean("hipaa_164_508_compliant").notNull(),
    bodyTextTemplateKey: text("body_text_template_key").notNull(), // M22 form-template key
    m22TemplateVersion: text("m22_template_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeIdx: index("consent_type_catalog_scope_idx").on(t.scopeDiscriminator),
  }),
);

export type ConsentTypeCatalog = typeof consentTypeCatalog.$inferSelect;
export type NewConsentTypeCatalog = typeof consentTypeCatalog.$inferInsert;
