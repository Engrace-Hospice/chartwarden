// apps/backend/src/modules/32-ai-platform/governance/service.ts — M32-T03's governance SERVICES: the
// capability lifecycle (§2.2), calibration publication (§3.2.3), tenant opt-in (§5.3/W4) and clinician
// opt-out (§5.4), sequenced over the `./store` ports.
//
// Shape of every command: read the facts → run the PURE rule from `@wardenx/ai-platform/governance`
// over them → write what the rule's patch says, and nothing else. No business rule lives here and none
// lives in SQL; this file is the wiring between the two, which is why it is short relative to what it
// decides.
//
// ── WHAT T03 DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────────────────
//
// No routes (M32-T07), no permission keys (§4.6, T07), no ABAC predicates (§4.7, T07), no seam
// publication (§4.2/§4.4, T06) and no outbox emits (§4.11, T07). A service here is a function the
// route layer will call; calling it does not authorise anything on its own, and the §4.6/§4.7 gates
// are what will decide whether a caller reaches it. `ai.tenant_opt_in.recorded` (W4 step 3) and
// `ai.capability.transitioned` (W5 step 7) are named in T07's outbox catalog and are NOT emitted here —
// an event published from a layer with no transaction of its own is an event that can outlive a
// rolled-back write.
//
// ── THE ONE PORT THAT IS DECLARED AND NOT BOUND ────────────────────────────────────────────────────
//
// W4.1 requires the platform to VALIDATE the admin's acknowledgments, not merely record them: the BAA
// reference must resolve to a non-expired record in M2's contract registry, the ZDR contract reference
// must be present in the org's vendor metadata, and the named clinical reviewer must actually hold
// `clinical_safety_lead` in that org. All three are upstream seams (§4.3 `OrgContextResolver`,
// `IdentityResolver`, `PermissionEvaluator`) that M32-T06 binds. Until then the resolver is
// `createDenyingAiOptInEvidenceResolver()`, which answers "no" to every question — so an unbound
// resolver REFUSES the opt-in instead of waving it through. That direction is the whole point: a
// default that returned "resolved" would make the wave's most consequential consent gate a no-op that
// nothing distinguishes from a working one.
import {
  type AiCapabilityConsumerPosture,
  type AiCapabilityOwningRole,
  type AiCapabilityRiskTier,
  type AiLifecycleApprovalKind,
  type AiCapabilityLifecycleState,
  type AiRoutingMode,
  type AiRoutingPreference,
} from "@wardenx/types";
import {
  type AiCalibrationPublicationRequest,
  type AiGovernanceGateDecision,
  type AiLifecycleTransitionRequest,
  type AiOptInAcknowledgmentSubmission,
  type AiOptInResolvedEvidence,
  type AiTenantOptInRequest,
  AI_LIFECYCLE_INITIAL_STATE,
  AiGovernanceError,
  aiConsumerPostureFor,
  aiGovernanceGateFor,
  aiRequiredSignerRoles,
  aiLifecycleTransition,
  evaluateAiCalibrationPublication,
  evaluateAiClinicianOptOut,
  evaluateAiClinicianOptOutRevert,
  evaluateAiLifecycleTransition,
  evaluateAiTenantOptIn,
  evaluateAiTenantOptInPause,
  evaluateAiTenantOptInWithdrawal,
  requireAiGovernance,
} from "@wardenx/ai-platform";

import type {
  AiCalibrationRow,
  AiCapabilityGovernanceRow,
  AiCapabilityRegistrationInsert,
  AiCapabilityRegistryStore,
  AiClinicianOptOutRow,
  AiLifecycleEventRow,
  AiTenantConsentStore,
  AiTenantOptInRow,
} from "./store";

// ── the W4 evidence resolver (declared here, bound by M32-T06) ─────────────────────────────────────

/** What the caller must resolve upstream before a tenant opt-in can be validated (W4.1). */
export interface AiOptInEvidenceQuery {
  readonly organizationId: string;
  readonly baaReference: string | null;
  readonly zdrContractReference: string | null;
  readonly clinicalReviewerMembershipId: string | null;
}

/** The §4.3 upstream lookups behind W4.1, as one port. */
export interface AiOptInEvidenceResolver {
  resolve(query: AiOptInEvidenceQuery): Promise<AiOptInResolvedEvidence>;
}

/**
 * The fail-closed default until M32-T06 binds `OrgContextResolver` / `IdentityResolver` (see header).
 * Answers "no" to every W4.1 question, so a cloud-reachable opt-in is refused with the specific reason
 * that would be true if the reference genuinely did not resolve.
 */
export function createDenyingAiOptInEvidenceResolver(): AiOptInEvidenceResolver {
  return {
    resolve: async () => ({
      baaResolved: false,
      baaExpiresAt: null,
      zdrContractOnRecord: false,
      clinicalReviewerHasSafetyLeadRole: false,
    }),
  };
}

// ── deps ───────────────────────────────────────────────────────────────────────────────────────────

export interface AiGovernanceServiceDeps {
  readonly registry: AiCapabilityRegistryStore;
  readonly consent: AiTenantConsentStore;
  readonly evidence: AiOptInEvidenceResolver;
  /** Clock injection (tests pin it); defaults to the system clock. */
  readonly now?: () => string;
}

function clock(deps: AiGovernanceServiceDeps): string {
  return (deps.now ?? (() => new Date().toISOString()))();
}

async function requireCapabilityById(
  deps: AiGovernanceServiceDeps,
  capabilityId: string,
): Promise<AiCapabilityGovernanceRow> {
  const row = await deps.registry.findCapabilityById(capabilityId);
  if (!row) throw new AiGovernanceError("AI_CAPABILITY_NOT_FOUND", `capability ${capabilityId}`);
  return row;
}

// ── §2.2 capability lifecycle ──────────────────────────────────────────────────────────────────────

/** R1's body plus the signer, already parsed. */
export interface AiCapabilityRegistrationCommand {
  readonly capability: AiCapabilityRegistrationInsert;
  readonly actorMembershipId: string;
  readonly actorRole: AiCapabilityOwningRole;
  readonly rationaleText: string;
  readonly stageArtifacts?: Record<string, unknown>;
}

/**
 * R1 — register a capability into PROPOSED, with the `from_state IS NULL` ledger row §2.1 describes.
 *
 * The signer check is the FSM's own registration edge, resolved through `aiRequiredSignerRoles` so the
 * §5.7 Low-risk relaxation applies here identically. Registration takes no evaluation run and no prompt
 * template: PROPOSED is below every serving state, so §3.2.1's template CHECK does not bind yet.
 */
export async function registerAiCapability(
  deps: AiGovernanceServiceDeps,
  command: AiCapabilityRegistrationCommand,
): Promise<AiCapabilityGovernanceRow> {
  const existing = await deps.registry.findCapabilityByKey(command.capability.capabilityKey);
  if (existing) {
    throw new AiGovernanceError(
      "AI_CAPABILITY_KEY_TAKEN",
      `capability_key ${command.capability.capabilityKey} is already registered`,
    );
  }

  const edge = aiLifecycleTransition(null, AI_LIFECYCLE_INITIAL_STATE, "stage_1_proposal");
  if (!edge) {
    // Unreachable while §2.2's registration edge exists; kept because a state-machine edit that removed
    // it would otherwise register capabilities with no ledger row at all.
    throw new AiGovernanceError(
      "AI_LIFECYCLE_INVALID_TRANSITION",
      "§2.2 declares no capability-registration edge",
    );
  }
  const roles = aiRequiredSignerRoles(edge, command.capability.riskTier);
  if (!roles.includes(command.actorRole)) {
    throw new AiGovernanceError(
      "AI_LIFECYCLE_SIGNER_ROLE_INSUFFICIENT",
      `registration must be signed by one of [${roles.join(", ")}]; actor is ${command.actorRole}`,
    );
  }
  if (command.rationaleText.trim().length === 0) {
    throw new AiGovernanceError(
      "AI_LIFECYCLE_RATIONALE_REQUIRED",
      "ai_capability_lifecycle_event.rationale_text may not be blank",
    );
  }

  const at = clock(deps);
  return deps.registry.registerCapability(command.capability, {
    fromState: null,
    toState: AI_LIFECYCLE_INITIAL_STATE,
    actorMembershipId: command.actorMembershipId,
    actorRole: command.actorRole,
    approvalKind: "stage_1_proposal",
    reason: edge.label,
    rationaleText: command.rationaleText.trim(),
    linkedEvaluationRunId: null,
    stageArtifacts: command.stageArtifacts ?? {},
    transitionedAt: at,
  });
}

/** R4's body plus the signer. */
export interface AiCapabilityTransitionCommand extends AiLifecycleTransitionRequest {
  readonly capabilityId: string;
  readonly actorMembershipId: string;
  readonly stageArtifacts?: Record<string, unknown>;
  /** Optional operator-facing summary; defaults to §2.2's own edge label. */
  readonly reason?: string;
}

/** R4 — walk a §2.2 edge: patch `ai_capability` and append the ledger entry in one store call. */
export async function transitionAiCapability(
  deps: AiGovernanceServiceDeps,
  command: AiCapabilityTransitionCommand,
): Promise<AiCapabilityGovernanceRow> {
  const capability = await requireCapabilityById(deps, command.capabilityId);
  const at = clock(deps);
  const decision = requireAiGovernance(
    evaluateAiLifecycleTransition(
      {
        lifecycleState: capability.lifecycleState,
        riskTier: capability.riskTier,
        currentPromptTemplateKey: capability.currentPromptTemplateKey,
        firstApprovedAt: capability.firstApprovedAt,
      },
      command,
      at,
    ),
  );

  return deps.registry.applyTransition(capability.id, decision.patch, {
    capabilityId: capability.id,
    fromState: capability.lifecycleState,
    toState: command.toState,
    actorMembershipId: command.actorMembershipId,
    actorRole: command.actorRole,
    approvalKind: command.approvalKind,
    reason: command.reason?.trim() || decision.transition.label,
    rationaleText: command.rationaleText.trim(),
    linkedEvaluationRunId: command.linkedEvaluationRunId,
    stageArtifacts: command.stageArtifacts ?? {},
    transitionedAt: at,
  });
}

/** R3's lifecycle history + R6's calibration trail, as one read. */
export interface AiCapabilityGovernanceDetail {
  readonly capability: AiCapabilityGovernanceRow;
  readonly posture: AiCapabilityConsumerPosture;
  readonly lifecycleEvents: readonly AiLifecycleEventRow[];
  readonly calibrations: readonly AiCalibrationRow[];
  /** The states the capability can reach next, given each approval kind §2.2 allows from here. */
  readonly permittedNextStates: readonly AiCapabilityLifecycleState[];
}

/** R3 — capability detail with its governance history and the posture it currently publishes. */
export async function readAiCapabilityGovernanceDetail(
  deps: AiGovernanceServiceDeps,
  capabilityId: string,
): Promise<AiCapabilityGovernanceDetail> {
  const capability = await requireCapabilityById(deps, capabilityId);
  const [lifecycleEvents, calibrations] = await Promise.all([
    deps.registry.listLifecycleEvents(capabilityId),
    deps.registry.listCalibrationHistory(capabilityId),
  ]);
  return {
    capability,
    posture: aiConsumerPostureFor(capability.lifecycleState),
    lifecycleEvents,
    calibrations,
    permittedNextStates: aiPermittedNextStates(capability.lifecycleState),
  };
}

/** The §2.2 states reachable from `state` — the console's "what can I do next" list. */
export function aiPermittedNextStates(
  state: AiCapabilityLifecycleState,
): readonly AiCapabilityLifecycleState[] {
  const kinds: readonly AiLifecycleApprovalKind[] = [
    "stage_1_proposal",
    "stage_2_design_review",
    "stage_3_evaluation",
    "stage_4_pilot",
    "stage_5_ga",
    "reapproval",
    "deprecation",
    "retirement",
    "incident_demotion",
  ];
  const out = new Set<AiCapabilityLifecycleState>();
  for (const to of [
    "PROPOSED",
    "DESIGN_REVIEW",
    "EVALUATION",
    "PILOT",
    "APPROVED",
    "MONITORING",
    "DEPRECATED",
    "RETIRED",
  ] as const) {
    for (const kind of kinds) {
      if (aiLifecycleTransition(state, to, kind)) out.add(to);
    }
  }
  return [...out];
}

// ── §3.2.3 calibration ─────────────────────────────────────────────────────────────────────────────

/** R5's body. */
export interface AiCalibrationPublicationCommand extends AiCalibrationPublicationRequest {
  readonly capabilityId: string;
}

/** R5 / W6 — publish a calibration: supersede the incumbent and insert the new current row. */
export async function publishAiCapabilityCalibration(
  deps: AiGovernanceServiceDeps,
  command: AiCalibrationPublicationCommand,
): Promise<AiCalibrationRow> {
  const capability = await requireCapabilityById(deps, command.capabilityId);
  const current = await deps.registry.findCurrentCalibration(capability.id, command.backendKey);
  const at = clock(deps);
  const decision = requireAiGovernance(
    evaluateAiCalibrationPublication(
      {
        defaultBackendKey: capability.defaultBackendKey,
        allowedBackendKeys: capability.allowedBackendKeys,
      },
      current === null ? null : { id: current.id, backendKey: current.backendKey },
      command,
      at,
    ),
  );
  return deps.registry.publishCalibration(capability.id, decision.plan);
}

// ── §5.3 / W4 tenant opt-in ────────────────────────────────────────────────────────────────────────

/** R10's body plus the acting admin. */
export interface AiTenantOptInCommand {
  readonly organizationId: string;
  readonly capabilityId: string;
  readonly orgAdminMembershipId: string;
  readonly routingMode: AiRoutingMode;
  readonly pilotEnrollment: boolean;
  readonly acknowledgments: AiOptInAcknowledgmentSubmission;
  /** M2's `TenantConfiguration.ai_routing_preference` — the `default` routing mode inherits it. */
  readonly orgRoutingPreference: AiRoutingPreference;
}

/**
 * Which backend KINDS a capability can route to. `local_only`/`cloud_only` legality (§10.8) and the
 * conditional BAA/ZDR gate both hang off this, so an unregistered backend key must NOT be assumed to
 * be either kind — `resolveBackendKinds` simply omits it and the capability reads as having neither,
 * which fails the routing guard closed.
 */
async function resolveCapabilityBackendAvailability(
  deps: AiGovernanceServiceDeps,
  capability: AiCapabilityGovernanceRow,
): Promise<{ localBackendAvailable: boolean; cloudBackendAvailable: boolean }> {
  const keys = capability.allowedBackendKeys.includes(capability.defaultBackendKey)
    ? capability.allowedBackendKeys
    : [capability.defaultBackendKey, ...capability.allowedBackendKeys];
  const kinds = await deps.registry.resolveBackendKinds(keys);
  const values = [...kinds.values()];
  return {
    localBackendAvailable: values.includes("local"),
    cloudBackendAvailable: values.includes("cloud"),
  };
}

/** R10 / W4 — record a tenant opt-in after validating §5.3.1's acknowledgment gate. */
export async function recordAiTenantOptIn(
  deps: AiGovernanceServiceDeps,
  command: AiTenantOptInCommand,
): Promise<AiTenantOptInRow> {
  const capability = await requireCapabilityById(deps, command.capabilityId);
  const [prior, availability] = await Promise.all([
    deps.consent.findOptIn(command.organizationId, capability.id),
    resolveCapabilityBackendAvailability(deps, capability),
  ]);

  const evidence = await deps.evidence.resolve({
    organizationId: command.organizationId,
    baaReference: command.acknowledgments.baaReference,
    zdrContractReference: command.acknowledgments.zdrContractReference,
    clinicalReviewerMembershipId: command.acknowledgments.clinicalReviewerMembershipId,
  });

  const at = clock(deps);
  const request: AiTenantOptInRequest = {
    routingMode: command.routingMode,
    pilotEnrollment: command.pilotEnrollment,
    acknowledgments: command.acknowledgments,
  };
  const decision = requireAiGovernance(
    evaluateAiTenantOptIn(
      {
        riskTier: capability.riskTier,
        posture: aiConsumerPostureFor(capability.lifecycleState),
        ...availability,
      },
      prior?.status ?? null,
      request,
      evidence,
      command.orgRoutingPreference,
      at,
    ),
  );

  return deps.consent.upsertOptIn(command.organizationId, capability.id, {
    status: decision.patch.status,
    orgAdminMembershipId: command.orgAdminMembershipId,
    // Frozen EVIDENCE, not settings (§3.2.6): what the admin was shown and answered, at this version
    // of the wording. §3.4 keeps the column off the audit capture; the row itself is the record.
    disclosureAcknowledgments: {
      baaReference: command.acknowledgments.baaReference,
      zdrContractReference: command.acknowledgments.zdrContractReference,
      clinicalReviewerMembershipId: command.acknowledgments.clinicalReviewerMembershipId,
      clinicalReviewerAttestationText: command.acknowledgments.clinicalReviewerAttestationText,
      disclosureAccountingAcknowledged: command.acknowledgments.disclosureAccountingAcknowledged,
      acknowledgedAt: at,
      acknowledgedByMembershipId: command.orgAdminMembershipId,
      cloudReachable: decision.cloudReachable,
    },
    routingPreferenceSnapshot: decision.patch.routingPreferenceSnapshot,
    calibrationTradeOffAcknowledged: decision.patch.calibrationTradeOffAcknowledged,
    pilotEnrollment: decision.patch.pilotEnrollment,
    optedInAt: decision.patch.optedInAt,
    pausedAt: decision.patch.pausedAt,
    pausedReason: decision.patch.pausedReason,
    optedOutAt: decision.patch.optedOutAt,
    optedOutReason: decision.patch.optedOutReason,
  });
}

/** R11 / §10.6 — the tenant withdraws. Immediate; a reason is accepted, never required. */
export async function withdrawAiTenantOptIn(
  deps: AiGovernanceServiceDeps,
  command: {
    readonly organizationId: string;
    readonly capabilityId: string;
    readonly orgAdminMembershipId: string;
    readonly reason: string | null;
  },
): Promise<AiTenantOptInRow> {
  const capability = await requireCapabilityById(deps, command.capabilityId);
  const prior = await deps.consent.findOptIn(command.organizationId, capability.id);
  const decision = requireAiGovernance(
    evaluateAiTenantOptInWithdrawal(prior?.status ?? null, command.reason, clock(deps)),
  );
  return deps.consent.upsertOptIn(command.organizationId, capability.id, {
    status: decision.patch.status,
    orgAdminMembershipId: command.orgAdminMembershipId,
    optedOutAt: decision.patch.optedOutAt,
    optedOutReason: decision.patch.optedOutReason,
    pausedAt: decision.patch.pausedAt,
    pausedReason: decision.patch.pausedReason,
  });
}

/** Pause an active opt-in without discarding its acknowledgment evidence. */
export async function pauseAiTenantOptIn(
  deps: AiGovernanceServiceDeps,
  command: {
    readonly organizationId: string;
    readonly capabilityId: string;
    readonly orgAdminMembershipId: string;
    readonly reason: string;
  },
): Promise<AiTenantOptInRow> {
  const capability = await requireCapabilityById(deps, command.capabilityId);
  const prior = await deps.consent.findOptIn(command.organizationId, capability.id);
  const decision = requireAiGovernance(
    evaluateAiTenantOptInPause(prior?.status ?? null, command.reason, clock(deps)),
  );
  return deps.consent.upsertOptIn(command.organizationId, capability.id, {
    status: decision.patch.status,
    orgAdminMembershipId: command.orgAdminMembershipId,
    pausedAt: decision.patch.pausedAt,
    pausedReason: decision.patch.pausedReason,
  });
}

/** R12 — the org's opt-in records. */
export function listAiTenantOptIns(
  deps: AiGovernanceServiceDeps,
  organizationId: string,
): Promise<readonly AiTenantOptInRow[]> {
  return deps.consent.listOptIns(organizationId);
}

// ── §5.4 clinician opt-out ─────────────────────────────────────────────────────────────────────────

/** R13 / §5.4 — the clinician's personal opt-out. Idempotent: a second tap writes nothing. */
export async function recordAiClinicianOptOut(
  deps: AiGovernanceServiceDeps,
  command: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly capabilityId: string;
    readonly reason: string | null;
  },
): Promise<AiClinicianOptOutRow> {
  const capability = await requireCapabilityById(deps, command.capabilityId);
  const live = await deps.consent.findLiveOptOut(
    command.organizationId,
    command.membershipId,
    capability.id,
  );
  const decision = requireAiGovernance(
    evaluateAiClinicianOptOut(
      { clinicianOptOutSupported: capability.clinicianOptOutSupported },
      live === null ? null : { id: live.id, optedOutAt: live.optedOutAt },
      command.reason,
      clock(deps),
    ),
  );
  if (decision.alreadyOptedOut || decision.patch === null) {
    if (!live) throw new AiGovernanceError("AI_OPT_OUT_NOT_FOUND", "opt-out vanished mid-flight");
    return live;
  }
  return deps.consent.insertOptOut({
    organizationId: command.organizationId,
    membershipId: command.membershipId,
    capabilityId: capability.id,
    reason: decision.patch.reason,
    optedOutAt: decision.patch.optedOutAt,
  });
}

/** R14 / §5.4 — the clinician re-enables the capability for themselves. The row is kept. */
export async function revertAiClinicianOptOut(
  deps: AiGovernanceServiceDeps,
  command: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly capabilityId: string;
  },
): Promise<AiClinicianOptOutRow> {
  const capability = await requireCapabilityById(deps, command.capabilityId);
  const live = await deps.consent.findLiveOptOut(
    command.organizationId,
    command.membershipId,
    capability.id,
  );
  const decision = requireAiGovernance(
    evaluateAiClinicianOptOutRevert(
      live === null ? null : { id: live.id, optedOutAt: live.optedOutAt },
      clock(deps),
    ),
  );
  return deps.consent.revertOptOut(
    command.organizationId,
    decision.patch.optOutId,
    decision.patch.revertedAt,
  );
}

/** R15 — the clinician's own opt-out history (reverted rows included; that IS the history). */
export function listAiClinicianOptOuts(
  deps: AiGovernanceServiceDeps,
  organizationId: string,
  membershipId: string,
): Promise<readonly AiClinicianOptOutRow[]> {
  return deps.consent.listOptOuts(organizationId, membershipId);
}

// ── the composed governance gate ───────────────────────────────────────────────────────────────────

/**
 * Resolve the §2.2 + §5.3 + §5.4 gate for one (capability, org, clinician) triple.
 *
 * NOT a green light to invoke — the kill switch (T05), the token cap (T04) and the Phase-1 `ai.full`
 * flag are three further gates this deliberately does not apply. An unknown capability key is a
 * REFUSAL, not a 404: the caller is a consumer module asking whether it may enhance a note, and
 * `lifecycle_state_retired` is the honest answer for a capability the registry does not have — telling
 * it apart from a real capability would let a consumer enumerate the platform's registry.
 */
export async function resolveAiGovernanceGate(
  deps: AiGovernanceServiceDeps,
  query: {
    readonly capabilityKey: string;
    readonly organizationId: string;
    readonly membershipId: string;
  },
): Promise<AiGovernanceGateDecision> {
  const capability = await deps.registry.findCapabilityByKey(query.capabilityKey);
  if (!capability) {
    return {
      allowed: false,
      unavailable: { status: "capability_unavailable", reason: "lifecycle_state_retired" },
    };
  }

  const [optIn, optOut] = await Promise.all([
    deps.consent.findOptIn(query.organizationId, capability.id),
    deps.consent.findLiveOptOut(query.organizationId, query.membershipId, capability.id),
  ]);

  return aiGovernanceGateFor({
    lifecycleState: capability.lifecycleState,
    tenantOptInRequired: capability.tenantOptInRequired,
    tenantOptInStatus: optIn?.status ?? null,
    tenantPilotEnrollment: optIn?.pilotEnrollment ?? false,
    clinicianOptedOut: optOut !== null,
  });
}

/** Re-exported so a caller need not reach past this module for the risk-tier type. */
export type { AiCapabilityRiskTier };
