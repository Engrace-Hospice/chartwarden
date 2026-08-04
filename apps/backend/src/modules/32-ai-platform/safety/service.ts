// apps/backend/src/modules/32-ai-platform/safety/service.ts — W3's kill switch, W5's hallucination
// workflow and §3.2.11's evaluation runs, sequenced (M32-T05).
//
// Every RULE lives in `@wardenx/ai-platform/safety`; this file resolves the facts those rules need,
// performs the writes their decisions imply, and hands back the follow-up work rather than doing it.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────────
//
// It does not publish outbox events and it does not raise M36 alerts. Both are M32-T07's (§4.11 /
// §4.9), and inventing an emit here would put a second publish site in the module for T07 to
// duplicate. Instead every command returns its `AiKillSwitchOutcome` / `AiHallucinationOutcome`
// carrying the plan — the scope, the severity, the follow-up action, the demotion — so the route that
// gains the publisher emits from a value the RULE computed rather than re-deriving it.
//
// ── THE FOLLOW-UP IS PLANNED HERE AND EXECUTED BY THE §4.8 WORKER ─────────────────────────────────
//
// W5.7 puts the deprecate-and-kill sequence on the `ai:hallucination-triage-followup` queue, and W3.5
// gives D16's auto-demotion a 60-second budget. `executeAiHallucinationFollowUp` is that worker's body:
// it takes the plan, activates the platform kill switch and demotes the capability. It is a separate
// exported function rather than an inline continuation of `triageAiHallucinationReport`, because the
// triage write must COMMIT whether or not the follow-up succeeds — a triage decision lost because a
// kill-switch write failed would leave the report back in the queue with the capability still live.
import {
  type AiEvaluationRunTransitionRequest,
  AiGovernanceError,
  type AiHallucinationFilingRequest,
  type AiHallucinationFollowUpPlan,
  type AiHallucinationTriageRequest,
  type AiKillSwitchActivationRequest,
  type AiKillSwitchDeactivationRequest,
  type AiKillSwitchDemotionPlan,
  type AiKillSwitchVerdict,
  aiKillSwitchFor,
  aiKillSwitchRequiresPlatformCredential,
  aiKillSwitchScopeOf,
  aiSev1DemotionTarget,
  evaluateAiEvaluationRunTransition,
  evaluateAiHallucinationFiling,
  evaluateAiHallucinationTriage,
  evaluateAiKillSwitchActivation,
  evaluateAiKillSwitchDeactivation,
  requireAiGovernance,
} from "@wardenx/ai-platform";
import type {
  AiCapabilityLifecycleState,
  AiEvaluationRunStage,
  AiEvaluationRunStatus,
  AiHallucinationTriageStatus,
  AiKillSwitchActorKind,
  AiKillSwitchScope,
  AiKillSwitchSeverity,
} from "@wardenx/types";

import type { AiCapabilityRegistryStore } from "../governance/store";
import type { AiKillSwitchGate } from "../invocation/service";
import type {
  AiEvaluationRunRowProjection,
  AiEvaluationRunStore,
  AiHallucinationReportRowProjection,
  AiHallucinationReportStore,
  AiKillSwitchRowProjection,
  AiKillSwitchStore,
} from "./store";

/** What every safety command needs. */
export interface AiSafetyServiceDeps {
  readonly killSwitches: AiKillSwitchStore;
  readonly reports: AiHallucinationReportStore;
  readonly evaluations: AiEvaluationRunStore;
  readonly registry: AiCapabilityRegistryStore;
  /** Injectable for the tests; the rules take the instant as an argument and never read a clock. */
  readonly now?: () => string;
}

function clock(deps: AiSafetyServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

async function requireCapabilityLifecycleState(
  deps: AiSafetyServiceDeps,
  capabilityId: string,
): Promise<AiCapabilityLifecycleState> {
  const row = await deps.registry.findCapabilityById(capabilityId);
  if (!row) throw new AiGovernanceError("AI_CAPABILITY_NOT_FOUND", `capability ${capabilityId}`);
  return row.lifecycleState;
}

// ── kill switch (R7 / R8 / R9, W3) ─────────────────────────────────────────────────────────────────

/** R7's result: the row plus everything §4.9's alert and D16's worker need. */
export interface AiKillSwitchOutcome {
  readonly row: AiKillSwitchRowProjection;
  readonly scope: AiKillSwitchScope;
  readonly severity: AiKillSwitchSeverity;
  /** The §2.2 demotion the activation implies (D16). `required: false` on every non-SEV-1 kill. */
  readonly demotion: AiKillSwitchDemotionPlan;
  /** True when the write had to run on the platform credential — the audited-bypass evidence T07's
   *  route records alongside the activation. */
  readonly usedPlatformCredential: boolean;
}

/**
 * R7 / W3 — activate the kill switch.
 *
 * The scope comes from `request.organizationId` (NULL = platform) and NOWHERE else. The demotion the
 * decision plans is NOT executed here: D16 gives it a 60-second budget through the outbox-driven
 * worker, and running it inline would make a slow lifecycle write hold up the stop that is the whole
 * point of a kill switch.
 */
export async function activateAiKillSwitch(
  deps: AiSafetyServiceDeps,
  request: AiKillSwitchActivationRequest,
): Promise<AiKillSwitchOutcome> {
  const lifecycleState = await requireCapabilityLifecycleState(deps, request.capabilityId);
  const current = await deps.killSwitches.findScopedRow(
    request.organizationId,
    request.capabilityId,
  );
  const decision = requireAiGovernance(
    evaluateAiKillSwitchActivation(request, current, lifecycleState, clock(deps)),
  );
  const row = await deps.killSwitches.activate(
    request.organizationId,
    request.capabilityId,
    decision.patch,
  );
  return {
    row,
    scope: decision.scope,
    severity: decision.severity,
    demotion: decision.demotion,
    usedPlatformCredential: aiKillSwitchRequiresPlatformCredential(decision.scope),
  };
}

/** R8 — lift the switch. See `evaluateAiKillSwitchDeactivation`: this does NOT undo a D16 demotion. */
export async function deactivateAiKillSwitch(
  deps: AiSafetyServiceDeps,
  request: AiKillSwitchDeactivationRequest,
): Promise<{
  readonly row: AiKillSwitchRowProjection;
  readonly scope: AiKillSwitchScope;
  readonly usedPlatformCredential: boolean;
}> {
  const current = await deps.killSwitches.findScopedRow(
    request.organizationId,
    request.capabilityId,
  );
  const decision = requireAiGovernance(
    evaluateAiKillSwitchDeactivation(request, current, clock(deps)),
  );
  const row = await deps.killSwitches.deactivate(
    request.organizationId,
    request.capabilityId,
    decision.patch,
  );
  return {
    row,
    scope: decision.scope,
    usedPlatformCredential: aiKillSwitchRequiresPlatformCredential(decision.scope),
  };
}

/** R9 — the §5.1.3 dashboard: every active switch this caller may see. */
export function listActiveAiKillSwitches(
  deps: AiSafetyServiceDeps,
  organizationId: string,
): Promise<readonly AiKillSwitchRowProjection[]> {
  return deps.killSwitches.listActive(organizationId);
}

/** Is this capability killed for this org, and by which row (§6.2's gate fact)? */
export async function readAiKillSwitchVerdict(
  deps: AiSafetyServiceDeps,
  organizationId: string,
  capabilityId: string,
): Promise<AiKillSwitchVerdict> {
  const rows = await deps.killSwitches.findForCapability(organizationId, capabilityId);
  return aiKillSwitchFor(organizationId, rows);
}

/**
 * The binding M32-T04 left REQUIRED and unfilled: `AiKillSwitchGate` at its §6.2 position.
 *
 * Reads through the store on every call. §4.8's `ai:kill-switch-broadcast` cache is the LATENCY answer
 * and it is not this task's — a cache that can be stale for five seconds is a capability that keeps
 * dispatching for five seconds after a SEV-1 stop, so the version that ships before the broadcast
 * exists is the one that asks the table. The cache goes in when the fan-out that invalidates it does.
 */
export function createAiKillSwitchGate(store: AiKillSwitchStore): AiKillSwitchGate {
  return {
    isActive: async (organizationId, capabilityId) => {
      const rows = await store.findForCapability(organizationId, capabilityId);
      return aiKillSwitchFor(organizationId, rows).killed;
    },
  };
}

// ── hallucination reports (R18 / R19 / R20, W5) ────────────────────────────────────────────────────

/** R18/R20's result: the row plus the follow-up the rule computed. */
export interface AiHallucinationOutcome {
  readonly report: AiHallucinationReportRowProjection;
  readonly followUp: AiHallucinationFollowUpPlan;
}

/** R18 / W5.1 — file the report. A `critical` severity comes back with the SEV-1 plan attached. */
export async function fileAiHallucinationReport(
  deps: AiSafetyServiceDeps,
  request: AiHallucinationFilingRequest,
): Promise<AiHallucinationOutcome> {
  const decision = requireAiGovernance(evaluateAiHallucinationFiling(request, clock(deps)));
  const report = await deps.reports.insertReport({
    organizationId: request.organizationId,
    providerEntityId: request.providerEntityId,
    locationId: request.locationId,
    invocationId: request.invocationId,
    capabilityId: request.capabilityId,
    reporterMembershipId: request.reporterMembershipId,
    reporterRole: request.reporterRole,
    severity: request.severity,
    hallucinationKind: request.hallucinationKind,
    reporterNarrativeCipher: request.reporterNarrativeCipher,
    patch: decision.patch,
  });
  return { report, followUp: decision.followUp };
}

/** R19 — the triage queue. */
export function listAiHallucinationReports(
  deps: AiSafetyServiceDeps,
  organizationId: string,
  filter?: {
    readonly statuses?: readonly AiHallucinationTriageStatus[];
    readonly capabilityId?: string;
  },
): Promise<readonly AiHallucinationReportRowProjection[]> {
  return deps.reports.listReports(organizationId, filter);
}

/** R20 / W5.5–5.6 — record the triage decision and return the follow-up it implies. */
export async function triageAiHallucinationReport(
  deps: AiSafetyServiceDeps,
  organizationId: string,
  reportId: string,
  request: AiHallucinationTriageRequest,
): Promise<AiHallucinationOutcome> {
  const current = await deps.reports.findReport(organizationId, reportId);
  if (!current) {
    throw new AiGovernanceError(
      "AI_HALLUCINATION_REPORT_NOT_FOUND",
      `hallucination report ${reportId}`,
    );
  }
  const decision = requireAiGovernance(
    evaluateAiHallucinationTriage(
      request,
      {
        id: current.id,
        capabilityId: current.capabilityId,
        severity: current.severity,
        triageStatus: current.triageStatus,
      },
      clock(deps),
    ),
  );
  const report = await deps.reports.applyTriage(organizationId, reportId, decision.patch);
  return { report, followUp: decision.followUp };
}

/** What the `ai:hallucination-triage-followup` worker did. */
export interface AiHallucinationFollowUpResult {
  readonly action: AiHallucinationFollowUpPlan["action"];
  /** `null` when the plan activated no switch, or when one was ALREADY active (see below). */
  readonly killSwitch: AiKillSwitchOutcome | null;
  /** The §2.2 demotion the kill implied; `required: false` when nothing was demoted. */
  readonly demotion: AiKillSwitchDemotionPlan;
  /** True when the plan called for a kill that a prior incident had already activated. */
  readonly killSwitchAlreadyActive: boolean;
}

const NO_DEMOTION: AiKillSwitchDemotionPlan = { required: false, toState: null, rationaleText: "" };

/**
 * The §2.2 demotion W5.7 requires, given the capability's state — shared by BOTH branches of the worker.
 *
 * `evaluateAiKillSwitchActivation` plans a demotion for a SEV-1 kill and for nothing else (D16), which is
 * exactly right for R7: an operator stopping a capability for a cost cap has not deprecated it. It is not
 * the whole rule HERE. W5.7 makes `deprecate_capability` demote on the strength of the TRIAGE
 * DISPOSITION, and `model_rollback_required` on a non-critical report raises a SEV-2 kill — so reading
 * the demotion off the kill's severity alone would deprecate the capability when a prior incident had
 * already flipped the switch (the already-active branch, which honours `plan.demotesCapability`) and NOT
 * when this worker flipped it. Same report, same disposition, two different outcomes decided by whether
 * something unrelated happened first. This function is the one answer both branches read.
 */
function aiHallucinationDemotionPlan(
  plan: AiHallucinationFollowUpPlan,
  lifecycleState: AiCapabilityLifecycleState,
): AiKillSwitchDemotionPlan {
  if (!plan.demotesCapability) return NO_DEMOTION;
  const toState = aiSev1DemotionTarget(lifecycleState);
  return {
    required: toState !== null,
    toState,
    rationaleText: toState === null ? "" : `auto-deprecate following ${plan.action}`,
  };
}

/**
 * W5.7 / §4.8's `ai:hallucination-triage-followup` — execute the plan.
 *
 * THE KILL IS ALWAYS PLATFORM-SCOPED. A fabrication is a property of the model, not of the agency that
 * happened to notice it; stopping the capability only for the reporting tenant would leave every other
 * tenant exposed to the same output. That is also why the activation runs as
 * `automated_lifecycle_demotion` with no membership — the AI Safety Owner triaged the REPORT, and
 * attributing the platform-wide stop to them personally would name them as the incident commander of
 * an action a queue took.
 *
 * AN ALREADY-ACTIVE SWITCH IS NOT AN ERROR HERE. `evaluateAiKillSwitchActivation` refuses a second
 * activation so the first incident's attribution survives — correct for R7, wrong for a worker that may
 * retry or that follows a second report against a capability already stopped. The worker therefore
 * checks first and reports `killSwitchAlreadyActive` rather than failing the job, which would retry
 * forever against a switch that is already doing its job.
 *
 * The §2.2 DEMOTION is returned as a plan and not walked: the lifecycle edge needs a signer and a
 * rationale (M32-T03's `transitionAiCapability`), and a worker that wrote a governance transition with
 * no signer would put an unattributed row in the ledger D2 exists to keep attributable. T07's worker
 * binds the AI Safety Owner from the triage row and walks it.
 */
export async function executeAiHallucinationFollowUp(
  deps: AiSafetyServiceDeps,
  plan: AiHallucinationFollowUpPlan,
  capabilityId: string,
): Promise<AiHallucinationFollowUpResult> {
  if (plan.killSwitchReason === null) {
    return {
      action: plan.action,
      killSwitch: null,
      demotion: NO_DEMOTION,
      killSwitchAlreadyActive: false,
    };
  }

  const lifecycleState = await requireCapabilityLifecycleState(deps, capabilityId);
  const planned = aiHallucinationDemotionPlan(plan, lifecycleState);

  const existing = await deps.killSwitches.findScopedRow(null, capabilityId);
  if (existing?.active) {
    return {
      action: plan.action,
      killSwitch: null,
      // The demotion still has to be REPORTED: a second critical report against a capability whose
      // switch is already on may still be the first one that finds it in a demotable state.
      demotion: planned,
      killSwitchAlreadyActive: true,
    };
  }

  const killSwitch = await activateAiKillSwitch(deps, {
    organizationId: null,
    capabilityId,
    reason: plan.killSwitchReason,
    actorKind: "automated_lifecycle_demotion",
    actorMembershipId: null,
    activationMessage: null,
  });

  return {
    action: plan.action,
    killSwitch,
    // The kill's OWN plan wins when it has one: a SEV-1 activation's rationale names the severity, which
    // is the more specific record. Otherwise W5.7's disposition-driven demotion stands (see the helper).
    demotion: killSwitch.demotion.required ? killSwitch.demotion : planned,
    killSwitchAlreadyActive: false,
  };
}

// ── evaluation runs (R26 / R27 / R28, W6) ──────────────────────────────────────────────────────────

/** R26's request. `status` is not an input: §3.2.11 inserts every run `pending`. */
export interface AiEvaluationRunRequest {
  readonly capabilityId: string;
  readonly backendId: string;
  readonly datasetVersionRef: string;
  readonly mlflowRunId: string;
  readonly stage: AiEvaluationRunStage;
  readonly summaryMetrics: Record<string, unknown>;
  readonly initiatedByMembershipId: string;
}

/** R26 / W6.1 — queue an evaluation run. */
export async function queueAiEvaluationRun(
  deps: AiSafetyServiceDeps,
  request: AiEvaluationRunRequest,
): Promise<AiEvaluationRunRowProjection> {
  // Resolving the capability is the existence check: a run against a capability nobody registered has
  // an FK to nothing, and surfacing that as a constraint violation would be a 500 for a typo.
  await requireCapabilityLifecycleState(deps, request.capabilityId);
  return deps.evaluations.insertRun({ ...request, createdAt: clock(deps) });
}

/** R27 — recent runs. */
export function listAiEvaluationRuns(
  deps: AiSafetyServiceDeps,
  filter?: {
    readonly capabilityId?: string;
    readonly statuses?: readonly AiEvaluationRunStatus[];
  },
): Promise<readonly AiEvaluationRunRowProjection[]> {
  return deps.evaluations.listRuns(filter);
}

/** R28 — one run. */
export async function readAiEvaluationRun(
  deps: AiSafetyServiceDeps,
  runId: string,
): Promise<AiEvaluationRunRowProjection> {
  const run = await deps.evaluations.findRun(runId);
  if (!run) throw new AiGovernanceError("AI_EVALUATION_RUN_NOT_FOUND", `evaluation run ${runId}`);
  return run;
}

/** W6.3 — the `ai:evaluations` worker moving a run, and the AI Safety Owner recording a ruling. */
export async function transitionAiEvaluationRun(
  deps: AiSafetyServiceDeps,
  runId: string,
  request: AiEvaluationRunTransitionRequest,
): Promise<AiEvaluationRunRowProjection> {
  const current = await readAiEvaluationRun(deps, runId);
  const decision = requireAiGovernance(
    evaluateAiEvaluationRunTransition(request, current, clock(deps)),
  );
  return deps.evaluations.applyTransition(runId, decision.patch);
}

/** Re-exported for the composition root and the tests. */
export type { AiKillSwitchActorKind, AiKillSwitchScope, AiKillSwitchSeverity };
export { aiKillSwitchScopeOf };
