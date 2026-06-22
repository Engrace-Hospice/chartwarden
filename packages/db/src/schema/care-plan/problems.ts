// @wardenx/db — `problem` (M7 §3.3). A care-plan problem (terminal/related/unrelated drives M23 claim
// ICD-10 sequencing). PHI-bearing → three-column tenancy rule. ICD-10/SNOMED are M38 terminology codes
// stored as plain text (resolved/validated app-side via the M38 seam). `description` + `resolution_note`
// are free-text → denylisted in the M4 write-audit trigger (§3.5). `sudRelated` marks Part-2-protected
// rows for the §7.6 confidentiality gate. `version` carries optimistic concurrency (§7.7). addedBy
// references M1 `membership`. RLS + trigger land in migration 0029 (M7-T02).
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { problemKind, problemSource, problemStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { carePlans } from "./care-plans";

export const problems = pgTable(
  "problem",
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
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    icd10Code: text("icd10_code"),
    snomedCode: text("snomed_code"),
    description: text("description").notNull(),
    kind: problemKind("kind").notNull(),
    source: problemSource("source").notNull().default("clinical"),
    sudRelated: boolean("sud_related").notNull().default(false),
    status: problemStatus("status").notNull().default("active"),
    onsetAt: timestamp("onset_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    addedByMembershipId: uuid("added_by_membership_id").references(() => memberships.id),
    addedByDiscipline: text("added_by_discipline"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planStatusIdx: index("problem_plan_status_idx").on(t.carePlanId, t.status),
    kindIdx: index("problem_kind_idx").on(t.carePlanId, t.kind),
    sudIdx: index("problem_sud_idx").on(t.carePlanId).where(sql`sud_related = true`),
  }),
);

export type Problem = typeof problems.$inferSelect;
export type NewProblem = typeof problems.$inferInsert;
