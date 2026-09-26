// apps/backend/src/modules/07-care-plan/events-by-m7.ts — Module 7's outbox-event contributions
// (M7-T07, spec §2.4). The full `m7.*` taxonomy keyed on M7's own tables, under the `m7.` namespace
// (M01 D8 / M03 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`),
// ownership (moduleOwner='m7'), and valid declared consumers (real module ids). The named cross-module
// consumers (M8 encounter gate / M11 orders / M14 IDG / M16 bereavement / M22 PDF / M28 FHIR / M30 / M33
// reporting / M36 alerts) subscribe when they land; M7 publishes the events now. Every event is
// outbox-only EXCEPT `m7.care_plan.review_overdue`, which §4.4 ALSO pushes over Socket.IO to the org/PE
// room for the live overdue banner (isOutboxOnly=false).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

/** A per-version lifecycle kind (mirrors `care_plan_version_kind`; §3.2). */
const versionKind = Type.Union([
  Type.Literal("initial"),
  Type.Literal("idg_review"),
  Type.Literal("interim_revision"),
  Type.Literal("discharge"),
]);

export const M7_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── care plan root ──────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m7.care_plan.created",
    moduleOwner: "m7",
    description: "A care plan was created when `m6.admission.activated` was processed (§7.1).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      patientId: Type.Optional(Type.String({ minLength: 1 })),
      admissionId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.version_drafted",
    moduleOwner: "m7",
    description: "A new care-plan version was opened (any kind); M14 keys off `kind=idg_review`.",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      versionId: Type.String({ minLength: 1 }),
      kind: versionKind,
      sequence: Type.Integer({ minimum: 1 }),
    }),
    declaredConsumers: ["m14"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.version_signed",
    moduleOwner: "m7",
    description:
      "The last required signer signed a version — drives the M8 encounter gate + M22 PDF.",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      versionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      kind: versionKind,
      snapshotRef: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m8", "m14", "m17", "m22", "m28", "m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.idg_proposal_created",
    moduleOwner: "m7",
    description:
      "An M14 care-plan decision was persisted as proposed M7 changes; active content is unchanged.",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      versionId: Type.String({ minLength: 1 }),
      decisionId: Type.String({ minLength: 1 }),
      meetingId: Type.String({ minLength: 1 }),
      changeCount: Type.Integer({ minimum: 1 }),
    }),
    // Record-only: M14 originated the decision and holds no consumer for its M7 echo — declaring m14
    // deferred every emission forever (a pending row re-claimed every 30 minutes).
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.idg_proposal_applied",
    moduleOwner: "m7",
    description:
      "A signed idg_review version applied its proposed mutations atomically to working care-plan content.",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      versionId: Type.String({ minLength: 1 }),
      appliedProposalCount: Type.Integer({ minimum: 1 }),
      appliedChangeCount: Type.Integer({ minimum: 1 }),
    }),
    // Record-only: neither M14 nor M30 has a consumer (or subscription-list entry) for the applied
    // proposal — declaring them deferred every emission forever. The signed version that applies it is
    // announced separately by `m7.care_plan.version_signed`.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.review_due",
    moduleOwner: "m7",
    description:
      "The 15-day review enters its warning window at T+13 (M36 alert to IDG coordinator; D10).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.review_overdue",
    moduleOwner: "m7",
    description:
      "The 15-day review gate engaged (T+15) — also pushed over Socket.IO for the live banner (§4.4).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
      overdueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m8"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: false,
  },
  {
    eventName: "m7.care_plan.initial_overdue",
    moduleOwner: "m7",
    description:
      "The initial 5-day gate engaged — the unsigned initial version blocks new encounter signs.",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionActivatedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m8"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.discharged",
    moduleOwner: "m7",
    description:
      "The care plan was discharged when the admission ended — seeds M16 bereavement plan init.",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m16", "m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  // ── problems ────────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m7.problem.added",
    moduleOwner: "m7",
    description:
      "A problem was added to the working version (M14 packet aggregation / M28 FHIR Condition).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      problemId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.problem.updated",
    moduleOwner: "m7",
    description: "A problem was updated (status/coding/description revision).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      problemId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.problem.resolved",
    moduleOwner: "m7",
    description: "A problem was resolved (status → resolved).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      problemId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m28"],
    isOutboxOnly: true,
  },
  // ── goals ───────────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m7.goal.added",
    moduleOwner: "m7",
    description:
      "A goal was added (carries `source` for patient/agent-stated attribution; M28 FHIR Goal).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      goalId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.goal.updated",
    moduleOwner: "m7",
    description:
      "A goal was revised (clinical revised_text added; original_text preserved verbatim, §7.3).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      goalId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.goal.met",
    moduleOwner: "m7",
    description: "A goal reached its measurable outcome (status → met).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      goalId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.goal.discontinued",
    moduleOwner: "m7",
    description: "A goal was discontinued (status → discontinued).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      goalId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m28"],
    isOutboxOnly: true,
  },
  // ── interventions ───────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m7.intervention.added",
    moduleOwner: "m7",
    description:
      "An intervention was added (carries `discipline`; M11 links it when an order backs it).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      interventionId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      discipline: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m11", "m14", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.intervention.updated",
    moduleOwner: "m7",
    description: "An intervention was updated (scope/frequency/responsible-role revision).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      interventionId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      discipline: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m11", "m14", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.intervention.discontinued",
    moduleOwner: "m7",
    description: "An intervention was discontinued (status → discontinued).",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      interventionId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      discipline: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m11", "m14", "m28"],
    isOutboxOnly: true,
  },
];
