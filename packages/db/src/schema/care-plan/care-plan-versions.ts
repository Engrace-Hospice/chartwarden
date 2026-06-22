// @wardenx/db — `care_plan_version` (M7 §3.3). The immutable-after-signed snapshot ledger: one row
// per draft→in_review→signed→superseded cycle of a care plan (§2.2.2). PHI-bearing → three-column
// tenancy rule (provider_entity_id + location_id NOT NULL, denormalized from the plan). `stateSnapshot`
// is null until in_review, immutable after signed; `requiredSignerSet` is the D5 quorum captured at
// draft. draftedByMembershipId references M1 `membership` (the identity spine). `patientUnderstandingText`
// is patient-quoted free-text → denylisted in the M4 write-audit trigger (§3.5). RLS + trigger land in
// migration 0029 (M7-T02).
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { carePlanVersionKind, carePlanVersionStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { carePlans } from "./care-plans";

export const carePlanVersions = pgTable(
  "care_plan_version",
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
    sequence: integer("sequence").notNull(),
    status: carePlanVersionStatus("status").notNull().default("draft"),
    kind: carePlanVersionKind("kind").notNull(),
    idgMeetingId: uuid("idg_meeting_id"), // M14 soft-ref (app-validated; no cross-module FK)
    stateSnapshot: jsonb("state_snapshot"), // null until in_review; immutable after signed
    requiredSignerSet: jsonb("required_signer_set").notNull(),
    patientUnderstandingText: text("patient_understanding_text"),
    draftedAt: timestamp("drafted_at", { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    draftedByMembershipId: uuid("drafted_by_membership_id").references(() => memberships.id),
  },
  (t) => ({
    planSeqUq: uniqueIndex("care_plan_version_plan_seq_uq").on(t.carePlanId, t.sequence),
    planStatusIdx: index("care_plan_version_plan_status_idx").on(t.carePlanId, t.status),
    signedAtIdx: index("care_plan_version_signed_at_idx").on(t.signedAt),
  }),
);

export type CarePlanVersion = typeof carePlanVersions.$inferSelect;
export type NewCarePlanVersion = typeof carePlanVersions.$inferInsert;
