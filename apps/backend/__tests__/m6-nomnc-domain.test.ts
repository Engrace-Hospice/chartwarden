// M6 milestone 10a — the pure NOMNC / expedited-review domain. Record-keeping only: no CMS rule is encoded.
import { describe, expect, it } from "vitest";
import {
  EXPEDITED_ALERT_BOUNDARY_HOURS,
  NOMNC_PROMPT_REASONS,
  NomncRuleError,
  deadlineStatus,
  planReviewDecision,
  promptsFor,
  requireSourceNote,
  resolveTypedInstant,
  selectExpeditedAlerts,
  validateNoticeFacts,
} from "../src/modules/06-admission/nomnc/domain";

const NOW = new Date("2026-07-15T18:00:00.000Z");
const at = (iso: string) => new Date(iso);
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof NomncRuleError) return e.code;
    throw e;
  }
  return "NO_ERROR";
}

describe("source note and typed instants", () => {
  it("refuses a blank source note", () => {
    expect(codeOf(() => requireSourceNote("   "))).toBe("SOURCE_NOTE_REQUIRED");
    expect(codeOf(() => requireSourceNote(undefined))).toBe("SOURCE_NOTE_REQUIRED");
    expect(requireSourceNote("  NOMNC p.1, line 4 ")).toBe("NOMNC p.1, line 4");
  });

  it("refuses a date without a time (never defaulted)", () => {
    expect(codeOf(() => resolveTypedInstant("2026-07-15", undefined, "America/Los_Angeles"))).toBe(
      "TIME_REQUIRED",
    );
  });

  it("resolves a typed date and time in the org zone and echoes what was typed", () => {
    expect(resolveTypedInstant("2026-07-15", "12:00", "America/Los_Angeles")).toEqual({
      instant: new Date("2026-07-15T19:00:00.000Z"),
      dueLocal: "2026-07-15T12:00",
    });
  });

  it("refuses a time that does not exist", () => {
    expect(codeOf(() => resolveTypedInstant("2026-03-08", "02:30", "America/Los_Angeles"))).toBe(
      "TIME_NONEXISTENT",
    );
  });
});

describe("validateNoticeFacts", () => {
  const base = {
    deliveredAt: at("2026-07-15T10:00:00.000Z"),
    now: NOW,
    recipientKind: "beneficiary" as const,
    representativeName: null,
    acknowledgementKind: null,
    acknowledgementNote: null,
  };

  it("accepts a beneficiary notice with no acknowledgement recorded", () => {
    expect(codeOf(() => validateNoticeFacts(base))).toBe("NO_ERROR");
  });

  it("refuses a delivery in the future", () => {
    expect(
      codeOf(() => validateNoticeFacts({ ...base, deliveredAt: hoursFromNow(1) })),
    ).toBe("DELIVERED_IN_FUTURE");
  });

  it("requires a representative name for a representative recipient", () => {
    expect(codeOf(() => validateNoticeFacts({ ...base, recipientKind: "representative" }))).toBe(
      "REPRESENTATIVE_NAME_REQUIRED",
    );
  });

  it("requires a note when the acknowledgement is refused or other, not when signed", () => {
    expect(codeOf(() => validateNoticeFacts({ ...base, acknowledgementKind: "refused" }))).toBe(
      "ACK_NOTE_REQUIRED",
    );
    expect(codeOf(() => validateNoticeFacts({ ...base, acknowledgementKind: "other" }))).toBe(
      "ACK_NOTE_REQUIRED",
    );
    expect(codeOf(() => validateNoticeFacts({ ...base, acknowledgementKind: "signed" }))).toBe(
      "NO_ERROR",
    );
  });
});

describe("planReviewDecision", () => {
  it("only an open review can be decided or withdrawn", () => {
    expect(codeOf(() => planReviewDecision("decided", { kind: "withdraw" }))).toBe("REVIEW_NOT_OPEN");
    expect(
      codeOf(() =>
        planReviewDecision("withdrawn", {
          kind: "decide",
          outcome: "discharge_upheld",
          receivedAt: NOW,
          note: null,
        }),
      ),
    ).toBe("REVIEW_NOT_OPEN");
  });

  it("open -> decided / withdrawn", () => {
    expect(
      planReviewDecision("open", {
        kind: "decide",
        outcome: "discharge_reversed",
        receivedAt: NOW,
        note: null,
      }),
    ).toBe("decided");
    expect(planReviewDecision("open", { kind: "withdraw" })).toBe("withdrawn");
  });

  it("an 'other' outcome needs a note", () => {
    expect(
      codeOf(() =>
        planReviewDecision("open", { kind: "decide", outcome: "other", receivedAt: NOW, note: " " }),
      ),
    ).toBe("DECISION_NOTE_REQUIRED");
  });
});

describe("deadlineStatus", () => {
  it("is satisfied, past, due_soon or open", () => {
    expect(deadlineStatus({ dueAt: hoursFromNow(-1), satisfiedAt: NOW }, NOW)).toBe("satisfied");
    expect(deadlineStatus({ dueAt: hoursFromNow(-1), satisfiedAt: null }, NOW)).toBe("past");
    expect(deadlineStatus({ dueAt: hoursFromNow(3), satisfiedAt: null }, NOW)).toBe("due_soon");
    expect(deadlineStatus({ dueAt: hoursFromNow(200), satisfiedAt: null }, NOW)).toBe("open");
  });
});

describe("selectExpeditedAlerts", () => {
  const row = (over: Partial<Parameters<typeof selectExpeditedAlerts>[0][number]>) => ({
    id: "d1",
    dueAt: hoursFromNow(100),
    satisfiedAt: null,
    lastAlertedBoundaryHours: null,
    overdueAlertedAt: null,
    ...over,
  });

  it("the boundaries are a product constant", () => {
    expect([...EXPEDITED_ALERT_BOUNDARY_HOURS]).toEqual([24, 4, 1]);
  });

  it("alerts nothing before the widest boundary", () => {
    expect(selectExpeditedAlerts([row({ dueAt: hoursFromNow(25) })], NOW)).toEqual([]);
  });

  it("alerts the 24h boundary once it is crossed", () => {
    expect(selectExpeditedAlerts([row({ dueAt: hoursFromNow(23) })], NOW)).toEqual([
      { id: "d1", kind: "approaching", boundaryHours: 24 },
    ]);
  });

  it("never repeats a boundary already alerted", () => {
    expect(
      selectExpeditedAlerts([row({ dueAt: hoursFromNow(23), lastAlertedBoundaryHours: 24 })], NOW),
    ).toEqual([]);
  });

  it("a missed tick emits only the tightest crossed boundary", () => {
    expect(selectExpeditedAlerts([row({ dueAt: hoursFromNow(0.5) })], NOW)).toEqual([
      { id: "d1", kind: "approaching", boundaryHours: 1 },
    ]);
    expect(
      selectExpeditedAlerts([row({ dueAt: hoursFromNow(3), lastAlertedBoundaryHours: 24 })], NOW),
    ).toEqual([{ id: "d1", kind: "approaching", boundaryHours: 4 }]);
  });

  it("alerts overdue once, then never again", () => {
    expect(selectExpeditedAlerts([row({ dueAt: hoursFromNow(-0.1) })], NOW)).toEqual([
      { id: "d1", kind: "overdue" },
    ]);
    expect(
      selectExpeditedAlerts([row({ dueAt: hoursFromNow(-5), overdueAlertedAt: NOW })], NOW),
    ).toEqual([]);
  });

  it("a satisfied deadline never alerts", () => {
    expect(
      selectExpeditedAlerts([row({ dueAt: hoursFromNow(-5), satisfiedAt: NOW })], NOW),
    ).toEqual([]);
    expect(
      selectExpeditedAlerts([row({ dueAt: hoursFromNow(0.5), satisfiedAt: NOW })], NOW),
    ).toEqual([]);
  });
});

describe("promptsFor", () => {
  const noticeBase = { acknowledgementKind: null, documentId: null };
  const codes = (r: ReturnType<typeof promptsFor>) => r.map((p) => p.code);

  it("prompts for a missing NOMNC only on a prompting discharge reason", () => {
    expect(NOMNC_PROMPT_REASONS).toContain("no_longer_terminal");
    expect(codes(promptsFor({ notice: null, review: null, deadlines: [], dischargeReason: "for_cause" }))).toEqual([
      "NO_NOTICE",
    ]);
    expect(codes(promptsFor({ notice: null, review: null, deadlines: [], dischargeReason: "revocation" }))).toEqual(
      [],
    );
    expect(codes(promptsFor({ notice: null, review: null, deadlines: [] }))).toEqual([]);
  });

  it("flags a notice with no appeal-request deadline, no acknowledgement and no copy", () => {
    expect(
      codes(promptsFor({ notice: noticeBase, review: null, deadlines: [] })).sort(),
    ).toEqual(["NO_ACKNOWLEDGEMENT", "NO_APPEAL_DEADLINE", "NO_COPY"]);
  });

  it("is quiet once the notice facts are all recorded", () => {
    expect(
      promptsFor({
        notice: { acknowledgementKind: "signed", documentId: "doc" },
        review: null,
        deadlines: [{ subject: "notice", kind: "appeal_request" }],
      }),
    ).toEqual([]);
  });

  it("an open review prompts and asks for the DENC, records and decision deadlines", () => {
    const c = codes(
      promptsFor({
        notice: { acknowledgementKind: "signed", documentId: "doc" },
        review: { state: "open", decisionOutcome: null },
        deadlines: [{ subject: "notice", kind: "appeal_request" }],
      }),
    );
    expect(c).toContain("REVIEW_OPEN");
    expect(c).toContain("NO_DENC_DEADLINE");
    expect(c).toContain("NO_RECORDS_DEADLINE");
    expect(c).toContain("NO_DECISION_DEADLINE");
  });

  it("a reversal prompts", () => {
    expect(
      codes(
        promptsFor({
          notice: { acknowledgementKind: "signed", documentId: "doc" },
          review: { state: "decided", decisionOutcome: "discharge_reversed" },
          deadlines: [{ subject: "notice", kind: "appeal_request" }],
        }),
      ),
    ).toEqual(["REVIEW_REVERSED"]);
  });
});
