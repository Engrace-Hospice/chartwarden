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

export const IDG_DECISION_PAYLOAD_SCHEMA = Type.Union([
  Type.Object({
    kind: Type.Literal("care_plan_update"),
    mutations: Type.Array(carePlanMutation, { minItems: 1 }),
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
