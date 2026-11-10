// The lane-neutral rail helpers: the owner wording is the caller's, a system skip is read from the flag (never the rationale), and
// progress counts only canonical, non-optional steps.
import { describe, expect, it } from "vitest";
import {
  OUTSIDE_SKIP_RATIONALE,
  type WizardRailStep,
  type WizardRailView,
  defaultStepKey,
  gatingProgress,
  isSystemSkip,
  railItemsOf,
} from "./onboarding-wizard";

const step = (over: Partial<WizardRailStep> & { key: string }): WizardRailStep => ({
  title: over.key,
  owner: "either",
  status: "pending",
  locked: false,
  lockedBy: null,
  systemSkipped: false,
  isCanonical: true,
  optional: false,
  ...over,
});
const view = (steps: WizardRailStep[], currentStepKey: string | null = null): WizardRailView => ({
  steps,
  currentStepKey,
});
const TENANT_OWNERS = {
  platform_ops: "ChartWarden",
  org_admin: "Your administrator",
  compliance_officer: "Your compliance officer",
  either: "Your administrator or ChartWarden",
} as const;

describe("railItemsOf", () => {
  it("captions each step with the caller's owner wording and marks the current one", () => {
    const rail = railItemsOf(
      view([step({ key: "a", status: "done", owner: "platform_ops" }), step({ key: "b" })], "b"),
      TENANT_OWNERS,
    );
    expect(rail.map((r) => [r.caption, r.state])).toEqual([
      ["ChartWarden", "done"],
      ["Your administrator or ChartWarden", "current"],
    ]);
  });

  it("names the step a locked one waits for", () => {
    const rail = railItemsOf(
      view([
        step({ key: "a", title: "Organisation" }),
        step({ key: "b", locked: true, lockedBy: "a" }),
      ]),
      TENANT_OWNERS,
    );
    expect(rail[1]).toMatchObject({ state: "locked", lockedReason: "Finish Organisation first" });
  });

  it("says a system skip was automatic and never reads the rationale", () => {
    const skipped = step({ key: "mac", status: "skipped", systemSkipped: true });
    expect(railItemsOf(view([skipped]), TENANT_OWNERS)[0]?.caption).toBe(
      `Skipped automatically: ${OUTSIDE_SKIP_RATIONALE}`,
    );
    expect(isSystemSkip({ status: "skipped", systemSkipped: false })).toBe(false);
    expect(isSystemSkip({ status: "pending", systemSkipped: true })).toBe(false);
  });
});

describe("gatingProgress and defaultStepKey", () => {
  const steps = [
    step({ key: "a", status: "done" }),
    step({ key: "b", status: "skipped" }),
    step({ key: "c" }),
    step({ key: "opt", optional: true, status: "done" }),
    step({ key: "extra", isCanonical: false, status: "done" }),
  ];
  it("counts only canonical non-optional steps", () => {
    expect(gatingProgress(view(steps))).toEqual({ done: 2, total: 3 });
  });
  it("resumes on the current step, else the last step, else nothing", () => {
    expect(defaultStepKey(view(steps, "c"))).toBe("c");
    expect(defaultStepKey(view(steps))).toBe("extra");
    expect(defaultStepKey(view([]))).toBeNull();
  });
});
