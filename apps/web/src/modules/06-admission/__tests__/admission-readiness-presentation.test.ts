import { describe, expect, it } from "vitest";
import {
  type ReadinessRequirement,
  groupReadinessRequirements,
  readinessActionIsPermitted,
  readinessActionPermission,
  readinessOwner,
  readinessReason,
  readinessRequirementIsSatisfied,
} from "../admission-readiness-presentation";

const requirement = (
  code: string,
  overrides: Partial<ReadinessRequirement> = {},
): ReadinessRequirement => ({
  code,
  label: code,
  status: "action_required",
  blocking: true,
  ...overrides,
});

describe("admission readiness presentation", () => {
  it("groups server requirements by operational next step without changing status or blocking state", () => {
    const input = [
      requirement("patient_privacy"),
      requirement("notice_of_rights"),
      requirement("cti", { status: "awaiting_signature" }),
      requirement("f2f", { status: "overdue", blocking: false }),
      requirement("future_requirement", { blocking: false }),
    ];

    const groups = groupReadinessRequirements(input);

    expect(groups.map((group) => group.label)).toEqual([
      "Required before activation",
      "Awaiting another person",
      "After admission and follow-up",
    ]);
    expect(groups.flatMap((group) => group.requirements)).toEqual(input);
    expect(groups[0]?.requirements[0]?.blocking).toBe(true);
    expect(groups[1]?.requirements[0]?.status).toBe("awaiting_signature");
    expect(groups[2]?.requirements[0]?.status).toBe("overdue");
  });

  it("presents server reason text verbatim and supplies an accountable owner", () => {
    const f2f = requirement("f2f", {
      message: "Face-to-Face encounter is overdue as of Nov 14.",
    });

    expect(readinessReason(f2f)).toBe("Face-to-Face encounter is overdue as of Nov 14.");
    expect(readinessOwner(f2f)).toBe("Hospice physician or nurse practitioner");
    expect(readinessOwner(requirement("future_requirement"))).toBe("Admission team");
  });

  it.each([
    ["action_required", "Face-to-Face encounter is required before recertification."],
    ["overdue", "Face-to-Face encounter was due Nov 10 and is overdue."],
    ["blocked", "Face-to-Face exception review is required."],
  ] as const)("preserves %s Face-to-Face guidance from the server", (status, message) => {
    const f2f = requirement("f2f", { status, message, action: "REVIEW_F2F" });
    expect(readinessReason(f2f)).toBe(message);
    expect(f2f.action).toBe("REVIEW_F2F");
  });

  it("counts complete and not-applicable requirements as satisfied", () => {
    expect(readinessRequirementIsSatisfied(requirement("identity", { status: "complete" }))).toBe(
      true,
    );
    expect(
      readinessRequirementIsSatisfied(requirement("addendum", { status: "not_applicable" })),
    ).toBe(true);
    expect(readinessRequirementIsSatisfied(requirement("cti", { status: "pending" }))).toBe(false);
  });

  it("maps contextual actions to the permission enforced by their next route", () => {
    expect(
      readinessActionPermission("COMPLETE_ELECTION_STATEMENT", {
        hasElectionStatement: false,
        hasCti: false,
        ctiHospiceMdSigned: false,
      }),
    ).toBe("election.draft");
    expect(
      readinessActionPermission("COMPLETE_ELECTION_STATEMENT", {
        hasElectionStatement: true,
        hasCti: false,
        ctiHospiceMdSigned: false,
      }),
    ).toBe("election.sign");
    expect(
      readinessActionPermission("REVIEW_CTI", {
        hasElectionStatement: false,
        hasCti: true,
        ctiHospiceMdSigned: false,
      }),
    ).toBe("cti.sign_hospice_md");
  });

  it("allows informational privacy review but refuses a mutation without its permission", () => {
    const context = {
      permissions: ["admission.read"],
      hasElectionStatement: false,
      hasCti: false,
      ctiHospiceMdSigned: false,
    };

    expect(readinessActionIsPermitted("REVIEW_PRIVACY", context)).toBe(true);
    expect(readinessActionIsPermitted("COMPLETE_NOTICE_OF_RIGHTS", context)).toBe(false);
    expect(
      readinessActionIsPermitted("COMPLETE_NOTICE_OF_RIGHTS", {
        ...context,
        permissions: [...context.permissions, "nor.acknowledge"],
      }),
    ).toBe(true);
  });
});
