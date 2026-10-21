// @chartwarden/db — `discipline_assessment` (M15 §3.3). The per-discipline assessment instrument (D6 taxonomy:
// msw_psychosocial · chaplain_spiritual · aide_environmental · volunteer_relationship) — explicitly DISTINCT
// from M9's clinician instruments. Append-only correction-of-record (M9 D9): an amendment is a NEW row
// pointing at the original via `amends_assessment_id`, never an in-place edit.
//
// M15-F06 / ADR-0022 D1.1: NOT partitioned. The §3.3 code comment inherited the M4/M9 monthly-RANGE
// convention, but §3.6 supersedes it — the §7.2/§7.3 one-signed-initial-per-(plan, kind) partial unique
// index cannot coexist with a `captured_at` RANGE partition (the partition key would have to be in the
// constraint, which would let a second "initial" land in another month). Per-plan volumes are trivial.
//
// `data` holds the per-kind TypeBox-validated payload (@chartwarden/discipline-plans §3.4). Its free-text
// branches (notes / narrativeRef / safetyConsiderations / focuses / concerns / bereavementRiskFactors) are
// re-scrubbed inside the M4 write-audit trigger — a top-level column denylist would miss them (§3.6).
//
// `sud_flag` / `family_violence_flag` are the columns §7.8/§7.9 filter on at the SQL level — the redaction
// is a WHERE clause driven by the ABAC predicates, never a UI hide.
//
// Tenancy (M15-F05): patient-bearing → organization_id + provider_entity_id + location_id NOT NULL.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { disciplineAssessmentKind, disciplineAssessmentStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlan } from "./discipline-care-plans";

export const disciplineAssessment = pgTable(
  "discipline_assessment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => disciplineCarePlan.id, { onDelete: "restrict" }),

    kind: disciplineAssessmentKind("kind").notNull(),
    status: disciplineAssessmentStatus("status").notNull().default("draft"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    isInitial: boolean("is_initial").notNull().default(false),

    sudFlag: boolean("sud_flag").notNull().default(false), // §7.8 Part 2 gate
    familyViolenceFlag: boolean("family_violence_flag").notNull().default(false), // §7.9 gate

    sourceEncounterId: uuid("source_encounter_id"), // logical FK → M8 signed encounter
    data: jsonb("data").notNull(), // per-kind TypeBox (§3.4); nested denylist (§3.6)

    amendsAssessmentId: uuid("amends_assessment_id"), // self-ref (app-validated; no FK)
    amendmentReason: text("amendment_reason"), // audit-denylisted (§3.6)

    capturedByMembershipId: uuid("captured_by_membership_id").notNull(), // logical FK → M2
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedByMembershipId: uuid("signed_by_membership_id"), // logical FK → M2
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    planKindIdx: index("discipline_assessment_plan_kind_idx").on(
      t.organizationId,
      t.planId,
      t.kind,
      t.capturedAt,
    ),
    // §7.2/§7.3 — exactly one SIGNED initial assessment per (plan, kind).
    initialUq: uniqueIndex("discipline_assessment_initial_uq")
      .on(t.organizationId, t.planId, t.kind)
      .where(sql`is_initial = true AND status = 'signed'`),
    isInitialIdx: index("discipline_assessment_is_initial_idx")
      .on(t.organizationId, t.planId, t.kind)
      .where(sql`is_initial = true`),
    amendsIdx: index("discipline_assessment_amends_idx").on(t.amendsAssessmentId),
    amendmentRequiresReason: check(
      "discipline_assessment_amendment_reason_ck",
      sql`amends_assessment_id IS NULL OR amendment_reason IS NOT NULL`,
    ),
    signedRequiresSigner: check(
      "discipline_assessment_signed_signer_ck",
      sql`status = 'draft' OR (signed_at IS NOT NULL AND signed_by_membership_id IS NOT NULL)`,
    ),
  }),
);

export type DisciplineAssessment = typeof disciplineAssessment.$inferSelect;
export type NewDisciplineAssessment = typeof disciplineAssessment.$inferInsert;
