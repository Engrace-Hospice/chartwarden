// Slice 7 wave 0 - the step view's two additive fields, as the read model derives them until piece 7K records the actor kind on a
// skip: `skippedBy` (system / platform_ops for a skipped step, null otherwise) and `tenantSkippable` (a skippable canonical step
// whose owner is `either`). `systemSkipped` and `skippable` keep their meaning.
import { describe, expect, it } from "vitest";
import type { StepTask, StepTemplate } from "../onboarding/model";
import { toWizardStepView } from "../onboarding/wizard-view";

const template = (key: string, over: Partial<StepTemplate> = {}): StepTemplate => ({
  key,
  title: key,
  description: "",
  sequence: 8,
  owner: "either",
  completionMode: "attestation",
  optional: false,
  canonical: true,
  ...over,
});

const task = (over: Partial<StepTask> = {}): StepTask => ({
  id: "t1",
  templateKey: "mac_configured",
  status: "pending",
  assignedToMembershipId: null,
  createdAt: new Date("2026-11-09T00:00:00Z"),
  dueAt: null,
  startedAt: null,
  completedAt: null,
  blockerReason: null,
  evidenceNote: null,
  evidenceRef: null,
  attestedByMembershipId: null,
  attestedByActorKind: null,
  attestedAt: null,
  skipRationale: null,
  ...over,
});

describe("tenantSkippable", () => {
  it.each(["mac_configured", "payer_enrollment", "dosespot_kickoff_initiated"])(
    "is true for the canonical, either-owned, skippable step %s",
    (key) => {
      expect(toWizardStepView(template(key), task(), null).tenantSkippable).toBe(true);
    },
  );

  it("is false for sample data (operator-owned), go-live, a non-skippable step and an operator-added step", () => {
    const view = (t: StepTemplate) => toWizardStepView(t, task(), null);
    expect(view(template("sample_data_loaded", { owner: "platform_ops" })).tenantSkippable).toBe(
      false,
    );
    expect(
      view(template("go_live_checklist_complete", { owner: "compliance_officer" })),
    ).toMatchObject({
      tenantSkippable: false,
      skippable: false,
    });
    expect(view(template("baa_executed")).tenantSkippable).toBe(false);
    const added = view(template("custom_step", { canonical: false }));
    expect(added).toMatchObject({ tenantSkippable: false, skippable: true });
  });
});

describe("skippedBy", () => {
  const skipped = (over: Partial<StepTask> = {}) =>
    toWizardStepView(template("mac_configured"), task({ status: "skipped", ...over }), null);

  it("is null for a step that is not skipped", () => {
    for (const status of ["pending", "in_progress", "done", "blocked"] as const) {
      expect(
        toWizardStepView(template("mac_configured"), task({ status }), null).skippedBy,
      ).toBeNull();
    }
  });

  it("is system for the clearinghouse sync's skip and platform_ops for a person's, keeping systemSkipped", () => {
    expect(skipped({ skippedBySystem: true })).toMatchObject({
      skippedBy: "system",
      systemSkipped: true,
    });
    expect(skipped({ skipRationale: "bills outside ChartWarden" })).toMatchObject({
      skippedBy: "platform_ops",
      systemSkipped: false,
    });
  });
});
