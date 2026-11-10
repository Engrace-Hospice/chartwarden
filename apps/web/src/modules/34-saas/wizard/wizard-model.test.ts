// The tenant wizard's decisions as pure functions: which actions a step offers to which person, and what is said when none is.
// The server owns every rule (owner, sequence, evidence, step-up, the pending go-live attestation); this only decides what to OFFER.
import { describe, expect, it } from "vitest";
import { wizardStep, wizardView } from "./test-support";
import {
  GO_LIVE_STEP_KEY,
  ONBOARDING_KEYS,
  OWNER_LABEL,
  type WizardStep,
  type WizardView,
  closedReasonOf,
  stepActionsOf,
} from "./wizard-model";

const ADMIN_KEYS: ReadonlySet<string> = new Set([
  ONBOARDING_KEYS.readOwn,
  ONBOARDING_KEYS.update,
  ONBOARDING_KEYS.manageOwn,
]);
const ADMIN = ["org_admin"];
const OFFICER_KEYS: ReadonlySet<string> = new Set([
  ONBOARDING_KEYS.readOwn,
  ONBOARDING_KEYS.goLiveAttest,
]);
const OFFICER = ["compliance_officer"];

const step = (key: string, over: Partial<WizardStep> = {}): WizardStep =>
  wizardStep(key, 1, { owner: "either", ...over });
const viewOf = (s: WizardStep, over: Partial<WizardView> = {}): WizardView => wizardView([s], over);
const actions = (
  s: WizardStep,
  held: ReadonlySet<string> = ADMIN_KEYS,
  roles: readonly string[] = ADMIN,
  over: Partial<WizardView> = {},
) => stepActionsOf(s, viewOf(s, over), held, roles);

describe("tenant owner labels", () => {
  it("speak to the tenant, never of an operator", () => {
    expect(OWNER_LABEL).toEqual({
      platform_ops: "ChartWarden",
      org_admin: "Your administrator",
      compliance_officer: "Your compliance officer",
      either: "Your administrator or ChartWarden",
    });
  });
});

describe("stepActionsOf: who may act on an open step", () => {
  it("offers Start, Mark done and Re-open per the owner rule for the organization's administrator", () => {
    const pending = actions(step("ccn_registered"));
    expect(pending).toMatchObject({ canStart: true, canAttest: true, canReopen: false });
    const done = actions(step("ccn_registered", { status: "done" }));
    expect(done).toMatchObject({ canStart: false, canAttest: false, canReopen: true });
  });

  it("offers nothing on a ChartWarden-owned step, and says whose it is", () => {
    const a = actions(step("plan_contract", { owner: "platform_ops" }));
    expect(a).toMatchObject({
      canStart: false,
      canAttest: false,
      canSkip: false,
      canReopen: false,
    });
    expect(a.readOnlyReason).toMatch(/ChartWarden completes this step/);
  });

  it("treats the administrator role as not enough: the owner rule needs the org_admin role itself", () => {
    const a = actions(step("ccn_registered"), ADMIN_KEYS, ["administrator"]);
    expect(a.canAttest).toBe(false);
    expect(a.readOnlyReason).toMatch(/administrator/);
  });

  it("makes the compliance officer read-only everywhere except go-live", () => {
    for (const owner of ["either", "org_admin", "platform_ops"] as const) {
      const a = actions(step("ccn_registered", { owner }), OFFICER_KEYS, OFFICER);
      expect(a).toMatchObject({ canStart: false, canAttest: false, canSkip: false });
    }
    const officerStep = step("compliance_officer_assigned", { owner: "compliance_officer" });
    expect(actions(officerStep, OFFICER_KEYS, OFFICER).canAttest).toBe(false); // no onboarding.update key
    expect(
      actions(officerStep, new Set([...OFFICER_KEYS, ONBOARDING_KEYS.update]), OFFICER).canAttest,
    ).toBe(true);
  });

  it("fails closed when no key or role is known", () => {
    expect(actions(step("ccn_registered"), new Set(), [])).toMatchObject({
      canStart: false,
      canAttest: false,
      canSkip: false,
      canReopen: false,
    });
  });

  it("never offers Mark done on a step the platform settles by itself", () => {
    expect(actions(step("first_admin_invited", { completionMode: "auto" })).canAttest).toBe(false);
  });

  it("never offers any frame action on the go-live step: the panel's own attest settles it", () => {
    const goLive = step(GO_LIVE_STEP_KEY, { owner: "compliance_officer" });
    for (const [held, roles] of [
      [OFFICER_KEYS, OFFICER],
      [ADMIN_KEYS, ADMIN],
    ] as const) {
      expect(actions(goLive, held, roles)).toMatchObject({
        canStart: false,
        canAttest: false,
        canSkip: false,
        canReopen: false,
      });
    }
  });
});

describe("stepActionsOf: the skip action (steps 8, 9, 10 only)", () => {
  it.each(["mac_configured", "payer_enrollment", "dosespot_kickoff_initiated"])(
    "offers Skip on %s to the organization's administrator when the server says the tenant may",
    (key) => {
      expect(actions(step(key)).canSkip).toBe(true);
    },
  );

  it("does not offer Skip when the server says the tenant may not", () => {
    expect(actions(step("mac_configured", { tenantSkippable: false })).canSkip).toBe(false);
  });

  it("never offers Skip on sample data (step 13) or on a step the operator added, whatever the flag says", () => {
    const sample = step("sample_data_loaded", { owner: "platform_ops", tenantSkippable: true });
    expect(actions(sample).canSkip).toBe(false);
    const added = step("custom_check", { tenantSkippable: true, isCanonical: false });
    expect(actions(added).canSkip).toBe(false);
  });

  it("needs the org_admin role and the manage key, not just the update key", () => {
    const s = step("payer_enrollment");
    expect(actions(s, new Set([ONBOARDING_KEYS.update]), ADMIN).canSkip).toBe(false);
    expect(actions(s, ADMIN_KEYS, ["administrator"]).canSkip).toBe(false);
  });

  it("is not offered once the step is settled", () => {
    expect(
      actions(step("mac_configured", { status: "skipped", skippedBy: "tenant" })).canSkip,
    ).toBe(false);
  });
});

describe("stepActionsOf: why a step is closed", () => {
  it("is closed while provisioning, after go-live, and for any other tenant status", () => {
    expect(closedReasonOf(step("ccn_registered"), viewOf(step("ccn_registered")))).toBeNull();
    const reasons = ["provisioning", "active", "suspended"].map((tenantStatus) =>
      closedReasonOf(step("ccn_registered"), viewOf(step("ccn_registered"), { tenantStatus })),
    );
    expect(reasons[0]).toMatch(/setting up/);
    expect(reasons[1]).toMatch(/live/);
    expect(reasons[2]).toMatch(/closed/);
    expect(
      actions(step("ccn_registered"), ADMIN_KEYS, ADMIN, { tenantStatus: "active" }),
    ).toMatchObject({
      canAttest: false,
      canSkip: false,
      canReopen: false,
    });
  });

  it("is closed for a locked step until the earlier one is settled, naming that step", () => {
    const locked = step("payer_enrollment", { locked: true, lockedBy: "mac_configured" });
    const view = wizardView([step("mac_configured", { title: "MAC credentials" }), locked]);
    const a = stepActionsOf(locked, view, ADMIN_KEYS, ADMIN);
    expect(a.closedReason).toBe("Finish MAC credentials first.");
    expect(a).toMatchObject({ canStart: false, canAttest: false, canSkip: false });
  });

  it("a settled locked step still reads as settled, and can be re-opened", () => {
    const settled = step("mac_configured", { status: "done", locked: true, lockedBy: "x" });
    expect(actions(settled).closedReason).toBeNull();
  });

  it("says the step does not exist yet when it has no task id", () => {
    expect(actions(step("ccn_registered", { id: null })).closedReason).toMatch(/setup finishes/);
  });
});

describe("stepActionsOf: re-open while a go-live attestation waits", () => {
  const attestation = {
    id: "g-1",
    status: "pending" as const,
    attestedByMembershipId: "m-officer",
    attestedAt: "2026-11-02T00:00:00.000Z",
    expiresAt: null,
    attestationNote: null,
    approvedByMembershipId: null,
    approvedByLabel: null,
    approvedAt: null,
    approvalReason: null,
    revokedByMembershipId: null,
    revokedByLabel: null,
    revokedAt: null,
    revokeReason: null,
  };
  it("is blocked, and says why", () => {
    const a = actions(step("ccn_registered", { status: "done" }), ADMIN_KEYS, ADMIN, {
      goLive: {
        state: "awaiting_approval",
        attestation,
        failedGuards: [],
        complianceOfficerMembershipId: "m-officer",
      },
    });
    expect(a.canReopen).toBe(false);
    expect(a.reopenBlockedBy).toBe("go_live_pending");
  });
});
