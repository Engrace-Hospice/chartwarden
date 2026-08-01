// Module 32 (AI Platform) — M32-T03 governance SERVICES over the in-memory stores.
//
// The pure rules are pinned in `packages/ai-platform/__tests__/governance-rules.test.ts`. What is
// tested HERE is the sequencing the services own and the rules cannot see: that a lifecycle transition
// writes the ledger row alongside the patch, that a calibration publication supersedes before it
// leaves, that the W4 evidence resolver is CONSULTED (and that the unbound default refuses), that an
// idempotent opt-out writes nothing, and that the composed gate reads all three tables.

import { beforeEach, describe, expect, it } from "vitest";

import {
  type AiCapabilityGovernanceRow,
  type AiGovernanceServiceDeps,
  type AiOptInEvidenceResolver,
  createDenyingAiOptInEvidenceResolver,
  createInMemoryAiGovernanceStores,
  listAiClinicianOptOuts,
  listAiTenantOptIns,
  publishAiCapabilityCalibration,
  readAiCapabilityGovernanceDetail,
  recordAiClinicianOptOut,
  recordAiTenantOptIn,
  registerAiCapability,
  resolveAiGovernanceGate,
  revertAiClinicianOptOut,
  transitionAiCapability,
  withdrawAiTenantOptIn,
} from "../src/modules/32-ai-platform/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const MEMBER = "22222222-2222-2222-2222-222222222222";
const ADMIN = "33333333-3333-3333-3333-333333333333";
const T0 = "2026-01-15T12:00:00.000Z";

const APPROVED_CAPABILITY: AiCapabilityGovernanceRow = {
  id: "cap-hearthnote",
  capabilityKey: "hearthnote_layer2",
  displayName: "HearthNote Layer 2 Narrative Enhancement",
  riskTier: "high",
  lifecycleState: "APPROVED",
  defaultBackendKey: "anthropic-claude-opus-4-7",
  allowedBackendKeys: ["anthropic-claude-opus-4-7", "local-llama-3.1-8b-instruct"],
  tenantOptInRequired: true,
  clinicianOptOutSupported: true,
  currentPromptTemplateKey: "hearthnote_enhancement_v1",
  firstApprovedAt: T0,
  lastReapprovedAt: null,
  nextReapprovalDueAt: "2027-01-15T12:00:00.000Z",
};

const BACKEND_KINDS = {
  "anthropic-claude-opus-4-7": "cloud",
  "local-llama-3.1-8b-instruct": "local",
} as const;

const GOOD_ACKS = {
  baaReference: "BAA-2026-014",
  zdrContractReference: "ZDR-ANTHROPIC-88",
  clinicalReviewerMembershipId: "mem-reviewer",
  clinicalReviewerAttestationText: "reviewed; appropriate for our population",
  disclosureAccountingAcknowledged: true,
  calibrationTradeOffAcknowledged: null,
};

function resolvingEvidence(): AiOptInEvidenceResolver {
  return {
    resolve: async () => ({
      baaResolved: true,
      baaExpiresAt: "2027-06-01T00:00:00.000Z",
      zdrContractOnRecord: true,
      clinicalReviewerHasSafetyLeadRole: true,
    }),
  };
}

function makeDeps(
  seed: Parameters<typeof createInMemoryAiGovernanceStores>[0] = {},
  evidence: AiOptInEvidenceResolver = resolvingEvidence(),
): AiGovernanceServiceDeps & ReturnType<typeof createInMemoryAiGovernanceStores> {
  const stores = createInMemoryAiGovernanceStores({
    backendKinds: BACKEND_KINDS,
    ...seed,
  });
  return { ...stores, evidence, now: () => T0 };
}

describe("§2.2 — capability registration and transitions", () => {
  it("registers into PROPOSED with the from_state IS NULL ledger row", async () => {
    const deps = makeDeps();
    const row = await registerAiCapability(deps, {
      capability: {
        capabilityKey: "doclens_classify",
        displayName: "DocLens Document Type Classification",
        description: "classifies an intake document",
        riskTier: "medium",
        defaultBackendKey: "local-distilbert-classifier",
        allowedBackendKeys: ["local-distilbert-classifier"],
        fallbackChainKeys: [],
        tenantOverrideAllowed: false,
        tenantOptInRequired: true,
        clinicianOptOutSupported: true,
        clinicalReviewRequired: false,
        owningRole: "ai_safety_owner",
        currentPromptTemplateKey: null,
      },
      actorMembershipId: ADMIN,
      actorRole: "ai_safety_owner",
      rationaleText: "Phase-2 promotion target; filing the proposal",
    });

    expect(row.lifecycleState).toBe("PROPOSED");
    expect(deps.lifecycleEvents).toHaveLength(1);
    expect(deps.lifecycleEvents[0]).toMatchObject({
      capabilityId: row.id,
      fromState: null,
      toState: "PROPOSED",
      approvalKind: "stage_1_proposal",
      transitionedAt: T0,
    });
  });

  it("refuses a duplicate capability_key rather than colliding on the unique index", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    await expect(
      registerAiCapability(deps, {
        capability: {
          capabilityKey: "hearthnote_layer2",
          displayName: "duplicate",
          description: "d",
          riskTier: "high",
          defaultBackendKey: "anthropic-claude-opus-4-7",
          allowedBackendKeys: [],
          fallbackChainKeys: [],
          tenantOverrideAllowed: false,
          tenantOptInRequired: true,
          clinicianOptOutSupported: true,
          clinicalReviewRequired: false,
          owningRole: "ai_safety_owner",
          currentPromptTemplateKey: null,
        },
        actorMembershipId: ADMIN,
        actorRole: "ai_safety_owner",
        rationaleText: "again",
      }),
    ).rejects.toMatchObject({ code: "AI_CAPABILITY_KEY_TAKEN", statusCode: 409 });
  });

  it("patches the capability AND appends the ledger row in one transition", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    const row = await transitionAiCapability(deps, {
      capabilityId: APPROVED_CAPABILITY.id,
      toState: "MONITORING",
      approvalKind: "stage_5_ga",
      actorRole: "ai_safety_owner",
      actorMembershipId: ADMIN,
      rationaleText: "continuous monitoring engaged",
      linkedEvaluationRunId: null,
    });

    expect(row.lifecycleState).toBe("MONITORING");
    expect(deps.lifecycleEvents).toHaveLength(1);
    expect(deps.lifecycleEvents[0]).toMatchObject({
      fromState: "APPROVED",
      toState: "MONITORING",
      actorMembershipId: ADMIN,
      // The reason defaults to §2.2's own edge label when the caller supplies none.
      reason: "Stage-5 GA (automatic on continuous monitoring engagement)",
    });
    // The GA move is not a new approval — the anchor and the due date it produced both survive.
    expect(row.firstApprovedAt).toBe(T0);
    expect(row.nextReapprovalDueAt).toBe("2027-01-15T12:00:00.000Z");
  });

  it("refuses an illegal transition and writes NOTHING", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    await expect(
      transitionAiCapability(deps, {
        capabilityId: APPROVED_CAPABILITY.id,
        toState: "PILOT",
        approvalKind: "stage_4_pilot",
        actorRole: "ai_safety_owner",
        actorMembershipId: ADMIN,
        rationaleText: "back to pilot",
        linkedEvaluationRunId: "run-1",
      }),
    ).rejects.toMatchObject({ code: "AI_LIFECYCLE_INVALID_TRANSITION", statusCode: 409 });
    expect(deps.lifecycleEvents).toHaveLength(0);
    expect(deps.capabilities[0]?.lifecycleState).toBe("APPROVED");
  });

  it("reports the posture and the permitted next states with the detail read", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    const detail = await readAiCapabilityGovernanceDetail(deps, APPROVED_CAPABILITY.id);
    expect(detail.posture).toEqual({ kind: "generally_available" });
    expect([...detail.permittedNextStates].sort()).toEqual([
      "APPROVED",
      "DEPRECATED",
      "MONITORING",
    ]);
  });

  it("404s an unknown capability id", async () => {
    const deps = makeDeps();
    await expect(readAiCapabilityGovernanceDetail(deps, "cap-nope")).rejects.toMatchObject({
      code: "AI_CAPABILITY_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("§3.2.3 — calibration publication", () => {
  it("supersedes the incumbent and leaves exactly one current row per backend", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    const first = await publishAiCapabilityCalibration(deps, {
      capabilityId: APPROVED_CAPABILITY.id,
      backendKey: "anthropic-claude-opus-4-7",
      thresholds: { hallucinationRateMax: 0.005 },
      baselineMetrics: { hallucinationRate: 0.004 },
      baselineSetAt: T0,
      baselineEvaluationRunId: "run-1",
      supersededReason: null,
    });
    const second = await publishAiCapabilityCalibration(deps, {
      capabilityId: APPROVED_CAPABILITY.id,
      backendKey: "anthropic-claude-opus-4-7",
      thresholds: { hallucinationRateMax: 0.004 },
      baselineMetrics: { hallucinationRate: 0.003 },
      baselineSetAt: T0,
      baselineEvaluationRunId: "run-2",
      supersededReason: "new golden-set run",
    });

    expect(deps.calibrations.filter((c) => c.isCurrent)).toHaveLength(1);
    const superseded = deps.calibrations.find((c) => c.id === first.id);
    expect(superseded).toMatchObject({
      isCurrent: false,
      supersededReason: "new golden-set run",
      supersededById: second.id,
    });
  });

  it("keeps the two backends' baselines independent", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    for (const backendKey of ["anthropic-claude-opus-4-7", "local-llama-3.1-8b-instruct"]) {
      await publishAiCapabilityCalibration(deps, {
        capabilityId: APPROVED_CAPABILITY.id,
        backendKey,
        thresholds: {},
        baselineMetrics: {},
        baselineSetAt: T0,
        baselineEvaluationRunId: `run-${backendKey}`,
        supersededReason: null,
      });
    }
    expect(deps.calibrations.filter((c) => c.isCurrent)).toHaveLength(2);
  });
});

describe("§5.3 / W4 — tenant opt-in", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
  });

  it("records the opt-in with the acknowledgment evidence frozen onto the row", async () => {
    const row = await recordAiTenantOptIn(deps, {
      organizationId: ORG,
      capabilityId: APPROVED_CAPABILITY.id,
      orgAdminMembershipId: ADMIN,
      routingMode: "default",
      pilotEnrollment: false,
      acknowledgments: GOOD_ACKS,
      orgRoutingPreference: "prefer_cloud",
    });
    expect(row).toMatchObject({
      status: "active",
      optedInAt: T0,
      routingPreferenceSnapshot: "prefer_cloud",
      pilotEnrollment: false,
    });
    expect(await listAiTenantOptIns(deps, ORG)).toHaveLength(1);
  });

  it("REFUSES when the W4 evidence resolver is the unbound default", async () => {
    // The fail-closed direction that matters: an M32-T06 that never binds the seams must not leave the
    // wave's consent gate silently waving cloud opt-ins through.
    const unbound = makeDeps(
      { capabilities: [APPROVED_CAPABILITY] },
      createDenyingAiOptInEvidenceResolver(),
    );
    await expect(
      recordAiTenantOptIn(unbound, {
        organizationId: ORG,
        capabilityId: APPROVED_CAPABILITY.id,
        orgAdminMembershipId: ADMIN,
        routingMode: "default",
        pilotEnrollment: false,
        acknowledgments: GOOD_ACKS,
        orgRoutingPreference: "prefer_cloud",
      }),
    ).rejects.toMatchObject({ code: "AI_OPT_IN_BAA_UNRESOLVED", statusCode: 422 });
    expect(unbound.optIns).toHaveLength(0);
  });

  it("derives local/cloud availability from the registered backends, ignoring inactive keys", async () => {
    // Only a local backend is registered → the cloud gate does not apply and `local_only` is legal.
    const localOnly = makeDeps({
      capabilities: [
        {
          ...APPROVED_CAPABILITY,
          defaultBackendKey: "local-bge-small-en",
          allowedBackendKeys: ["local-bge-small-en"],
        },
      ],
      backendKinds: { "local-bge-small-en": "local" },
    });
    const row = await recordAiTenantOptIn(localOnly, {
      organizationId: ORG,
      capabilityId: APPROVED_CAPABILITY.id,
      orgAdminMembershipId: ADMIN,
      routingMode: "local_only",
      pilotEnrollment: false,
      acknowledgments: {
        ...GOOD_ACKS,
        baaReference: null,
        zdrContractReference: null,
        calibrationTradeOffAcknowledged: "local baseline shown",
      },
      orgRoutingPreference: "prefer_cloud",
    });
    expect(row.routingPreferenceSnapshot).toBe("local_only");

    // A capability whose keys resolve to NO registered backend cannot support local_only at all.
    const unregistered = makeDeps({
      capabilities: [
        {
          ...APPROVED_CAPABILITY,
          defaultBackendKey: "local-not-registered",
          allowedBackendKeys: ["local-not-registered"],
        },
      ],
      backendKinds: {},
    });
    await expect(
      recordAiTenantOptIn(unregistered, {
        organizationId: ORG,
        capabilityId: APPROVED_CAPABILITY.id,
        orgAdminMembershipId: ADMIN,
        routingMode: "local_only",
        pilotEnrollment: false,
        acknowledgments: GOOD_ACKS,
        orgRoutingPreference: "prefer_cloud",
      }),
    ).rejects.toMatchObject({ code: "AI_OPT_IN_ROUTING_MODE_UNSUPPORTED" });
  });

  it("withdraws immediately and refuses a second withdrawal", async () => {
    await recordAiTenantOptIn(deps, {
      organizationId: ORG,
      capabilityId: APPROVED_CAPABILITY.id,
      orgAdminMembershipId: ADMIN,
      routingMode: "default",
      pilotEnrollment: false,
      acknowledgments: GOOD_ACKS,
      orgRoutingPreference: "prefer_cloud",
    });
    const withdrawn = await withdrawAiTenantOptIn(deps, {
      organizationId: ORG,
      capabilityId: APPROVED_CAPABILITY.id,
      orgAdminMembershipId: ADMIN,
      reason: null,
    });
    expect(withdrawn).toMatchObject({ status: "opted_out", optedOutAt: T0 });
    await expect(
      withdrawAiTenantOptIn(deps, {
        organizationId: ORG,
        capabilityId: APPROVED_CAPABILITY.id,
        orgAdminMembershipId: ADMIN,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: "AI_OPT_IN_ALREADY_INACTIVE" });
  });
});

describe("§5.4 — clinician opt-out", () => {
  it("writes once and treats the second tap as a no-op", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    const first = await recordAiClinicianOptOut(deps, {
      organizationId: ORG,
      membershipId: MEMBER,
      capabilityId: APPROVED_CAPABILITY.id,
      reason: "I review my own narratives",
    });
    const second = await recordAiClinicianOptOut(deps, {
      organizationId: ORG,
      membershipId: MEMBER,
      capabilityId: APPROVED_CAPABILITY.id,
      reason: null,
    });
    expect(second.id).toBe(first.id);
    expect(deps.optOuts).toHaveLength(1);
  });

  it("reverts by stamping the row, keeping the history a re-opt-out would need", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    await recordAiClinicianOptOut(deps, {
      organizationId: ORG,
      membershipId: MEMBER,
      capabilityId: APPROVED_CAPABILITY.id,
      reason: null,
    });
    await revertAiClinicianOptOut(deps, {
      organizationId: ORG,
      membershipId: MEMBER,
      capabilityId: APPROVED_CAPABILITY.id,
    });
    expect(deps.optOuts[0]?.revertedAt).toBe(T0);

    // Opting out again writes a SECOND row; the first refusal is still on file.
    await recordAiClinicianOptOut(deps, {
      organizationId: ORG,
      membershipId: MEMBER,
      capabilityId: APPROVED_CAPABILITY.id,
      reason: "changed my mind back",
    });
    expect(deps.optOuts).toHaveLength(2);
    expect(await listAiClinicianOptOuts(deps, ORG, MEMBER)).toHaveLength(2);
  });

  it("refuses a revert with nothing live behind it", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    await expect(
      revertAiClinicianOptOut(deps, {
        organizationId: ORG,
        membershipId: MEMBER,
        capabilityId: APPROVED_CAPABILITY.id,
      }),
    ).rejects.toMatchObject({ code: "AI_OPT_OUT_NOT_FOUND", statusCode: 404 });
  });

  it("lets a clinician opt out BEFORE their agency has opted in", async () => {
    // §10.6 — the refusal must survive the day the tenant flips the switch, so the write cannot be
    // gated on an opt-in that does not exist yet.
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    await recordAiClinicianOptOut(deps, {
      organizationId: ORG,
      membershipId: MEMBER,
      capabilityId: APPROVED_CAPABILITY.id,
      reason: null,
    });
    await recordAiTenantOptIn(deps, {
      organizationId: ORG,
      capabilityId: APPROVED_CAPABILITY.id,
      orgAdminMembershipId: ADMIN,
      routingMode: "default",
      pilotEnrollment: false,
      acknowledgments: GOOD_ACKS,
      orgRoutingPreference: "prefer_cloud",
    });
    const gate = await resolveAiGovernanceGate(deps, {
      capabilityKey: "hearthnote_layer2",
      organizationId: ORG,
      membershipId: MEMBER,
    });
    expect(gate).toMatchObject({
      allowed: false,
      unavailable: { reason: "clinician_opted_out" },
    });
  });
});

describe("the composed governance gate", () => {
  it("reads all three tables and allows only when every one agrees", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    await expect(
      resolveAiGovernanceGate(deps, {
        capabilityKey: "hearthnote_layer2",
        organizationId: ORG,
        membershipId: MEMBER,
      }),
    ).resolves.toMatchObject({ allowed: false, unavailable: { reason: "tenant_not_opted_in" } });

    await recordAiTenantOptIn(deps, {
      organizationId: ORG,
      capabilityId: APPROVED_CAPABILITY.id,
      orgAdminMembershipId: ADMIN,
      routingMode: "default",
      pilotEnrollment: false,
      acknowledgments: GOOD_ACKS,
      orgRoutingPreference: "prefer_cloud",
    });
    await expect(
      resolveAiGovernanceGate(deps, {
        capabilityKey: "hearthnote_layer2",
        organizationId: ORG,
        membershipId: MEMBER,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("answers an unknown capability key as a refusal, never as an existence oracle", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    const gate = await resolveAiGovernanceGate(deps, {
      capabilityKey: "not_a_capability",
      organizationId: ORG,
      membershipId: MEMBER,
    });
    expect(gate).toMatchObject({
      allowed: false,
      unavailable: { status: "capability_unavailable", reason: "lifecycle_state_retired" },
    });
    if (gate.allowed !== false) return;
    expect(gate.unavailable.currentState).toBeUndefined();
  });

  it("keeps one org's opt-in invisible to another (the RLS predicate, held by the fake too)", async () => {
    const deps = makeDeps({ capabilities: [APPROVED_CAPABILITY] });
    await recordAiTenantOptIn(deps, {
      organizationId: ORG,
      capabilityId: APPROVED_CAPABILITY.id,
      orgAdminMembershipId: ADMIN,
      routingMode: "default",
      pilotEnrollment: false,
      acknowledgments: GOOD_ACKS,
      orgRoutingPreference: "prefer_cloud",
    });
    const otherOrg = "44444444-4444-4444-4444-444444444444";
    await expect(
      resolveAiGovernanceGate(deps, {
        capabilityKey: "hearthnote_layer2",
        organizationId: otherOrg,
        membershipId: MEMBER,
      }),
    ).resolves.toMatchObject({ allowed: false, unavailable: { reason: "tenant_not_opted_in" } });
    expect(await listAiTenantOptIns(deps, otherOrg)).toHaveLength(0);
  });
});
