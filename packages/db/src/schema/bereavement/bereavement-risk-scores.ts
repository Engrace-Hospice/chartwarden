// @chartwarden/db — `bereavement_risk_score` (M16 §3.3.3). The D3 hybrid rubric's APPEND-ONLY ledger: every
// scheduled (intake / 1mo / 6mo / 12mo) and event-triggered recompute writes a NEW row (D8). Rows are
// IMMUTABLE — D11 gives the table a BEFORE UPDATE trigger that raises, so a "correction" is a new row, and
// the audit trail can never lose the tier a cadence decision was actually made on.
//
// `bereaved_contact_id IS NULL` means the PLAN-LEVEL rollup; a non-NULL value is that one survivor's score.
//
// D17 partial data: the 8 factors inside `risk_factors_jsonb` each carry `true | false | 'unknown'`, and the
// scorer divides by the count of KNOWABLE factors rather than 8 — so `data_completeness` + `confidence_band`
// are not decoration, they are what stops M30's HQRP denominator from penalizing a tenant with many
// external-source (transfer-from-hospital) deaths. Both columns default to the v0.2 back-compat values; the
// scorer always sets them explicitly.
//
// The rubric itself only ever reaches `high` — `complicated` is a D8 PROMOTION written when a PG-13/IPG-R
// complicated-grief screen comes back positive (the screen totals ride in `risk_factors_jsonb`), never a
// weighted-sum outcome.
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, denormalized from the plan.
// CROSS-MODULE FK POLICY: org/PE/location + the intra-M16 plan and contact parents are real FKs;
// assessed_by_user_id (M2 membership) and augmented_request_id / augmented_model_ref (M32) are logical.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  bereavementConfidenceBand,
  bereavementDataCompleteness,
  bereavementRiskScoreKind,
  bereavementRiskTier,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavedContact } from "./bereaved-contacts";
import { bereavementPlan } from "./bereavement-plans";

export const bereavementRiskScore = pgTable(
  "bereavement_risk_score",
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
    bereavedContactId: uuid("bereaved_contact_id").references(() => bereavedContact.id, {
      onDelete: "restrict",
    }), // NULL = plan-level rollup

    scoreKind: bereavementRiskScoreKind("score_kind").notNull(), // D3
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
    assessedByUserId: uuid("assessed_by_user_id"), // logical FK → M2 membership; NULL for the cron/system scorer

    // D3/D17 factor vector — shape locked by `BereavementRiskFactorInputs` in @chartwarden/types. Carries the
    // 8 tri-state factors, the optional pg13/ipgr screen totals (D8), and an envelope-encrypted
    // `notes_cipher`. D11 re-scrubs `notes_cipher` + `narrative` out of the audit capture.
    riskFactorsJsonb: jsonb("risk_factors_jsonb").notNull(),

    ruleScore: integer("rule_score").notNull(), // the deterministic weighted sum (D3) — the source of truth
    ruleTier: bereavementRiskTier("rule_tier").notNull(),

    dataCompleteness: bereavementDataCompleteness("data_completeness")
      .notNull()
      .default("complete"),
    confidenceBand: bereavementConfidenceBand("confidence_band").notNull().default("HIGH"),

    // Layer 2 (D3) — present only when score_kind = 'llm_augmented', and gated on Part-A `ai.full` (M32).
    // The narrative can NEVER move the tier (AI Governance §7.4): `rule_tier` stays the cadence driver.
    augmentedScore: integer("augmented_score"),
    augmentedTier: bereavementRiskTier("augmented_tier"),
    augmentedNarrativeRedacted: text("augmented_narrative_redacted"), // D11 audit-denylisted
    augmentedModelRef: text("augmented_model_ref"), // M32 model-registry id
    augmentedRequestId: uuid("augmented_request_id"), // M32 invocation correlation

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planIdx: index("berv_risk_plan_idx").on(t.planId, t.assessedAt),
    contactIdx: index("berv_risk_contact_idx")
      .on(t.bereavedContactId, t.assessedAt)
      .where(sql`bereaved_contact_id IS NOT NULL`),
    llmRequiresRule: check(
      "berv_risk_llm_requires_rule",
      sql`score_kind <> 'llm_augmented' OR (augmented_score IS NOT NULL AND augmented_model_ref IS NOT NULL)`,
    ),
  }),
);

export type BereavementRiskScoreRow = typeof bereavementRiskScore.$inferSelect;
export type NewBereavementRiskScoreRow = typeof bereavementRiskScore.$inferInsert;
