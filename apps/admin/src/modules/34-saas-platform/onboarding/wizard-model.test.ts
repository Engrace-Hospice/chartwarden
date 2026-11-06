// The wizard's decisions, as pure functions: what the rail shows, which actions a step offers, where "resume" lands.
// The server is the authority on every rule (sequence, owner, evidence, pending go-live); this only decides what to OFFER, so the
// operator is not shown a button the server is certain to refuse.
import { describe, expect, it } from "vitest";
import {
  type WizardStep,
  type WizardView,
  defaultStepKey,
  gatingProgress,
  railItemsOf,
  stepActionsOf,
} from "./wizard-model";

const step = (key: string, sequence: number, over: Partial<WizardStep> = {}): WizardStep => ({
  id: `task-${key}`,
  key,
  title: key,
  description: "",
  owner: "platform_ops",
  sequence,
  optional: false,
  status: "pending",
  locked: false,
  lockedBy: null,
  completionMode: "attestation",
  evidence: null,
  attestedBy: null,
  assignedToMembershipId: null,
  dueAt: null,
  startedAt: null,
  completedAt: null,
  blockerReason: null,
  skipRationale: null,
  systemSkipped: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  templateKey: key,
  isCanonical: true,
  canonicalOrder: sequence,
  ...over,
});

const view = (steps: WizardStep[], over: Partial<WizardView> = {}): WizardView => ({
  tenantAccountId: "ta-1",
  orgSlug: "cedar-ridge",
  tenantStatus: "onboarding",
  currentStepKey:
    steps.find((s) => s.status !== "done" && s.status !== "skipped" && !s.optional)?.key ?? null,
  steps,
  goLive: {
    state: "not_ready",
    attestation: null,
    failedGuards: [],
    complianceOfficerMembershipId: null,
  },
  orgProfile: { displayName: "Cedar Ridge", orgTimezone: "America/Denver" },
  currentStep: null,
  tasks: steps,
  ...over,
});

const STEPS = (): WizardStep[] => [
  step("account_created", 1, { status: "done" }),
  step("plan_contract", 2),
  step("baa_executed", 3, { locked: true, lockedBy: "plan_contract", completionMode: "auto" }),
  step("mac_configured", 4, { locked: true, lockedBy: "plan_contract", completionMode: "either" }),
  step("sample_data_loaded", 5, { optional: true, locked: true, lockedBy: "plan_contract" }),
  step("go_live_checklist_complete", 6, {
    owner: "compliance_officer",
    locked: true,
    lockedBy: "plan_contract",
  }),
];

describe("railItemsOf", () => {
  it("maps status and lock to a rail state, naming the step a locked one waits for", () => {
    const v = view(STEPS());
    const rail = railItemsOf(v);
    expect(rail.map((r) => [r.key, r.state])).toEqual([
      ["account_created", "done"],
      ["plan_contract", "current"],
      ["baa_executed", "locked"],
      ["mac_configured", "locked"],
      ["sample_data_loaded", "locked"],
      ["go_live_checklist_complete", "locked"],
    ]);
    expect(rail[2]?.lockedReason).toBe("Finish plan_contract first");
  });

  it("shows blocked and skipped, and an unlocked step that is not the current one as to do", () => {
    const steps = STEPS();
    steps[1] = step("plan_contract", 2, {
      status: "blocked",
      blockerReason: "waiting on order form",
    });
    steps[2] = step("baa_executed", 3, { status: "skipped" });
    steps[3] = step("mac_configured", 4);
    const rail = railItemsOf(view(steps));
    expect(rail[1]?.state).toBe("blocked");
    expect(rail[2]?.state).toBe("skipped");
    expect(rail[3]?.state).toBe("todo");
  });

  it("captions each step with who owns it, and says an automatic skip was the system's", () => {
    const steps = STEPS();
    steps[3] = step("mac_configured", 4, {
      status: "skipped",
      skipRationale: "bills outside ChartWarden",
      systemSkipped: true,
    });
    const rail = railItemsOf(view(steps));
    expect(rail[0]?.caption).toBe("Platform operator");
    expect(rail[3]?.caption).toBe("Skipped automatically: bills outside ChartWarden");
    expect(rail[5]?.caption).toBe("Compliance officer");
  });

  it("never takes a person's skip for the system's, whatever words they typed: only the server's flag decides", () => {
    const steps = STEPS();
    steps[3] = step("mac_configured", 4, {
      status: "skipped",
      skipRationale: "bills outside ChartWarden",
      systemSkipped: false,
    });
    expect(railItemsOf(view(steps))[3]?.caption).toBe("Platform operator");
  });

  it("uses the step's own title as its label", () => {
    const steps = [step("account_created", 1, { title: "Organisation" })];
    expect(railItemsOf(view(steps))[0]?.label).toBe("Organisation");
  });
});

describe("stepActionsOf", () => {
  it("offers evidence-attest on an open attestation step the operator may act on", () => {
    const v = view(STEPS());
    const a = stepActionsOf(v.steps[1] as WizardStep, v);
    expect(a).toMatchObject({
      canAttest: true,
      canSkip: false,
      canReopen: false,
      readOnlyReason: null,
    });
  });

  it("offers nothing on a locked step and says why", () => {
    const v = view(STEPS());
    const a = stepActionsOf(v.steps[3] as WizardStep, v);
    expect(a.canAttest).toBe(false);
    expect(a.canSkip).toBe(false);
    expect(a.readOnlyReason).toMatch(/plan_contract/);
  });

  it("never offers attest on an automatic step: the platform verifies it from its own data", () => {
    const steps = STEPS();
    steps[2] = step("baa_executed", 3, { completionMode: "auto" });
    const v = view(steps);
    expect(stepActionsOf(v.steps[2] as WizardStep, v).canAttest).toBe(false);
  });

  it("offers skip only on the steps where the owner chose it: MAC, payer enrollment, DoseSpot and sample data", () => {
    const keys = [
      "mac_configured",
      "payer_enrollment",
      "dosespot_kickoff_initiated",
      "sample_data_loaded",
      "account_created",
      "plan_contract",
      "baa_executed",
      "ccn_registered",
      "locations_seeded",
      "first_admin_invited",
      "compliance_officer_assigned",
      "clearinghouse_selected",
    ];
    const steps = keys.map((k, i) => step(k, i + 1, { completionMode: "either" }));
    const v = view(steps);
    const skippable = steps
      .filter((s) => stepActionsOf(s, v).canSkip)
      .map((s) => s.key)
      .sort();
    expect(skippable).toEqual(
      [
        "dosespot_kickoff_initiated",
        "mac_configured",
        "payer_enrollment",
        "sample_data_loaded",
      ].sort(),
    );
  });

  it("never offers attest or skip on go-live: it is settled by the two-party approval", () => {
    const steps = STEPS().map((s) => ({ ...s, locked: false, lockedBy: null }));
    const v = view(steps);
    const a = stepActionsOf(v.steps[5] as WizardStep, v);
    expect(a.canAttest).toBe(false);
    expect(a.canSkip).toBe(false);
    expect(a.canReopen).toBe(false);
  });

  it("offers re-open on a settled step, but not while a go-live attestation is pending, and says what to do instead", () => {
    const steps = STEPS();
    const v = view(steps);
    expect(stepActionsOf(v.steps[0] as WizardStep, v)).toMatchObject({ canReopen: true });
    const pending = view(steps, {
      goLive: {
        state: "awaiting_approval",
        attestation: null,
        failedGuards: [],
        complianceOfficerMembershipId: null,
      },
    });
    const a = stepActionsOf(pending.steps[0] as WizardStep, pending);
    expect(a.canReopen).toBe(false);
    expect(a.reopenBlockedBy).toBe("go_live_pending");
  });

  it("is read-only once the tenant is not onboarding", () => {
    const v = view(STEPS(), { tenantStatus: "provisioning" });
    const a = stepActionsOf(v.steps[1] as WizardStep, v);
    expect(a).toMatchObject({ canAttest: false, canSkip: false, canReopen: false });
    expect(a.readOnlyReason).toMatch(/provisioning/i);
    const live = view(STEPS(), { tenantStatus: "active" });
    expect(stepActionsOf(live.steps[0] as WizardStep, live).readOnlyReason).toMatch(/live|active/i);
  });

  it("a step with no task row yet (a null id) cannot be acted on", () => {
    const steps = STEPS();
    steps[1] = step("plan_contract", 2, { id: null });
    const v = view(steps);
    expect(stepActionsOf(v.steps[1] as WizardStep, v).canAttest).toBe(false);
  });
});

describe("defaultStepKey (resume)", () => {
  it("resumes at the current step", () => {
    expect(defaultStepKey(view(STEPS()))).toBe("plan_contract");
  });

  it("lands on go-live when every earlier step is settled, and on the first step when there is nothing", () => {
    const steps = STEPS().map((s) =>
      s.key === "go_live_checklist_complete"
        ? { ...s, locked: false }
        : { ...s, status: "done" as const },
    );
    expect(defaultStepKey(view(steps, { currentStepKey: "go_live_checklist_complete" }))).toBe(
      "go_live_checklist_complete",
    );
    expect(defaultStepKey(view([], { currentStepKey: null }))).toBeNull();
  });

  it("falls back to the last step when everything is settled", () => {
    const steps = STEPS().map((s) => ({ ...s, status: "done" as const, locked: false }));
    expect(defaultStepKey(view(steps, { currentStepKey: null }))).toBe(
      "go_live_checklist_complete",
    );
  });
});

describe("gatingProgress", () => {
  it("counts settled gating steps only", () => {
    const steps = STEPS();
    steps[0] = step("account_created", 1, { status: "done" });
    steps[1] = step("plan_contract", 2, { status: "skipped" });
    steps[4] = step("sample_data_loaded", 5, { optional: true, status: "done" });
    expect(gatingProgress(view(steps))).toEqual({ done: 2, total: 5 });
  });
});
