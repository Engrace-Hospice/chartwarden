// Shared runtime contract for M14 decision capture and outbox publication.
import { Type } from "@sinclair/typebox";

const nullableText = Type.Union([Type.String(), Type.Null()]);
const carePlanMutation = Type.Union([
  Type.Object({
    op: Type.Literal("problem_add"),
    icd10Code: nullableText,
    snomedCode: nullableText,
    description: Type.String({ minLength: 1, maxLength: 4000 }),
    problemKind: Type.Union([
      Type.Literal("terminal"),
      Type.Literal("related"),
      Type.Literal("unrelated"),
    ]),
  }),
  Type.Object({
    op: Type.Literal("problem_update"),
    problemId: Type.String({ format: "uuid" }),
    updates: Type.Partial(
      Type.Object({
        status: Type.Union([
          Type.Literal("active"),
          Type.Literal("resolved"),
          Type.Literal("inactive"),
        ]),
        description: Type.String({ minLength: 1, maxLength: 4000 }),
      }),
    ),
  }),
  Type.Object({
    op: Type.Literal("goal_add"),
    problemId: Type.String({ format: "uuid" }),
    originalText: Type.String({ minLength: 1, maxLength: 4000 }),
    revisedText: nullableText,
    source: Type.Union([
      Type.Literal("clinical"),
      Type.Literal("patient_stated"),
      Type.Literal("family_stated"),
      Type.Literal("agent_stated"),
    ]),
    measurableOutcome: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    op: Type.Literal("goal_update"),
    goalId: Type.String({ format: "uuid" }),
    updates: Type.Partial(
      Type.Object({
        revisedText: Type.String({ minLength: 1, maxLength: 4000 }),
        status: Type.Union([
          Type.Literal("in_progress"),
          Type.Literal("met"),
          Type.Literal("not_met"),
          Type.Literal("revised"),
          Type.Literal("discontinued"),
        ]),
        statusNote: Type.String({ minLength: 1, maxLength: 4000 }),
      }),
    ),
  }),
  Type.Object({
    op: Type.Literal("intervention_add"),
    problemId: Type.String({ format: "uuid" }),
    goalRefs: Type.Array(Type.String({ format: "uuid" })),
    discipline: Type.String({ minLength: 1, maxLength: 64 }),
    scopeText: Type.String({ minLength: 1, maxLength: 4000 }),
    frequencyText: Type.String({ minLength: 1, maxLength: 1000 }),
    frequencyValue: Type.String({ minLength: 1, maxLength: 255 }),
  }),
  Type.Object({
    op: Type.Literal("intervention_discontinue"),
    interventionId: Type.String({ format: "uuid" }),
    reason: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
]);

/**
 * F-232 (#248) — the `discipline_plan_update` arm's element mutations (ADR-0023 / M15-F07; M15 spec §7.7).
 * It targets one of the four M15 discipline plans (`planKind`), NOT the M7 IPOC: a goal hangs off an M7 IPOC
 * problem (`parentProblemId`, M15 §2.1), an intervention references that plan's own goals (`goalRefs`), and a
 * goal moves through M15's own §2.2.3 events rather than by writing a status. The op set is deliberately the
 * four M15 can apply to a DRAFT version without a signature: add/revise/discontinue a goal, add/discontinue an
 * intervention. `frequencyValue` carries the `<count>:<unit>:<period>` triple the DB CHECK enforces.
 */
const disciplinePlanMutation = Type.Union([
  Type.Object({
    op: Type.Literal("goal_add"),
    parentProblemId: Type.String({ format: "uuid" }),
    source: Type.Union([
      Type.Literal("clinical"),
      Type.Literal("patient_stated"),
      Type.Literal("family_stated"),
      Type.Literal("agent_stated"),
    ]),
    originalText: Type.String({ minLength: 1, maxLength: 4000 }),
    measurableOutcome: nullableText,
  }),
  Type.Object({
    op: Type.Literal("goal_update"),
    goalId: Type.String({ format: "uuid" }),
    event: Type.Union([
      Type.Literal("start"),
      Type.Literal("meet"),
      Type.Literal("missTarget"),
      Type.Literal("revise"),
      Type.Literal("discontinue"),
    ]),
    revisedText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  }),
  Type.Object({
    op: Type.Literal("intervention_add"),
    goalRefs: Type.Array(Type.String({ format: "uuid" })),
    discipline: Type.String({ minLength: 1, maxLength: 64 }),
    scopeText: Type.String({ minLength: 1, maxLength: 4000 }),
    frequencyText: Type.String({ minLength: 1, maxLength: 1000 }),
    frequencyValue: Type.String({
      pattern: "^[0-9]+:(visit|day|week|month|prn|continuous):(day|week|month|episode|prn)$",
    }),
  }),
  Type.Object({
    op: Type.Literal("intervention_discontinue"),
    interventionId: Type.String({ format: "uuid" }),
    reason: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
]);

export const IDG_DECISION_PAYLOAD_SCHEMA = Type.Union([
  Type.Object({
    kind: Type.Literal("care_plan_update"),
    mutations: Type.Array(carePlanMutation, { minItems: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("discipline_plan_update"),
    planKind: Type.Union([
      Type.Literal("aide_poc"),
      Type.Literal("msw_plan"),
      Type.Literal("spiritual_plan"),
      Type.Literal("volunteer_plan"),
    ]),
    mutations: Type.Array(disciplinePlanMutation, { minItems: 1 }),
  }),
  Type.Object({
    kind: Type.Literal("order_request"),
    requestedOrders: Type.Array(
      Type.Object({
        kindHint: Type.Union([
          Type.Literal("lab"),
          Type.Literal("dme"),
          Type.Literal("level_of_care_change"),
          Type.Literal("recertification"),
          Type.Literal("comfort_kit"),
          Type.Literal("supply"),
          Type.Literal("ancillary_service"),
          Type.Literal("idg_requested"),
        ]),
        narrative: Type.String({ minLength: 1, maxLength: 4000 }),
        recommendedTimeframe: nullableText,
        triggeringProblemId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      }),
      { minItems: 1 },
    ),
  }),
  Type.Object({
    kind: Type.Literal("medication_recommendation"),
    recommendations: Type.Array(
      Type.Object({
        recommendationKind: Type.Union([
          Type.Literal("add"),
          Type.Literal("discontinue"),
          Type.Literal("change_dose"),
          Type.Literal("change_route"),
          Type.Literal("change_frequency"),
        ]),
        drugLabel: Type.String({ minLength: 1, maxLength: 500 }),
        proposedStrength: nullableText,
        proposedRoute: nullableText,
        proposedFrequency: nullableText,
        triggeringProblemId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
        rationaleText: Type.String({ minLength: 1, maxLength: 4000 }),
      }),
      { minItems: 1 },
    ),
  }),
  Type.Object({
    kind: Type.Literal("level_of_care_consideration"),
    consideredLevel: Type.Union([
      Type.Literal("routine"),
      Type.Literal("continuous"),
      Type.Literal("inpatient_respite"),
      Type.Literal("general_inpatient"),
    ]),
    rationaleText: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    kind: Type.Literal("recertification_consideration"),
    periodIndex: Type.Integer({ minimum: 1 }),
    rationaleText: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    kind: Type.Literal("family_meeting_needed"),
    familyMembers: Type.Array(Type.String({ minLength: 1, maxLength: 255 })),
    preferredWindow: Type.Union([
      Type.Object({
        startIso: Type.String({ format: "date-time" }),
        endIso: Type.String({ format: "date-time" }),
      }),
      Type.Null(),
    ]),
    rationaleText: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    kind: Type.Literal("bereavement_risk_flag"),
    riskLevel: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    rationaleText: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    kind: Type.Literal("referral"),
    referralKind: Type.String({ minLength: 1, maxLength: 255 }),
    referralTargetMdmId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    rationaleText: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    kind: Type.Literal("team_note"),
    noteText: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
]);
