// Slice 7 - the step view's additive fields: `skippedBy` (the actor kind the skip recorded; null for a step that is not skipped) and
// `tenantSkippable` (one of the three tenant-skippable steps, owned by `either`, not settled yet; the tenant surface narrows it to the
// viewer in wizard-view's redactStepForTenant, tested in onboarding-wizard-view.test.ts). `systemSkipped` and `skippable` keep their meaning.
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

  it("is false while an earlier gating step still locks the step (a skip there is refused 409 ONBOARDING_STEP_OUT_OF_ORDER)", () => {
    const locked = toWizardStepView(template("mac_configured"), task(), "ccn_registered");
    expect(locked).toMatchObject({ locked: true, tenantSkippable: false, skippable: true });
    expect(toWizardStepView(template("mac_configured"), task(), null).tenantSkippable).toBe(true);
  });

  it("is false once the step is done or skipped", () => {
    for (const status of ["done", "skipped"] as const) {
      expect(
        toWizardStepView(template("mac_configured"), task({ status }), null).tenantSkippable,
      ).toBe(false);
    }
    for (const status of ["pending", "in_progress", "blocked"] as const) {
      expect(
        toWizardStepView(template("mac_configured"), task({ status }), null).tenantSkippable,
      ).toBe(true);
    }
  });

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

  it("is the actor kind the store read off the skip, keeping systemSkipped true for the system's alone", () => {
    expect(skipped({ skippedByActorKind: "system" })).toMatchObject({
      skippedBy: "system",
      systemSkipped: true,
    });
    expect(skipped({ skippedByActorKind: "tenant" })).toMatchObject({
      skippedBy: "tenant",
      systemSkipped: false,
    });
    expect(skipped({ skippedByActorKind: "platform_ops" })).toMatchObject({
      skippedBy: "platform_ops",
      systemSkipped: false,
    });
  });

  it("reads as platform_ops when the store did not say (a task read before the actor kind existed)", () => {
    expect(skipped({ skipRationale: "bills outside ChartWarden" })).toMatchObject({
      skippedBy: "platform_ops",
      systemSkipped: false,
    });
  });
});
