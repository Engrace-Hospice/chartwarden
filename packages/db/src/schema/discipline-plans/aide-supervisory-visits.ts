// @chartwarden/db — `aide_supervisory_visit` (M15 §3.3). The 42 CFR §418.76(h) RN supervisory attestation for
// an aide_poc plan: who supervised, in which mode, whether performance was satisfactory, and when the next
// one is due. On insert the parent plan's `next_supervisory_due_at` is recomputed (§7.1).
//
// §2.2.4: `source_encounter_id` (M8) is nullable ONLY for documented phone-supervision edge cases — those
// do NOT advance the 14-day clock and stay separately discoverable for survey. `corrective_actions` is
// mandatory (≥40 chars) when performance is unsatisfactory — DB CHECK, not just a service guard.
// `cadence_days_at_insert` freezes the cadence the `next_due_at` was computed from; the tenant override may
// only TIGHTEN, so the CHECK caps it at 14.
//
// Tenancy (M15-F05): patient-bearing (via the plan) → organization_id + provider_entity_id + location_id
// NOT NULL, so `SupervisoryCadenceReader` / `DisciplineComplianceProvider` can aggregate per PE/location.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { aideSupervisoryAttestationMode } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlan } from "./discipline-care-plans";

export const aideSupervisoryVisit = pgTable(
  "aide_supervisory_visit",
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

    aideMembershipId: uuid("aide_membership_id").notNull(), // logical FK → M2 membership
    supervisingRnMembershipId: uuid("supervising_rn_membership_id").notNull(), // logical FK → M2
    sourceEncounterId: uuid("source_encounter_id"), // logical FK → M8; null = phone supervision

    supervisoryAt: timestamp("supervisory_at", { withTimezone: true }).notNull(),
    attestationMode: aideSupervisoryAttestationMode("attestation_mode").notNull(),
    aidePerformanceSatisfactory: boolean("aide_performance_satisfactory").notNull(),
    correctiveActions: text("corrective_actions"), // audit-denylisted (§3.6)
    supervisoryNarrative: text("supervisory_narrative").notNull(), // audit-denylisted (§3.6)

    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
    cadenceDaysAtInsert: bigint("cadence_days_at_insert", { mode: "number" }).notNull(),

    capturedByMembershipId: uuid("captured_by_membership_id").notNull(), // logical FK → M2
    signedAt: timestamp("signed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    planSupervisoryIdx: index("aide_supervisory_visit_plan_supervisory_idx").on(
      t.organizationId,
      t.planId,
      t.supervisoryAt,
    ),
    nextDueIdx: index("aide_supervisory_visit_next_due_idx").on(t.organizationId, t.nextDueAt),
    aideIdx: index("aide_supervisory_visit_aide_idx").on(t.aideMembershipId),
    correctiveActionsRequired: check(
      "aide_supervisory_visit_corrective_actions_ck",
      sql`aide_performance_satisfactory = true
          OR (corrective_actions IS NOT NULL AND length(corrective_actions) >= 40)`,
    ),
    cadenceCheck: check(
      "aide_supervisory_visit_cadence_ck",
      sql`cadence_days_at_insert >= 1 AND cadence_days_at_insert <= 14`,
    ),
  }),
);

export type AideSupervisoryVisit = typeof aideSupervisoryVisit.$inferSelect;
export type NewAideSupervisoryVisit = typeof aideSupervisoryVisit.$inferInsert;
