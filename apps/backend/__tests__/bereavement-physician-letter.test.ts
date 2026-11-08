// apps/backend/__tests__/bereavement-physician-letter.test.ts — ADR-0109 D6: the physician-letter lifecycle rules (pure), the
// intake's letter facts, and the M16 module wiring a letter needs (permission keys, cipher column, event, audit denylist).
import { M16_AUDIT_DENYLIST } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  BereavementStateError,
  PHYSICIAN_LETTER_DECLINE_REASON_MIN,
  PHYSICIAN_LETTER_NOTE_MAX,
  decideLetterApproval,
  decideLetterDecline,
  physicianLetterDueAt,
} from "../src/modules/16-bereavement/lifecycle/index";

const ATTENDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PICKED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const codeOf = (fn: () => unknown): { code: string; status: number } => {
  try {
    fn();
  } catch (error) {
    if (error instanceof BereavementStateError) {
      return { code: error.code, status: error.statusCode };
    }
    throw error;
  }
  throw new Error("expected a BereavementStateError");
};

describe("physicianLetterDueAt", () => {
  it("is the UTC-midnight death date plus two days", () => {
    expect(physicianLetterDueAt("2026-11-05").toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });

  it("rolls over a month end", () => {
    expect(physicianLetterDueAt("2026-12-30").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("decideLetterApproval", () => {
  it("keeps the attending the care team resolved", () => {
    const out = decideLetterApproval(
      { status: "pending_review", attendingUserId: ATTENDING },
      { personalNote: null, attendingUserId: undefined },
    );
    expect(out).toEqual({ attendingUserId: ATTENDING, personalNote: null });
  });

  it("uses the reviewer's pick when the care team resolved nobody", () => {
    const out = decideLetterApproval(
      { status: "pending_review", attendingUserId: null },
      { personalNote: "  Thank you for your care of this family.  ", attendingUserId: PICKED },
    );
    expect(out.attendingUserId).toBe(PICKED);
    expect(out.personalNote).toBe("Thank you for your care of this family.");
  });

  it("lets the reviewer override the resolved attending", () => {
    const out = decideLetterApproval(
      { status: "pending_review", attendingUserId: ATTENDING },
      { personalNote: null, attendingUserId: PICKED },
    );
    expect(out.attendingUserId).toBe(PICKED);
  });

  it("refuses to approve with no attending anywhere (422)", () => {
    expect(
      codeOf(() =>
        decideLetterApproval(
          { status: "pending_review", attendingUserId: null },
          { personalNote: null, attendingUserId: undefined },
        ),
      ),
    ).toEqual({ code: "PHYSICIAN_LETTER_ATTENDING_REQUIRED", status: 422 });
  });

  it.each(["approved", "rendered", "declined"] as const)("refuses a %s letter (409)", (status) => {
    expect(
      codeOf(() =>
        decideLetterApproval(
          { status, attendingUserId: ATTENDING },
          { personalNote: null, attendingUserId: undefined },
        ),
      ),
    ).toEqual({ code: "PHYSICIAN_LETTER_NOT_PENDING", status: 409 });
  });

  it("treats a blank note as no note and refuses one over the cap (422)", () => {
    const pending = { status: "pending_review" as const, attendingUserId: ATTENDING };
    expect(
      decideLetterApproval(pending, { personalNote: "   ", attendingUserId: undefined })
        .personalNote,
    ).toBeNull();
    expect(
      codeOf(() =>
        decideLetterApproval(pending, {
          personalNote: "x".repeat(PHYSICIAN_LETTER_NOTE_MAX + 1),
          attendingUserId: undefined,
        }),
      ),
    ).toEqual({ code: "PHYSICIAN_LETTER_NOTE_TOO_LONG", status: 422 });
  });
});

describe("decideLetterDecline", () => {
  const reason = "x".repeat(PHYSICIAN_LETTER_DECLINE_REASON_MIN);

  it("returns the trimmed reason for a pending letter", () => {
    expect(decideLetterDecline({ status: "pending_review" }, `  ${reason}  `)).toBe(reason);
  });

  it("refuses a reason under 20 characters after trimming (422)", () => {
    expect(
      codeOf(() => decideLetterDecline({ status: "pending_review" }, `   ${"x".repeat(19)}   `)),
    ).toEqual({ code: "PHYSICIAN_LETTER_DECLINE_REASON_TOO_SHORT", status: 422 });
  });

  it.each(["approved", "rendered", "declined"] as const)("refuses a %s letter (409)", (status) => {
    expect(codeOf(() => decideLetterDecline({ status }, reason))).toEqual({
      code: "PHYSICIAN_LETTER_NOT_PENDING",
      status: 409,
    });
  });
});

describe("the physician letter's audit denylist", () => {
  it("scrubs the decline reason and leaves the sealed note as ciphertext", () => {
    expect(M16_AUDIT_DENYLIST.bereavement_physician_letter).toEqual(["decline_reason_redacted"]);
  });
});
