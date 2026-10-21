// @chartwarden/db — `discipline_care_plan_version` (M15 §3.3). The §2.2.2 hybrid-versioning row (M7 D1
// verbatim): draft → in_review → signed → superseded. `state_snapshot` is SEALED at the `in_review`
// transition — later edits to the underlying goal/intervention/assessment rows never mutate it, and the
// M4 write-audit trigger denylists its narrative-bearing branches (§3.6). `required_signer_set` freezes the
// §3.5 D11 quorum the sign transition is evaluated against.
//
// Tenancy (M15-F05): patient-bearing (inherited from the plan root at insert) → organization_id +
// provider_entity_id + location_id NOT NULL. RLS pivots on organization_id alone (ADR-0010 D2).
//
// FKs: organization/PE/location (M1 core) + the intra-module, non-partitioned plan parent. idg_meeting_id
// (M14) is LOGICAL uuid — a cross-module FK constraint is forbidden.
import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { disciplinePlanVersionKind, disciplinePlanVersionStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlan } from "./discipline-care-plans";

export const disciplineCarePlanVersion = pgTable(
  "discipline_care_plan_version",
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

    sequence: bigint("sequence", { mode: "number" }).notNull(), // 1-based monotonic per plan
    status: disciplinePlanVersionStatus("status").notNull().default("draft"),
    kind: disciplinePlanVersionKind("kind").notNull(),

    stateSnapshot: jsonb("state_snapshot"), // sealed at in_review; UPDATE refused thereafter (§2.3)
    requiredSignerSet: jsonb("required_signer_set"), // frozen §3.5 D11 quorum

    idgMeetingId: uuid("idg_meeting_id"), // logical FK → M14; `idg_review` kind only

    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    planSequenceUq: uniqueIndex("discipline_care_plan_version_plan_sequence_uq").on(
      t.organizationId,
      t.planId,
      t.sequence,
    ),
    planStatusIdx: index("discipline_care_plan_version_plan_status_idx").on(
      t.organizationId,
      t.planId,
      t.status,
    ),
    // At most one open (draft | in_review) version per plan — the §2.2.2 single-open-draft rule.
    planOpenUq: uniqueIndex("discipline_care_plan_version_plan_open_uq")
      .on(t.organizationId, t.planId)
      .where(sql`status IN ('draft', 'in_review')`),
  }),
);

export type DisciplineCarePlanVersion = typeof disciplineCarePlanVersion.$inferSelect;
export type NewDisciplineCarePlanVersion = typeof disciplineCarePlanVersion.$inferInsert;
