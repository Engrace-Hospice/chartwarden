// Module 32 — the safety layer end to end over the in-memory stores (M32-T05).
//
// The pure rules are pinned in `packages/ai-platform/__tests__/safety-rules.test.ts`. What THIS file
// proves is the part only the services can be wrong about: that `createAiKillSwitchGate` actually fills
// the port M32-T04 left required and unbound, that the W5 follow-up worker is idempotent against a
// switch a prior incident already flipped, that the triage write commits independently of the follow-up,
// and that D10's evidence check refuses a citation the presence-only gate waved through.

import { describe, expect, it } from "vitest";

import { AiGovernanceError } from "@wardenx/ai-platform";

import { transitionAiCapability } from "../src/modules/32-ai-platform/governance/service";
import { createInMemoryAiGovernanceStores } from "../src/modules/32-ai-platform/governance/store";
import type { AiCapabilityGovernanceRow } from "../src/modules/32-ai-platform/governance/store";
import {
  activateAiKillSwitch,
  activateAiKillSwitchAs,
  createAiKillSwitchGate,
  createInMemoryAiSafetyStores,
  deactivateAiKillSwitch,
  deactivateAiKillSwitchAs,
  executeAiHallucinationFollowUp,
  fileAiHallucinationReport,
  listActiveAiKillSwitches,
  queueAiEvaluationRun,
  readAiKillSwitchVerdict,
  transitionAiEvaluationRun,
  triageAiHallucinationReport,
} from "../src/modules/32-ai-platform/safety";
import type { AiSafetyServiceDeps } from "../src/modules/32-ai-platform/safety";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CAP_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const PROVIDER_ENTITY = "44444444-4444-4444-8444-444444444444";
const T0 = "2026-08-15T12:00:00.000Z";

const CAPABILITY: AiCapabilityGovernanceRow = {
  id: CAP_ID,
  capabilityKey: "hearthnote_layer2",
  displayName: "HearthNote Layer 2",
  riskTier: "high",
  lifecycleState: "APPROVED",
  defaultBackendKey: "anthropic-claude",
  allowedBackendKeys: ["anthropic-claude"],
  tenantOptInRequired: true,
  clinicianOptOutSupported: true,
  currentPromptTemplateKey: "hearthnote_enhancement_v1",
  firstApprovedAt: "2026-06-01T00:00:00.000Z",
  lastReapprovedAt: null,
  nextReapprovalDueAt: "2027-06-01T00:00:00.000Z",
};

function deps(
  overrides: {
    readonly capability?: AiCapabilityGovernanceRow;
    readonly safety?: ReturnType<typeof createInMemoryAiSafetyStores>;
  } = {},
): AiSafetyServiceDeps & { safety: ReturnType<typeof createInMemoryAiSafetyStores> } {
  const governance = createInMemoryAiGovernanceStores({
    capabilities: [overrides.capability ?? CAPABILITY],
  });
  const safety = overrides.safety ?? createInMemoryAiSafetyStores();
  return {
    killSwitches: safety.killSwitches,
    reports: safety.reports,
    evaluations: safety.evaluations,
    registry: governance.registry,
    now: () => T0,
    safety,
  };
}

const ACTIVATION = {
  organizationId: ORG,
  capabilityId: CAP_ID,
  reason: "manual_safety_pause" as const,
  actorKind: "ai_safety_owner" as const,
  actorMembershipId: MEMBERSHIP,
  activationMessage: "paused pending review",
};

// ── W3 kill switch ─────────────────────────────────────────────────────────────────────────────────

describe("kill switch service (R7/R8/R9, W3)", () => {
  it("writes a tenant activation on the tenant credential and a platform one on the bypass", async () => {
    const d = deps();
    const tenant = await activateAiKillSwitch(d, ACTIVATION);
    expect(tenant.scope).toBe("tenant");
    expect(tenant.usedPlatformCredential).toBe(false);

    const platform = await activateAiKillSwitch(d, {
      ...ACTIVATION,
      organizationId: null,
      reason: "sev1_hallucination",
    });
    expect(platform.scope).toBe("platform");
    expect(platform.usedPlatformCredential).toBe(true);
    expect(platform.severity).toBe("sev1");
    expect(platform.demotion).toMatchObject({ required: true, toState: "DEPRECATED" });
  });

  it("refuses an activation for a capability nobody registered", async () => {
    const d = deps();
    await expect(
      activateAiKillSwitch(d, { ...ACTIVATION, capabilityId: "cap-missing" }),
    ).rejects.toThrow(AiGovernanceError);
  });

  it("keeps the activation attribution when the switch is lifted", async () => {
    const d = deps();
    await activateAiKillSwitch(d, ACTIVATION);
    const lifted = await deactivateAiKillSwitch(d, {
      organizationId: ORG,
      capabilityId: CAP_ID,
      actorKind: "ai_safety_owner",
      actorMembershipId: MEMBERSHIP,
      resolutionNarrative: "vendor confirmed the regression is rolled back",
    });
    expect(lifted.row.active).toBe(false);
    // The incident record survives the lift — this is what a post-mortem reads.
    expect(lifted.row.activationActorMembershipId).toBe(MEMBERSHIP);
    expect(lifted.row.activationMessage).toBe("paused pending review");
    expect(lifted.row.deactivationMessage).toContain("rolled back");
  });

  it("fills the AiKillSwitchGate M32-T04 left required and unbound", async () => {
    const d = deps();
    const gate = createAiKillSwitchGate(d.killSwitches);
    expect(await gate.isActive(ORG, CAP_ID)).toBe(false);
    await activateAiKillSwitch(d, ACTIVATION);
    expect(await gate.isActive(ORG, CAP_ID)).toBe(true);
    // ...and another tenant is unaffected by this tenant's pause.
    expect(await gate.isActive(OTHER_ORG, CAP_ID)).toBe(false);
  });

  it("stops every tenant on a platform kill, including one that never paused anything", async () => {
    const d = deps();
    await activateAiKillSwitch(d, {
      ...ACTIVATION,
      organizationId: null,
      reason: "sev1_hallucination",
    });
    const gate = createAiKillSwitchGate(d.killSwitches);
    expect(await gate.isActive(OTHER_ORG, CAP_ID)).toBe(true);

    const verdict = await readAiKillSwitchVerdict(d, OTHER_ORG, CAP_ID);
    expect(verdict).toMatchObject({ killed: true, scope: "platform", severity: "sev1" });
  });

  it("shows a caller the platform row plus their own, and nobody else's", async () => {
    const d = deps();
    await activateAiKillSwitch(d, ACTIVATION);
    await activateAiKillSwitch(d, { ...ACTIVATION, organizationId: OTHER_ORG });
    const listed = await listActiveAiKillSwitches(d, ORG);
    expect(listed.map((r) => r.organizationId)).toEqual([ORG]);
  });
});

// ── GAP-096 — the kill-switch service enforces the caller's authority itself ─────────────────────────
// The route's ABAC guard is the cheap early refusal; the service is the authority (guards.ts rule 3). A
// platform (NULL-org) row stops a capability for EVERY tenant and is written through the platform
// credential, which RLS does not constrain — so nothing below the guard may rely on it having run.

describe("GAP-096 — kill switch caller authority (service layer)", () => {
  const TENANT_CALLER = { kind: "tenant", organizationId: ORG } as const;
  const PLATFORM_CALLER = { kind: "platform" } as const;

  it("refuses a tenant caller a platform (NULL-org) activation and writes nothing", async () => {
    const d = deps();
    await expect(
      activateAiKillSwitchAs(d, TENANT_CALLER, { ...ACTIVATION, organizationId: null }),
    ).rejects.toThrow(/platform/i);
    expect(await d.killSwitches.findScopedRow(null, CAP_ID)).toBeNull();
  });

  it("refuses a tenant caller another tenant's org and writes nothing", async () => {
    const d = deps();
    await expect(
      activateAiKillSwitchAs(d, TENANT_CALLER, { ...ACTIVATION, organizationId: OTHER_ORG }),
    ).rejects.toThrow(/own organization/i);
    expect(await d.killSwitches.findScopedRow(OTHER_ORG, CAP_ID)).toBeNull();
  });

  it("lets a tenant caller stop the capability for its OWN org on the tenant credential", async () => {
    const d = deps();
    const outcome = await activateAiKillSwitchAs(d, TENANT_CALLER, ACTIVATION);
    expect(outcome.scope).toBe("tenant");
    expect(outcome.usedPlatformCredential).toBe(false);
    expect(await readAiKillSwitchVerdict(d, OTHER_ORG, CAP_ID)).toMatchObject({ killed: false });
  });

  it("lets a platform caller write the NULL-org row", async () => {
    const d = deps();
    const outcome = await activateAiKillSwitchAs(d, PLATFORM_CALLER, {
      ...ACTIVATION,
      organizationId: null,
    });
    expect(outcome.scope).toBe("platform");
    expect(outcome.usedPlatformCredential).toBe(true);
  });

  it("refuses a tenant caller lifting a platform switch, and leaves it active", async () => {
    const d = deps();
    await activateAiKillSwitchAs(d, PLATFORM_CALLER, { ...ACTIVATION, organizationId: null });
    await expect(
      deactivateAiKillSwitchAs(d, TENANT_CALLER, {
        organizationId: null,
        capabilityId: CAP_ID,
        actorKind: "ai_safety_owner",
        actorMembershipId: MEMBERSHIP,
        resolutionNarrative: "tenant tries to lift the platform stop",
      }),
    ).rejects.toThrow(/platform/i);
    expect((await d.killSwitches.findScopedRow(null, CAP_ID))?.active).toBe(true);
  });
});

// ── W5 hallucination workflow ──────────────────────────────────────────────────────────────────────

const FILING = {
  organizationId: ORG,
  providerEntityId: PROVIDER_ENTITY,
  locationId: null,
  invocationId: "ainv-1",
  capabilityId: CAP_ID,
  reporterMembershipId: MEMBERSHIP,
  reporterRole: "registered_nurse",
  severity: "high" as const,
  hallucinationKind: "wrong_dose" as const,
  reporterNarrativeCipher: new Uint8Array([7, 7, 7]),
};

describe("hallucination workflow (R18/R19/R20, W5)", () => {
  it("files an open report and returns no follow-up for a non-critical severity", async () => {
    const d = deps();
    const { report, followUp } = await fileAiHallucinationReport(d, FILING);
    expect(report.triageStatus).toBe("open");
    expect(report.reportedAt).toBe(T0);
    expect(followUp.action).toBe("none");
  });

  it("returns the SEV-1 plan at FILING time for a critical report", async () => {
    const d = deps();
    const { followUp } = await fileAiHallucinationReport(d, { ...FILING, severity: "critical" });
    expect(followUp).toEqual({
      action: "raise_sev1",
      killSwitchReason: "sev1_hallucination",
      demotesCapability: true,
    });
  });

  it("walks the triage machine and computes the follow-up from the disposition", async () => {
    const d = deps();
    const { report } = await fileAiHallucinationReport(d, FILING);
    await triageAiHallucinationReport(d, ORG, report.id, {
      toStatus: "investigating",
      triageOwnerMembershipId: "mem-owner",
      disposition: null,
      mitigationActionRef: null,
      severity: "high",
    });
    const triaged = await triageAiHallucinationReport(d, ORG, report.id, {
      toStatus: "root_cause_identified",
      triageOwnerMembershipId: "mem-owner",
      disposition: "model_rollback_required",
      mitigationActionRef: "INC-4412",
      severity: "high",
    });
    expect(triaged.report.triageStatus).toBe("root_cause_identified");
    expect(triaged.report.triageDisposition).toBe("model_rollback_required");
    expect(triaged.followUp.action).toBe("deprecate_capability");
    expect(triaged.followUp.killSwitchReason).toBe("sev2_hallucination");
  });

  it("refuses to triage another tenant's report", async () => {
    const d = deps();
    const { report } = await fileAiHallucinationReport(d, FILING);
    await expect(
      triageAiHallucinationReport(d, OTHER_ORG, report.id, {
        toStatus: "investigating",
        triageOwnerMembershipId: "mem-owner",
        disposition: null,
        mitigationActionRef: null,
        severity: "high",
      }),
    ).rejects.toThrow(AiGovernanceError);
  });

  it("executes the follow-up as a PLATFORM kill attributed to the automation, not the triager", async () => {
    const d = deps();
    const result = await executeAiHallucinationFollowUp(
      d,
      {
        action: "deprecate_capability",
        killSwitchReason: "sev2_hallucination",
        demotesCapability: true,
      },
      CAP_ID,
    );
    expect(result.killSwitch?.scope).toBe("platform");
    expect(result.killSwitch?.row.activationActorKind).toBe("automated_lifecycle_demotion");
    expect(result.killSwitch?.row.activationActorMembershipId).toBeNull();
  });

  it("is idempotent against a switch a prior incident already flipped", async () => {
    const d = deps();
    await activateAiKillSwitch(d, {
      ...ACTIVATION,
      organizationId: null,
      reason: "sev1_hallucination",
    });
    // The rule refuses a second activation (R7's posture); the WORKER must not fail on it, or the job
    // retries forever against a switch that is already doing its job.
    const result = await executeAiHallucinationFollowUp(
      d,
      { action: "raise_sev1", killSwitchReason: "sev1_hallucination", demotesCapability: true },
      CAP_ID,
    );
    expect(result.killSwitchAlreadyActive).toBe(true);
    expect(result.killSwitch).toBeNull();
    expect(result.demotion).toMatchObject({ required: true, toState: "DEPRECATED" });
  });

  it("plans no kill at all when the disposition demands none", async () => {
    const d = deps();
    const result = await executeAiHallucinationFollowUp(
      d,
      { action: "notify_clinical_lead", killSwitchReason: null, demotesCapability: false },
      CAP_ID,
    );
    expect(result.killSwitch).toBeNull();
    expect(result.killSwitchAlreadyActive).toBe(false);
    expect(d.safety.killSwitchRows).toHaveLength(0);
  });
});

// ── evaluation runs + D10 evidence ─────────────────────────────────────────────────────────────────

const RUN = {
  capabilityId: CAP_ID,
  backendId: "backend-1",
  datasetVersionRef: "dvc://golden/hearthnote@v4",
  mlflowRunId: "mlflow-run-991",
  stage: "stage_3_evaluation" as const,
  summaryMetrics: { f1: 0.94 },
  initiatedByMembershipId: MEMBERSHIP,
};

describe("evaluation runs (R26–R28, W6)", () => {
  it("queues a run pending and undecided", async () => {
    const d = deps();
    const run = await queueAiEvaluationRun(d, RUN);
    expect(run.status).toBe("pending");
    expect(run.decision).toBe("no_decision");
    expect(run.createdAt).toBe(T0);
  });

  it("refuses a run against a capability nobody registered", async () => {
    const d = deps();
    await expect(queueAiEvaluationRun(d, { ...RUN, capabilityId: "cap-missing" })).rejects.toThrow(
      AiGovernanceError,
    );
  });

  it("carries the run to a passed, approved terminal state", async () => {
    const d = deps();
    const queued = await queueAiEvaluationRun(d, RUN);
    await transitionAiEvaluationRun(d, queued.id, {
      toStatus: "in_progress",
      decision: "no_decision",
      summaryMetrics: null,
    });
    const passed = await transitionAiEvaluationRun(d, queued.id, {
      toStatus: "passed",
      decision: "approve_for_ga",
      summaryMetrics: { f1: 0.96 },
    });
    expect(passed.status).toBe("passed");
    expect(passed.decision).toBe("approve_for_ga");
    expect(passed.completedAt).toBe(T0);
  });

  it("refuses a transition on a run that does not exist", async () => {
    const d = deps();
    await expect(
      transitionAiEvaluationRun(d, "aer-missing", {
        toStatus: "in_progress",
        decision: "no_decision",
        summaryMetrics: null,
      }),
    ).rejects.toThrow(AiGovernanceError);
  });
});

describe("D10 evidence, bound into the lifecycle gate", () => {
  async function evidenceFixture(runStage: "stage_3_evaluation" | "post_incident") {
    const governance = createInMemoryAiGovernanceStores({
      capabilities: [{ ...CAPABILITY, lifecycleState: "EVALUATION" }],
    });
    const safety = createInMemoryAiSafetyStores();
    const safetyDeps: AiSafetyServiceDeps = {
      killSwitches: safety.killSwitches,
      reports: safety.reports,
      evaluations: safety.evaluations,
      registry: governance.registry,
      now: () => T0,
    };
    const queued = await queueAiEvaluationRun(safetyDeps, { ...RUN, stage: runStage });
    await transitionAiEvaluationRun(safetyDeps, queued.id, {
      toStatus: "in_progress",
      decision: "no_decision",
      summaryMetrics: null,
    });
    const passed = await transitionAiEvaluationRun(safetyDeps, queued.id, {
      toStatus: "passed",
      decision: "approve_for_pilot",
      summaryMetrics: { f1: 0.96 },
    });
    return { governance, safety, runId: passed.id };
  }

  const transitionCommand = (linkedEvaluationRunId: string) => ({
    capabilityId: CAP_ID,
    toState: "PILOT" as const,
    approvalKind: "stage_3_evaluation" as const,
    actorRole: "ai_safety_owner" as const,
    actorMembershipId: MEMBERSHIP,
    rationaleText: "golden-set replay met every threshold",
    linkedEvaluationRunId,
  });

  it("accepts a passed stage-3 run for the stage-3 gate", async () => {
    const { governance, safety, runId } = await evidenceFixture("stage_3_evaluation");
    const row = await transitionAiCapability(
      {
        registry: governance.registry,
        consent: governance.consent,
        evidence: { resolve: async () => ({}) as never },
        evaluations: { findRun: (id) => safety.evaluations.findRun(id) },
        now: () => T0,
      },
      transitionCommand(runId),
    );
    expect(row.lifecycleState).toBe("PILOT");
  });

  // `ChartWardenError`'s MESSAGE is the detail, not the code — asserting on the message would pass on any
  // refusal that happened to mention the same words.
  async function expectRefusalCode(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toThrow(AiGovernanceError);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(AiGovernanceError);
      expect((error as AiGovernanceError).code).toBe(code);
    });
  }

  it("refuses a post_incident run cited as stage-3 evidence — the presence check cannot see this", async () => {
    const { governance, safety, runId } = await evidenceFixture("post_incident");
    await expectRefusalCode(
      transitionAiCapability(
        {
          registry: governance.registry,
          consent: governance.consent,
          evidence: { resolve: async () => ({}) as never },
          evaluations: { findRun: (id) => safety.evaluations.findRun(id) },
          now: () => T0,
        },
        transitionCommand(runId),
      ),
      "AI_EVALUATION_RUN_EVIDENCE_INVALID",
    );
  });

  it("refuses a citation of a run that does not exist", async () => {
    const { governance, safety } = await evidenceFixture("stage_3_evaluation");
    await expectRefusalCode(
      transitionAiCapability(
        {
          registry: governance.registry,
          consent: governance.consent,
          evidence: { resolve: async () => ({}) as never },
          evaluations: { findRun: (id) => safety.evaluations.findRun(id) },
          now: () => T0,
        },
        transitionCommand("aer-missing"),
      ),
      "AI_EVALUATION_RUN_NOT_FOUND",
    );
  });

  it("keeps M32-T03's presence-only behaviour when the resolver is unbound", async () => {
    const { governance, runId } = await evidenceFixture("post_incident");
    const row = await transitionAiCapability(
      {
        registry: governance.registry,
        consent: governance.consent,
        evidence: { resolve: async () => ({}) as never },
        now: () => T0,
      },
      transitionCommand(runId),
    );
    // The same citation the bound resolver refuses. This is the documented weaker default, pinned so
    // the difference is a decision rather than a surprise.
    expect(row.lifecycleState).toBe("PILOT");
  });
});
