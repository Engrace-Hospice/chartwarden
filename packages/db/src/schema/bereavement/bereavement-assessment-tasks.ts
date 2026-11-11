// @chartwarden/db — `bereavement_assessment_task` (ADR-0109 D3, migration 1342). The two risk-assessment checkpoints of the
// Medicare-aligned timeline (initial assessment at death + 28 days, midpoint reassessment at death + 180 days) as TASKS, never
// `bereavement_outreach` rows: an outreach row for a checkpoint would count in the M30 CoP 418.64(d) numerator for a contact nobody
// made. One row per (contact, task_kind); `late_grace_until` is the boundary the hourly miss pass judges against.
//
// A task is completed only by a HUMAN-appended risk score (`risk_score_id` names it); the automatic initial score at plan seed does not.
// No free text, so nothing is audit-denylisted.
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, denormalized from the plan.
// CROSS-MODULE FK POLICY: org/PE/location + the intra-M16 plan, contact and risk-score parents are real FKs; the membership ids are logical.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavedContact } from "./bereaved-contacts";
import { bereavementPlan } from "./bereavement-plans";
import { bereavementRiskScore } from "./bereavement-risk-scores";

export const BEREAVEMENT_ASSESSMENT_TASK_KINDS = [
  "initial_assessment",
  "midpoint_reassessment",
] as const;
export const BEREAVEMENT_ASSESSMENT_TASK_STATUSES = [
  "scheduled",
  "completed",
  "missed",
  "cancelled",
] as const;

export const bereavementAssessmentTask = pgTable(
  "bereavement_assessment_task",
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
    bereavedContactId: uuid("bereaved_contact_id")
      .notNull()
      .references(() => bereavedContact.id, { onDelete: "restrict" }),

    taskKind: text("task_kind", { enum: BEREAVEMENT_ASSESSMENT_TASK_KINDS }).notNull(),
    status: text("status", { enum: BEREAVEMENT_ASSESSMENT_TASK_STATUSES })
      .notNull()
      .default("scheduled"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    lateGraceUntil: timestamp("late_grace_until", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByMembershipId: uuid("completed_by_membership_id"), // logical M2 membership
    riskScoreId: uuid("risk_score_id").references(() => bereavementRiskScore.id, {
      onDelete: "restrict",
    }),
    assigneeUserId: uuid("assignee_user_id"), // logical M2 membership

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    contactKindUnique: uniqueIndex("berv_assessment_task_contact_kind_uniq").on(
      t.bereavedContactId,
      t.taskKind,
    ),
    planDueIdx: index("berv_assessment_task_plan_due_idx").on(t.planId, t.dueAt),
    // The hourly miss pass scans only the scheduled tasks.
    scheduledGraceIdx: index("berv_assessment_task_scheduled_grace_idx")
      .on(t.organizationId, t.lateGraceUntil)
      .where(sql`status = 'scheduled'`),
    orgIdx: index("berv_assessment_task_org_ix").on(t.organizationId, t.createdAt),
    riskScoreIdx: index("berv_assessment_task_risk_score_idx")
      .on(t.riskScoreId)
      .where(sql`risk_score_id IS NOT NULL`),
    providerEntityIdx: index("berv_assessment_task_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("berv_assessment_task_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),

    kindValues: check(
      "berv_assessment_task_kind_chk",
      sql`task_kind IN ('initial_assessment', 'midpoint_reassessment')`,
    ),
    statusValues: check(
      "berv_assessment_task_status_chk",
      sql`status IN ('scheduled', 'completed', 'missed', 'cancelled')`,
    ),
    graceAfterDue: check("berv_assessment_task_grace_after_due", sql`late_grace_until >= due_at`),
    completionShape: check(
      "berv_assessment_task_completion_chk",
      sql`(status = 'completed') = (completed_at IS NOT NULL AND risk_score_id IS NOT NULL)`,
    ),
  }),
);

export type BereavementAssessmentTaskRow = typeof bereavementAssessmentTask.$inferSelect;
export type NewBereavementAssessmentTaskRow = typeof bereavementAssessmentTask.$inferInsert;
