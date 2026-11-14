import { describe, expect, it } from "vitest";
import {
  INTAKE_WORKLIST_LABEL,
  type IntakeWorkspaceReferral,
  deriveIntakeWorkspace,
} from "./intake-workspace-stage";
import type { ReferralStatus } from "./referrals-api";

const statuses: readonly ReferralStatus[] = [
  "received",
  "under_review",
  "pending_information",
  "qualified",
  "declined",
  "duplicate",
  "withdrawn",
  "converted",
];

function referral(overrides: Partial<IntakeWorkspaceReferral> = {}): IntakeWorkspaceReferral {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "under_review",
    patientResolutionStatus: "unresolved",
    convertedAdmissionId: null,
    qualificationBlockers: [],
    ...overrides,
  };
}

describe("intake worklist presentation", () => {
  it("maps every canonical referral status exactly once", () => {
    expect(Object.keys(INTAKE_WORKLIST_LABEL).sort()).toEqual([...statuses].sort());
    expect(statuses.map((status) => INTAKE_WORKLIST_LABEL[status])).not.toContain(undefined);
  });

  it("does not imply that a qualified referral is ready for admission activation", () => {
    expect(INTAKE_WORKLIST_LABEL.qualified).toBe("Ready to start admission");
    expect(deriveIntakeWorkspace(referral({ status: "qualified" })).primaryAction.label).toBe(
      "Start admission",
    );
  });
});

describe("deriveIntakeWorkspace", () => {
  it("does not treat later qualification blockers as a reason to prevent initial review", () => {
    expect(
      deriveIntakeWorkspace(
        referral({
          status: "received",
          qualificationBlockers: [{ code: "PATIENT_UNRESOLVED", message: "Resolve patient." }],
        }),
      ).activeStepBlocked,
    ).toBe(false);
  });

  it("directs an unresolved referral to explicit patient matching", () => {
    expect(deriveIntakeWorkspace(referral())).toMatchObject({
      activeStepId: "match",
      completedStepIds: ["receive", "verify"],
      primaryAction: {
        label: "Resolve patient match",
        href: "/referrals/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#patient-resolution",
      },
    });
  });

  it("surfaces qualification blockers after patient resolution", () => {
    const presentation = deriveIntakeWorkspace(
      referral({
        patientResolutionStatus: "matched",
        qualificationBlockers: [{ code: "MISSING_DETAIL", message: "Add admission details." }],
      }),
    );

    expect(presentation.activeStepId).toBe("review");
    expect(presentation.completedStepIds).toEqual(["receive", "verify", "match"]);
    expect(presentation.primaryAction.label).toBe("Address review blockers");
    expect(presentation.blockers).toEqual(["Add admission details."]);
  });

  it("links a converted referral to its one existing admission", () => {
    const presentation = deriveIntakeWorkspace(
      referral({
        status: "converted",
        convertedAdmissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    );
    expect(presentation.activeStepId).toBe("requirements");
    expect(presentation.completedStepIds).toEqual([
      "receive",
      "verify",
      "match",
      "review",
      "handoff",
    ]);
    expect(presentation.completedStepIds).not.toContain("requirements");
    expect(presentation.primaryAction).toEqual({
      label: "View admission",
      href: "/admissions/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });

  it.each(["declined", "duplicate", "withdrawn"] as const)(
    "keeps terminal %s referrals reviewable without an advancement action",
    (status) => {
      expect(deriveIntakeWorkspace(referral({ status })).primaryAction).toEqual({
        label: "View referral history",
        href: "/referrals/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#activity",
      });
    },
  );
});
