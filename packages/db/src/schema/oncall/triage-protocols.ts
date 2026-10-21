// @chartwarden/db — `triage_protocol` (M19 §3.3). D4's hybrid catalog: a PLATFORM FLOOR of ≥25 protocols
// (organization_id IS NULL, system-locked, seeded by the migration) that every tenant reads and none may
// edit, plus tenant rows ABOVE the floor that a tenant owns outright. Versions are first-class — a
// revision is a NEW row with its own effective window, so a call in flight keeps the question set it
// started with (D4 alternative (d) is exactly what the effective-dating prevents).
//
// TENANCY (ADR-0010 D2 / the M21 `comfort_kit_template` precedent): organization_id is NULLABLE on the
// platform-floor row ONLY, paired with the `is_system_locked` discriminator and the CHECK pair below.
// Enforcing only one direction would let an org-less TENANT protocol exist — invisible to its own tenant
// under RLS and readable by every other one. The floor is read through a SELECT policy that also admits
// `organization_id IS NULL`; INSERT/UPDATE admit only the tenant's own unlocked rows (migration 0108).
// This is org-level CATALOG configuration, not patient data: no PE, no location, never erased.
//
// DEVIATION FROM §3.3 (documented, narrow): `mandatory_escalation_tier` is the `triage_escalation_tier`
// ENUM, not `text`. D7 makes this column the routing target for the four mandatory-escalation protocols
// (suicidal ideation, suspected abuse, unresponsive patient, suspected death); as `text` a typo'd
// 'tier_3_medical-director' is accepted at write and discovered at 2 a.m. when the escalation router finds
// no tier. The values are the same enum `triage_escalation.tier` already uses.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { triageEscalationTier } from "../../enums";
import { organizations } from "../organizations";

export const triageProtocol = pgTable(
  "triage_protocol",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NULL ⇔ platform-floor row (see the CHECK pair). */
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),

    key: text("key").notNull(),
    chiefComplaintLabel: text("chief_complaint_label").notNull(),
    /** M38-validated SNOMED finding/symptom code; `lookup` is an `asOfDate` read so a 2027 revision does
     *  not retroactively rewrite a 2026 record. */
    snomedCode: text("snomed_code").notNull(),
    /** The minimum discipline that may run this protocol (the §7.3 LPN scope-of-practice gate). */
    disciplineRequired: text("discipline_required").notNull(),

    /** TRUE ⇔ platform floor (see the CHECK pair). A tenant may never set it. */
    isSystemLocked: boolean("is_system_locked").notNull().default(false),
    /** D7 — applying this protocol writes the escalation row in the SAME transaction; it cannot be
     *  skipped, and a tenant cannot clear the flag on a floor row it cannot write. */
    requiresMandatoryEscalation: boolean("requires_mandatory_escalation").notNull().default(false),
    mandatoryEscalationTier: triageEscalationTier("mandatory_escalation_tier"),

    version: text("version").notNull().default("1.0"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }),
    sortOrder: integer("sort_order").notNull().default(100),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    platformKeyUq: uniqueIndex("triage_protocol_platform_key_uq")
      .on(t.key)
      .where(sql`organization_id IS NULL AND effective_to IS NULL`),
    tenantKeyUq: uniqueIndex("triage_protocol_tenant_key_uq")
      .on(t.organizationId, t.key)
      .where(sql`organization_id IS NOT NULL AND effective_to IS NULL`),
    // D7 — a mandatory-escalation protocol with no tier routes to nobody.
    mandatoryEscIntegrity: check(
      "m19_triage_protocol_mandatory_tier",
      sql`"requires_mandatory_escalation" = false OR "mandatory_escalation_tier" IS NOT NULL`,
    ),
    // The floor pair (M21 `comfort_kit_template` precedent), both directions.
    floorIsOrgless: check(
      "m19_triage_protocol_floor_orgless",
      sql`"is_system_locked" = false OR "organization_id" IS NULL`,
    ),
    tenantHasOrg: check(
      "m19_triage_protocol_tenant_has_org",
      sql`"is_system_locked" = true OR "organization_id" IS NOT NULL`,
    ),
    effectiveWindow: check(
      "m19_triage_protocol_effective_window",
      sql`"effective_to" IS NULL OR "effective_to" > "effective_from"`,
    ),
  }),
);

export type TriageProtocolRow = typeof triageProtocol.$inferSelect;
export type NewTriageProtocolRow = typeof triageProtocol.$inferInsert;
