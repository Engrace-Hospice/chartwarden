// M16's durable intake for an IDG bereavement-risk signal. The flag requests counselor reassessment;
// automation does not use it to override the deterministic risk tier.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const bereavementIdgRiskFlags = pgTable(
  "bereavement_idg_risk_flag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    idgDecisionId: uuid("idg_decision_id").notNull(),
    idgMeetingId: uuid("idg_meeting_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    riskLevel: text("risk_level", { enum: ["low", "medium", "high"] }).notNull(),
    rationaleText: text("rationale_text").notNull(),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["pending_assessment", "assessed"] })
      .notNull()
      .default("pending_assessment"),
    assessedRiskScoreId: uuid("assessed_risk_score_id"),
    assessedAt: timestamp("assessed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionUnique: uniqueIndex("bereavement_idg_risk_flag_org_decision_unique").on(
      t.organizationId,
      t.idgDecisionId,
    ),
    pendingByPatient: index("bereavement_idg_risk_flag_pending_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.status,
    ),
    assessmentConsistency: check(
      "bereavement_idg_risk_flag_assessment_consistency",
      sql`(${t.status} = 'pending_assessment' AND ${t.assessedRiskScoreId} IS NULL AND ${t.assessedAt} IS NULL)
        OR (${t.status} = 'assessed' AND ${t.assessedRiskScoreId} IS NOT NULL AND ${t.assessedAt} IS NOT NULL)`,
    ),
  }),
);

export type BereavementIdgRiskFlag = typeof bereavementIdgRiskFlags.$inferSelect;
