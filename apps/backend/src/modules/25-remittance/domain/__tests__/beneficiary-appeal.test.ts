// M25 milestone 13a - the beneficiary-filed appeal pure rules. A record of an appeal the beneficiary or their representative
// filed: no deadline is computed, nothing is filed, and the outcome is a label that is never acted on.
import { describe, expect, it } from "vitest";
import {
  BENEFICIARY_TIER_LABELS,
  canTransitionBeneficiaryAppeal,
  checkBeneficiaryIntake,
  checkBeneficiaryOutcome,
  representativeFlag,
} from "../beneficiary-appeal";

const TODAY = "2026-06-15";
const intake = (over: Record<string, unknown> = {}) => ({
  filerKind: "beneficiary" as const,
  tierLabel: "redetermination",
  filedOn: "2026-06-10",
  externalReference: "ref-1",
  sourceNote: "family called the office",
  hasAppointment: false,
  ...over,
});

describe("checkBeneficiaryIntake", () => {
  it("accepts a beneficiary-filed record", () => {
    expect(checkBeneficiaryIntake(intake(), TODAY)).toBeNull();
  });
  it("tier labels are the Medicare tiers plus other", () => {
    expect([...BENEFICIARY_TIER_LABELS]).toEqual([
      "redetermination",
      "reconsideration",
      "alj",
      "council",
      "federal_court",
      "other",
    ]);
    expect(checkBeneficiaryIntake(intake({ tierLabel: "first_level" }), TODAY)).toBe(
      "TIER_INVALID",
    );
  });
  it("requires the source note (how the hospice learned of it)", () => {
    expect(checkBeneficiaryIntake(intake({ sourceNote: " " }), TODAY)).toBe("SOURCE_NOTE_REQUIRED");
  });
  it("lets the filed-on date be absent, but never invalid or in the future", () => {
    expect(checkBeneficiaryIntake(intake({ filedOn: null }), TODAY)).toBeNull();
    expect(checkBeneficiaryIntake(intake({ filedOn: "2026-02-31" }), TODAY)).toBe("DATE_INVALID");
    expect(checkBeneficiaryIntake(intake({ filedOn: "2026-06-16" }), TODAY)).toBe("DATE_IN_FUTURE");
  });
  it("allows a representative filer with no appointment on file (it is flagged, not blocked)", () => {
    expect(
      checkBeneficiaryIntake(intake({ filerKind: "representative", hasAppointment: false }), TODAY),
    ).toBeNull();
  });
  it("an appointment can be linked only to a representative-filed appeal", () => {
    expect(checkBeneficiaryIntake(intake({ hasAppointment: true }), TODAY)).toBe(
      "APPOINTMENT_NEEDS_REPRESENTATIVE_FILER",
    );
    expect(
      checkBeneficiaryIntake(intake({ filerKind: "representative", hasAppointment: true }), TODAY),
    ).toBeNull();
  });
  it("rejects a Medicare number in any free-text field", () => {
    expect(checkBeneficiaryIntake(intake({ sourceNote: "mbi 1EG4TE5MK73" }), TODAY)).toBe(
      "MBI_IN_FREE_TEXT",
    );
    expect(checkBeneficiaryIntake(intake({ externalReference: "1EG4-TE5-MK73" }), TODAY)).toBe(
      "MBI_IN_FREE_TEXT",
    );
  });
  it("bounds the text", () => {
    expect(checkBeneficiaryIntake(intake({ sourceNote: "x".repeat(1001) }), TODAY)).toBe(
      "TEXT_TOO_LONG",
    );
  });
});

describe("state machine", () => {
  it("moves recorded -> supporting -> decided -> closed and may withdraw before the end", () => {
    expect(canTransitionBeneficiaryAppeal("recorded", "supporting")).toBe(true);
    expect(canTransitionBeneficiaryAppeal("recorded", "decided")).toBe(true);
    expect(canTransitionBeneficiaryAppeal("supporting", "decided")).toBe(true);
    expect(canTransitionBeneficiaryAppeal("decided", "closed")).toBe(true);
    expect(canTransitionBeneficiaryAppeal("supporting", "withdrawn")).toBe(true);
  });
  it("closed and withdrawn are terminal, and a decided record cannot go back", () => {
    for (const to of ["recorded", "supporting", "decided", "closed", "withdrawn"] as const) {
      expect(canTransitionBeneficiaryAppeal("closed", to)).toBe(false);
      expect(canTransitionBeneficiaryAppeal("withdrawn", to)).toBe(false);
    }
    expect(canTransitionBeneficiaryAppeal("decided", "supporting")).toBe(false);
  });
});

describe("checkBeneficiaryOutcome", () => {
  it("needs an outcome label and a note when the label is other", () => {
    expect(checkBeneficiaryOutcome({ outcomeLabel: undefined, outcomeNote: null })).toBe(
      "OUTCOME_REQUIRED",
    );
    expect(checkBeneficiaryOutcome({ outcomeLabel: "won", outcomeNote: null })).toBe(
      "OUTCOME_INVALID",
    );
    expect(checkBeneficiaryOutcome({ outcomeLabel: "other", outcomeNote: " " })).toBe(
      "OUTCOME_NOTE_REQUIRED",
    );
    expect(checkBeneficiaryOutcome({ outcomeLabel: "favorable", outcomeNote: null })).toBeNull();
    expect(checkBeneficiaryOutcome({ outcomeLabel: "dismissed", outcomeNote: "n" })).toBeNull();
  });
  it("rejects a Medicare number in the note", () => {
    expect(checkBeneficiaryOutcome({ outcomeLabel: "other", outcomeNote: "1EG4-TE5-MK73" })).toBe(
      "MBI_IN_FREE_TEXT",
    );
  });
});

describe("representativeFlag", () => {
  it("is not applicable when the beneficiary filed", () => {
    expect(representativeFlag({ filerKind: "beneficiary", appointment: null }, TODAY)).toBeNull();
  });
  it("flags a representative filer with no appointment as none_on_file", () => {
    expect(representativeFlag({ filerKind: "representative", appointment: null }, TODAY)).toBe(
      "none_on_file",
    );
  });
  it("reflects the linked appointment's derived status", () => {
    const filer = "representative" as const;
    expect(
      representativeFlag(
        { filerKind: filer, appointment: { state: "draft", validThroughOn: null } },
        TODAY,
      ),
    ).toBe("draft");
    expect(
      representativeFlag(
        { filerKind: filer, appointment: { state: "active", validThroughOn: null } },
        TODAY,
      ),
    ).toBe("active");
    expect(
      representativeFlag(
        { filerKind: filer, appointment: { state: "active", validThroughOn: "2026-01-01" } },
        TODAY,
      ),
    ).toBe("validity_end_passed_as_recorded");
    expect(
      representativeFlag(
        { filerKind: filer, appointment: { state: "revoked", validThroughOn: null } },
        TODAY,
      ),
    ).toBe("revoked");
  });
});
