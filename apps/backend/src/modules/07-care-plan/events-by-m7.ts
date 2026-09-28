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
    // F-129 (#248) — m14 dropped: `packages/idg/src/packet/builder.ts`'s `CarePlanSummaryInput` (the
    // packet's `carePlanSummary` block) is documented as "the M7 `CarePlanReader` active-plan summary,
    // already projected to the packet cover shape" — a build-time SEAM PULL, not a push cache. M14 never
    // duplicates this data (D1), so it has no use for a per-draft push.
    declaredConsumers: [],
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
    // F-140 (#248) — m8 removed: M8's own spec (line 387) states outright that outbox publication is
    // the only cross-module communication M8 performs "at the boundary" — the encounter-authoring gate
    // reads M7's `CarePlanReader` seam fresh at sign time (`getCarePlanReader()`, a boot-validated M1
    // registry seam, "NOT a schema import"), never a cached push.
    declaredConsumers: ["m14", "m17", "m22"],
    // F-115 (#248) — m28/m30 removed: m28 never subscribes to anything (its FHIR reads resolve seams
    // fresh per-request, F-035); m30 reads the care-plan review cycle via
    // `CarePlanCycleCountsView.fifteenDayCycleCountsForOrg` (care_plan_15_day_adherence) on its nightly
    // cadence, not by reacting to this event.
    seamConsumers: ["m30", "m33"],
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
    // F-140 (#248) — m8 removed: same seam-pull reasoning as `version_signed` above — the 5-/15-day
    // overdue sign-gate is `CarePlanReader`'s own check, read fresh at encounter sign time.
    declaredConsumers: [],
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
    // F-140 (#248) — m8 removed: same seam-pull reasoning as `version_signed` above.
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m7.care_plan.discharged",
    moduleOwner: "m7",
    description: "The care plan was discharged when the admission ended.",
    payloadSchema: Type.Object({
      planId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    // F-134 (#248) — `m16` removed: the "seeds M16 bereavement plan init" claim is false — F-105
    // established `m6.bereavement.eligible` is the ONLY path a `bereavement_plan` row can come into
    // existence, and M16's own §4.5 outbox-subscriptions table never names this event.
    declaredConsumers: [],
    // F-115 (#248) — m30 moved here: same `fifteenDayCycleCountsForOrg` seam as `care_plan.version_signed`
    // above, read on M30's nightly cadence rather than a per-event reaction.
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  // F-115 (#248) — `m28` dropped from every problem/goal/intervention `declaredConsumers` below. M28's
  // FHIR Condition projection was never built (F-035: "Condition ... has no reader seam at all"), and even
  // once it is, M28 resolves every FHIR resource fresh at REQUEST time through a seam (§164.528 D3) — it
  // never subscribes to an outbox event to stay current, so these were never going to bind regardless of
  // whether the Condition seam lands. The description text below still names M28 as the eventual FHIR
  // consumer of this DATA; only the outbox subscription claim was wrong.
  // F-129 (#248) — m14 dropped from every problem/goal/intervention `declaredConsumers` below, the same
  // reasoning as `care_plan.version_drafted` above: the packet's `carePlanSummary` block
  // (`activeProblemCount`/`activeGoalCount`/`activeInterventionCount`/…) is a build-time pull through M7's
  // own `CarePlanReader` seam (`CarePlanSummaryInput` in `packages/idg/src/packet/builder.ts`), never a
  // push cache keyed on individual problem/goal/intervention deltas. The description text below still
  // names M14/M28 as eventual DATA consumers; only the outbox-subscription claim was wrong (M28's is
  // already corrected above, F-115).
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
    declaredConsumers: [],
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
    declaredConsumers: [],
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
    declaredConsumers: [],
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
    declaredConsumers: [],
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
    declaredConsumers: [],
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
    declaredConsumers: [],
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
    declaredConsumers: [],
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
    declaredConsumers: ["m11"],
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
    declaredConsumers: ["m11"],
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
    declaredConsumers: ["m11"],
    isOutboxOnly: true,
  },
];
