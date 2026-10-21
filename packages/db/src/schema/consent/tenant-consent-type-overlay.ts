// @chartwarden/db — `tenant_consent_type_overlay` (M39 Consent §3.3 #2). The per-org TIGHTEN-ONLY
// overlay on a platform consent type (D2/D8): a shorter expiration, a narrowed capture-method
// subset, MORE reminders (never fewer), a non-loosening state addendum, a stricter jurisdiction
// requirement. Org-scoped (not PHI — no patient field) → standard app.org_id RLS in M39-T03. The
// tighten-only invariant is enforced in the service layer (§2.3), not as a CHECK (it compares to
// the platform floor row). One overlay per (org, type).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { consentTypeKey } from "../../enums";
import { organizations } from "../organizations";
import { consentTypeCatalog } from "./consent-type-catalog";

export const tenantConsentTypeOverlay = pgTable(
  "tenant_consent_type_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    typeKey: consentTypeKey("type_key")
      .notNull()
      .references(() => consentTypeCatalog.typeKey, { onDelete: "restrict" }),
    tighterExpirationSeconds: integer("tighter_expiration_seconds"), // ≤ catalog default
    tighterCaptureMethods: text("tighter_capture_methods").array(), // subset of floor
    tighterReminderCadence: text("tighter_reminder_cadence").array(), // superset of floor
    stateAddendumText: text("state_addendum_text"), // non-loosening
    jurisdictionCodeRequired: boolean("jurisdiction_code_required"), // may tighten true; can't relax false
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedById: uuid("published_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOrgType: uniqueIndex("uq_tcto_org_type").on(t.organizationId, t.typeKey),
    orgIdx: index("ix_tcto_org").on(t.organizationId),
    expirationNonNegative: check(
      "tcto_expiration_non_negative",
      sql`${t.tighterExpirationSeconds} IS NULL OR ${t.tighterExpirationSeconds} > 0`,
    ),
  }),
);

export type TenantConsentTypeOverlay = typeof tenantConsentTypeOverlay.$inferSelect;
export type NewTenantConsentTypeOverlay = typeof tenantConsentTypeOverlay.$inferInsert;
