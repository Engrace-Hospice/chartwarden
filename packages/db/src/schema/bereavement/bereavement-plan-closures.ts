// @wardenx/db — `bereavement_plan_closure` (M16 §3.3.7). Exactly one row per closed plan: WHY the program
// ended, plus the counts a surveyor reconstructs the program from (§7.15) and the M22 closeout artifact.
//
// D7 — the five EARLY reasons (`tenant_offboarding`, `all_bereaved_deceased`, `geographic_relocation`,
// `family_legal_action`, `other_early`) require a clinical-supervisor cosign AND a ≥40-char narrative; both
// are CHECK-enforced here, not just at the route, because an early close is the one path that can cut a
// regulatory 13-month obligation short. The 13-month completion and the two opt-out-driven closes carry no
// cosign requirement — §2.6 is explicit that a patient-opt-out close fires automatically (D7's cosign rule
// deliberately does not apply to it).
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, denormalized from the plan.
// CROSS-MODULE FK POLICY: org/PE/location + the intra-M16 plan parent carry real FKs; the membership ids
// (M2) and bereavement_summary_document_id (M22) are LOGICAL uuid.
import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bereavementPlanClosureReason } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavementPlan } from "./bereavement-plans";

export const bereavementPlanClosure = pgTable(
  "bereavement_plan_closure",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),

    reason: bereavementPlanClosureReason("reason").notNull(),
    reasonNarrativeRedacted: text("reason_narrative_redacted"), // D11 audit-denylisted
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    closedByUserId: uuid("closed_by_user_id"), // NULL for the 13-month auto-close cron (M2 membership otherwise)
    // Mirrors `BereavementCloseKind` in @wardenx/types: 'auto' | 'manual' | 'cascade'.
    closeKind: text("close_kind").notNull(),

    // D7 cosign metadata — required for the five early-close reasons.
    cosignedByUserId: uuid("cosigned_by_user_id"),
    cosignedAt: timestamp("cosigned_at", { withTimezone: true }),

    // §7.15 survey-reconstruction counts, frozen at close (recomputing them later would drift as rows age
    // out of the display window).
    outreachCompletedCount: integer("outreach_completed_count").notNull(),
    outreachMissedCount: integer("outreach_missed_count").notNull(),
    contactsActiveCount: integer("contacts_active_count").notNull(),
    contactsOptedOutCount: integer("contacts_opted_out_count").notNull(),

    bereavementSummaryDocumentId: uuid("bereavement_summary_document_id"), // logical FK → M22 document

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePlanClosure: uniqueIndex("berv_closure_unique_plan").on(t.planId),
    closeKindValues: check(
      "berv_closure_close_kind_ck",
      sql`close_kind IN ('auto','manual','cascade')`,
    ),
    earlyRequiresCosign: check(
      "berv_closure_early_requires_cosign",
      sql`reason NOT IN ('tenant_offboarding','all_bereaved_deceased','geographic_relocation','family_legal_action','other_early')
          OR (cosigned_by_user_id IS NOT NULL AND cosigned_at IS NOT NULL)`,
    ),
    // §2.5 — 40-char narrative floor on the same early-close set (0 chars for the auto/opt-out closes).
    earlyRequiresNarrative: check(
      "berv_closure_early_requires_narrative",
      sql`reason NOT IN ('tenant_offboarding','all_bereaved_deceased','geographic_relocation','family_legal_action','other_early')
          OR char_length(coalesce(reason_narrative_redacted, '')) >= 40`,
    ),
  }),
);

export type BereavementPlanClosureRow = typeof bereavementPlanClosure.$inferSelect;
export type NewBereavementPlanClosureRow = typeof bereavementPlanClosure.$inferInsert;
