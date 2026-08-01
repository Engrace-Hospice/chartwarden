// apps/backend/src/modules/32-ai-platform/events-by-m32.ts — Module 32's outbox-event contributions
// (§4.11). The `m32.*` taxonomy under the `m32.` namespace (M01 D8 / M03 D9 / M04 D9).
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership
// (`moduleOwner: 'm32'`) and valid declared consumers; the composition root merges it into the platform
// catalog at boot (the M15/M20/M23/M24/M25/M26/M27 events-by-mN precedent), and the dispatcher validates
// each `m32.*` publish against the TypeBox payloadSchema inside the SAME transaction as the mutation.
//
// WHY THIS FILE IS PART OF THE ROUTE TASK. `publishOutboxEvent` throws `unknown_event` for any name the
// boot catalog does not carry, and the throw rolls back the caller's transaction. Without this file every
// §4.1 mutation that emits would fail at the moment of the write.
//
// ── §4.11 SPELLS ITS EVENTS `ai.*`; THE PLATFORM CONVENTION IS `m32.*`, AND THE CONVENTION WINS ──────
//
// M01 D8 / M03 D9 make the `mN.` prefix the OWNERSHIP claim — it is how the catalog knows which module
// may publish a name and how `check-fitness-gaps` proves no module publishes under another's namespace.
// §4.11's `ai.capability.created` carries no such claim, and a second naming scheme would be a second
// ownership model. Each entry below therefore reads `m32.<resource>.<verb>` and names its §4.11 spelling
// in the description, so a consumer reading either document lands on the same event.
//
// ── FIVE PAYLOAD DECISIONS, EACH OF WHICH READS WRONG IF YOU SKIM IT ─────────────────────────────────
//
//   1. NO PAYLOAD CARRIES A PROMPT, A RESPONSE, A CHART EXCERPT OR A NARRATIVE. §3.4 denylists the three
//      cipher columns and §8.8 makes the outbox a fan-out to modules that are not M32; ids, enum tokens,
//      counts, booleans and instants only. `m32.hallucination_report.filed` carries `severity` and
//      `kind` and NOT the clinician's description — the report row is where that lives, behind
//      `ai.hallucination.triage`.
//   2. `m32.phi.disclosed` IS A SEPARATE EVENT FROM `m32.capability.invoked`, not a flag on it
//      (M32-F03/ADR-0013). M4's §164.528 accounting sink subscribes to the disclosure event ALONE; a
//      boolean on the invocation event would make the accounting query a filter that a future consumer
//      could forget to apply, and an un-filtered disclosure log over-reports every local inference as a
//      disclosure to a vendor.
//   3. THE FOUR HITL OUTCOMES ARE FOUR DISCRETE EVENTS (M32-F03/AI-082), not one event with an
//      `outcome` field. The MLflow calibration baseline updater subscribes to `accepted`/`edited` and
//      NOT to `rejected`; collapsing them would make every consumer re-implement that split.
//   4. `m32.capability.invoked` CARRIES THE TOKEN COUNTS AND `m32.local_inference.recorded` DOES NOT.
//      §3.5 freezes both counts on the row, so they are stable facts by the time either event is
//      published — but M35's token metering subscribes to the invocation event, and a local inference
//      that reported the same shape would bill an agency for compute that never left its own hardware.
//   5. EVERY PAYLOAD REPEATS `orgId` EVEN THOUGH THE ENVELOPE CARRIES IT. A consumer holding the payload
//      alone (M36's alert router) needs it — the M20 precedent, unchanged. The PLATFORM-SCOPED events
//      (`m32.kill_switch.activated` with `scope: 'platform'`, the capability-lifecycle events) carry
//      `orgId: null` instead of omitting it, because "this stopped every tenant" and "we did not record
//      which tenant" must not be the same value.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const Id = Type.String({ minLength: 1 });
const IdOrNull = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const Iso = Type.String({ minLength: 1 });
const Str = Type.String();
const StrOrNull = Type.Union([Type.String(), Type.Null()]);
const Bool = Type.Boolean();
const Count = Type.Integer({ minimum: 0 });
const Num = Type.Number();

/** Every M32 payload carries these two (§4.11's standard envelope, repeated per decision 5). */
const base = {
  orgId: IdOrNull,
  occurredAt: Iso,
};

/** The capability identity every event names — the id for joins, the key for humans and dashboards. */
const capability = {
  capabilityId: Id,
  capabilityKey: Str,
};

export const M32_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── capability governance (§2.2, R1/R4/R5) ────────────────────────────────────────────────────────
  {
    eventName: "m32.capability.created",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.capability.created` — a capability was registered into PROPOSED (R1). PLATFORM-scoped: `orgId` is null because `ai_capability` is platform-shared and a registration belongs to no tenant.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      riskTier: Str,
      lifecycleState: Str,
      createdByMembershipId: Id,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.capability.transitioned",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.capability.transitioned` — a §2.2 lifecycle edge was walked (R4). `rationale` is the operator's own words for the ledger; it names no patient (the lifecycle table is platform-shared and has never held PHI).",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      previousState: Str,
      newState: Str,
      approvalKind: Str,
      transitionedByMembershipId: Id,
      rationale: Str,
      linkedEvaluationRunId: IdOrNull,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.capability.calibrated",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.capability.calibrated` — a new `is_current` calibration was published and the incumbent superseded (R5 / W6).",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      calibrationId: Id,
      supersededCalibrationId: IdOrNull,
      backendKey: Str,
      calibratedByMembershipId: Id,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  // ── consent (§5.3 / §5.4, R10/R11/R13) ────────────────────────────────────────────────────────────
  {
    eventName: "m32.tenant_opt_in.recorded",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.tenant_opt_in.recorded` — a Tenant Admin opted the org into a capability after the W4.1 acknowledgment gate. M35 meters capability tiers off this; `baaReference` is a CONTRACT reference, never a document.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      tenantOptInId: Id,
      acknowledgedByMembershipId: Id,
      routingMode: Str,
      baaReference: StrOrNull,
      zdrAcknowledged: Bool,
      pilotEnrollment: Bool,
    }),
    declaredConsumers: ["m4", "m35"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.tenant_opt_in.revoked",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.tenant_opt_in.revoked` — §10.6's immediate withdrawal (R11). A PAUSE publishes this too, discriminated by `mode`: 'paused' keeps the acknowledgment evidence, 'withdrawn' does not, and a consumer that treated them alike would resume billing an agency that stopped.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      tenantOptInId: Id,
      revokedByMembershipId: Id,
      mode: Str,
      reason: StrOrNull,
    }),
    declaredConsumers: ["m4", "m35"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.clinician_opt_out.recorded",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.clinician_opt_out.recorded` — a clinician turned a capability off for herself (R13, §5.4). Carries the MEMBERSHIP, never a name.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      optOutId: Id,
      membershipId: Id,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  // ── invocation + disclosure (§3.2.8, decisions 2 and 4) ───────────────────────────────────────────
  {
    eventName: "m32.capability.invoked",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.capability_invoked` — one recorded `ai_invocation`, whatever its outcome. M35 meters tokens off this; the drift sweeper reads latency + status. Carries no prompt, no response and no patient.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      invocationId: Id,
      modelBackendId: Id,
      backendKey: Str,
      inputTokens: Count,
      outputTokens: Count,
      latencyMs: Count,
      status: Str,
      routingDecision: Str,
    }),
    declaredConsumers: ["m4", "m35"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.phi.disclosed",
    moduleOwner: "m32",
    description:
      "M32-F03/ADR-0013 (§4.11 `ai.phi_disclosed`) — emitted on EVERY cloud invocation (`ai_model_backend.kind='cloud'`). THE §164.528 DISCLOSURE FEEDER: M4's accounting sink subscribes to this event ALONE (decision 2). `patientId` may be null — a cloud call that touched no chart is still a vendor call, and recording it as a disclosure of nobody is the honest row.",
    payloadSchema: Type.Object({
      ...base,
      invocationId: Id,
      ...capability,
      patientId: IdOrNull,
      recipient: Str,
      purpose: Str,
      modelBackendId: Id,
      zdrConfirmed: Bool,
      disclosedAt: Iso,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.local_inference.recorded",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.local_inference` — emitted on EVERY local invocation (`kind='local'`). Deliberately carries NO token counts (decision 4): nothing left the agency's own hardware, so there is nothing for M35 to meter.",
    payloadSchema: Type.Object({
      ...base,
      invocationId: Id,
      ...capability,
      modelBackendId: Id,
      latencyMs: Count,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  // ── the four DISCRETE HITL outcomes (decision 3) ──────────────────────────────────────────────────
  {
    eventName: "m32.output.accepted",
    moduleOwner: "m32",
    description:
      "M32-F03/AI-082 — the human took the AI output as written. Feeds MLflow's calibration baseline.",
    payloadSchema: Type.Object({
      ...base,
      invocationId: Id,
      ...capability,
      recordedByMembershipId: Id,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.output.edited",
    moduleOwner: "m32",
    description:
      "M32-F03/AI-082 — the human kept the output but changed it. A DISTINCT signal from acceptance: an edit rate is the earliest drift indicator §7 has.",
    payloadSchema: Type.Object({
      ...base,
      invocationId: Id,
      ...capability,
      recordedByMembershipId: Id,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.output.rejected",
    moduleOwner: "m32",
    description:
      "M32-F03/AI-082 — the human discarded the output. NOT a calibration input (decision 3): a rejection says the answer was unusable, not what the right answer was.",
    payloadSchema: Type.Object({
      ...base,
      invocationId: Id,
      ...capability,
      recordedByMembershipId: Id,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.output.flagged",
    moduleOwner: "m32",
    description:
      "M32-F03/AI-082 — the human flagged the output as wrong in a way worth a look. `flagReason` is an ENUM TOKEN, never free text: the narrative belongs on a hallucination report, which has the triage surface and the §3.4 denylist that free text needs.",
    payloadSchema: Type.Object({
      ...base,
      invocationId: Id,
      ...capability,
      recordedByMembershipId: Id,
      flagReason: Str,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: true,
  },
  // ── kill switch (§3.2.12, D8, R7/R8) ──────────────────────────────────────────────────────────────
  {
    eventName: "m32.kill_switch.activated",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.kill_switch.activated` — a capability was stopped. `scope: 'platform'` carries `orgId: null` and stops every tenant; `scope: 'tenant'` names the one agency. NOT outbox-only: §4.8's `ai:kill-switch-broadcast` fan-out is what makes every instance's in-memory gate refresh within 5s.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      killSwitchId: Id,
      scope: Str,
      activatedByMembershipId: IdOrNull,
      activationActorKind: Str,
      reasonCategory: Str,
      severity: Str,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: false,
  },
  {
    eventName: "m32.kill_switch.deactivated",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.kill_switch.deactivated` — the switch was lifted (R8). `resolutionNarrative` is REQUIRED by §3.2.12 and is operator prose about the incident, not about a patient.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      killSwitchId: Id,
      scope: Str,
      deactivatedByMembershipId: IdOrNull,
      resolutionNarrative: Str,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: false,
  },
  // ── hallucination report → triage (§3.2.10, D9/D16, R18/R20) ──────────────────────────────────────
  {
    eventName: "m32.hallucination_report.filed",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.hallucination_report.filed` — a clinician reported an AI output as wrong (R18). Carries `severity` and `kind` and NOT the description (decision 1); `critical` is D16's automatic SEV-1 trigger, which is why the severity has to ride the event rather than wait for triage.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      reportId: Id,
      invocationId: IdOrNull,
      severity: Str,
      kind: Str,
      reporterMembershipId: Id,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.hallucination_report.triaged",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.hallucination_report.triaged` — the AI Safety Owner recorded a disposition (R20). `followUpAction: 'none'` is a RECORDED decision, not an absent one — see AiHallucinationFollowUpAction.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      reportId: Id,
      triagedByMembershipId: Id,
      severity: Str,
      triageStatus: Str,
      followUpAction: Str,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: true,
  },
  // ── prompt registry (§4.5 / §8.5, R30) ────────────────────────────────────────────────────────────
  {
    eventName: "m32.prompt_template.activated",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.prompt_template.activated` — a template version became active and the incumbent was deprecated (R30). NOT outbox-only: every consumer module's boot cache and the §4.10 LRU invalidate off this. `contentHash` is what the §4.4 step-5 boot validator re-verifies against the git artifact.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      promptTemplateId: Id,
      version: Str,
      supersededTemplateId: IdOrNull,
      activatedByMembershipId: Id,
      contentHash: Str,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: false,
  },
  // ── routing sovereignty (§3.2.13, W8, R23) ────────────────────────────────────────────────────────
  {
    eventName: "m32.routing_override.set",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.routing_override.set` — a Tenant Admin pinned a capability's routing (e.g. `local_only`, W8). Also published on REMOVAL (R24), discriminated by `active: false` — a removal that published nothing would leave every cache holding a sovereignty decision the tenant revoked.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      overrideId: Id,
      backendKeyPreference: Str,
      overrideReason: Str,
      setByMembershipId: Id,
      active: Bool,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  // ── evaluation + drift (§3.2.11, D10/D11, R26/§4.8) ───────────────────────────────────────────────
  {
    eventName: "m32.evaluation.completed",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.evaluation.completed` — a run reached a terminal status. `summaryMetrics` is a free-shaped metric bag (numbers keyed by metric name), which is the one place a payload is not a closed vocabulary — the metric SET is per-capability and pinning it here would freeze the science.",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      runId: Id,
      stage: Str,
      status: Str,
      decision: Str,
      summaryMetrics: Type.Record(Type.String(), Type.Unknown()),
      mlflowRunId: StrOrNull,
      completedByMembershipId: IdOrNull,
    }),
    declaredConsumers: ["m4"],
    isOutboxOnly: true,
  },
  {
    eventName: "m32.drift.detected",
    moduleOwner: "m32",
    description:
      "§4.11 `ai.drift.detected` — a D11 sweep found a metric outside its MLflow baseline. `severityTier` is the yellow/orange/red ladder §4.9's alert carries; `red` is what trips the automated kill switch (`activation_actor_kind: 'automated_drift_monitor'`).",
    payloadSchema: Type.Object({
      ...base,
      ...capability,
      metric: Str,
      observedValue: Num,
      baselineValue: Num,
      deltaPercent: Num,
      severityTier: Str,
      sweepTimestamp: Iso,
    }),
    declaredConsumers: ["m4", "m36"],
    isOutboxOnly: true,
  },
];
