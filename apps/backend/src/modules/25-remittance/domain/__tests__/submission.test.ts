// M25 milestone 6a - the submission attempt's pure rules: closed sets, the status machine (nothing acknowledged
// without proof, a retry is a new attempt), the receipt and approval guards, the unknown-outcome rule (a stale
// `sending` is never resent) and the guided checklist (deterministic, no URL or number of any channel).
import { describe, expect, it } from "vitest";
import { buildGuidedChecklist } from "../guided-checklist";
import {
  SUBMISSION_ADAPTERS,
  SUBMISSION_CHANNELS,
  SUBMISSION_PURPOSES,
  SUBMISSION_STATUSES,
  canTransitionSubmission,
  isLiveSubmissionStatus,
  nextAttemptNumber,
  purposeSubject,
  submissionIdempotencyKey,
} from "../submission";
import {
  MAX_RECEIPT_AMENDMENTS,
  MIN_CANCEL_REASON,
  PROOF_MISSING_DAYS,
  checkAmendment,
  checkApproval,
  checkCancel,
  checkReceipt,
  isProofMissing,
  isSubjectTerminal,
  staleSendingOutcome,
} from "../submission-rules";

describe("submission vocabulary", () => {
  it("covers the channels the three existing filing vocabularies use", () => {
    for (const c of ["esmd", "mac_portal", "qic_portal", "fax", "mail", "other"]) {
      expect(SUBMISSION_CHANNELS).toContain(c);
    }
    expect(SUBMISSION_ADAPTERS).toEqual(["manual", "esmd", "fax"]);
    expect(SUBMISSION_PURPOSES).toHaveLength(4);
    expect(SUBMISSION_STATUSES).toHaveLength(8);
  });

  it("maps each purpose to the subject table it belongs to", () => {
    expect(purposeSubject("adr_response")).toBe("adr_case");
    expect(purposeSubject("appeal_request")).toBe("appeal_case");
    expect(purposeSubject("qic_escalation_request")).toBe("appeal_case");
    expect(purposeSubject("reopening_request")).toBe("reopening_case");
  });

  it("builds the idempotency key as purpose:subject:attempt", () => {
    expect(submissionIdempotencyKey("adr_response", "abc", 2)).toBe("adr_response:abc:2");
  });

  it("numbers a retry as the next attempt, never rewinding", () => {
    expect(nextAttemptNumber([])).toBe(1);
    expect(nextAttemptNumber([1, 3, 2])).toBe(4);
  });

  it("calls only the five in-flight statuses live", () => {
    for (const s of ["prepared", "queued", "sending", "sent", "needs_manual"] as const) {
      expect(isLiveSubmissionStatus(s)).toBe(true);
    }
    for (const s of ["acknowledged", "failed", "cancelled"] as const) {
      expect(isLiveSubmissionStatus(s)).toBe(false);
    }
  });
});

describe("submission status machine", () => {
  it.each([
    ["prepared", "queued", true],
    ["queued", "sending", true],
    ["sending", "sent", true],
    ["sent", "acknowledged", true],
    ["prepared", "needs_manual", true],
    ["queued", "needs_manual", true],
    ["sending", "needs_manual", true],
    ["sending", "failed", true],
    ["prepared", "cancelled", true],
    ["queued", "cancelled", true],
    ["needs_manual", "cancelled", true],
    ["needs_manual", "acknowledged", true],
    // nothing reaches acknowledged except from sent (adapter ack) or needs_manual (user-entered receipt)
    ["prepared", "acknowledged", false],
    ["queued", "acknowledged", false],
    ["sending", "acknowledged", false],
    // an in-flight send cannot be cancelled or rewound
    ["sending", "cancelled", false],
    ["sent", "cancelled", false],
    ["sent", "sending", false],
    ["queued", "prepared", false],
    // terminal states never move; a retry is a new row
    ["acknowledged", "needs_manual", false],
    ["failed", "prepared", false],
    ["cancelled", "queued", false],
    ["needs_manual", "needs_manual", false],
  ] as const)("%s -> %s is %s", (from, to, ok) => {
    expect(canTransitionSubmission(from, to)).toBe(ok);
  });
});

describe("checkReceipt", () => {
  const now = new Date("2026-04-10T12:00:00Z");
  const ok = { confirmationRef: "ABC-123", receiptAt: new Date("2026-04-09T10:00:00Z"), now };

  it("accepts a reference and a past time", () => {
    expect(checkReceipt(ok)).toBeNull();
  });
  it("refuses a missing or blank reference", () => {
    expect(checkReceipt({ ...ok, confirmationRef: "   " })).toBe("PROOF_REQUIRED");
  });
  it("refuses an over-long reference", () => {
    expect(checkReceipt({ ...ok, confirmationRef: "x".repeat(201) })).toBe("REFERENCE_TOO_LONG");
  });
  it("refuses a receipt time in the future", () => {
    expect(checkReceipt({ ...ok, receiptAt: new Date("2026-04-10T12:00:01Z") })).toBe(
      "RECEIPT_IN_FUTURE",
    );
  });
  it("refuses an invalid date", () => {
    expect(checkReceipt({ ...ok, receiptAt: new Date("nope") })).toBe("RECEIPT_TIME_INVALID");
  });
  it("refuses a Medicare number in the reference", () => {
    expect(checkReceipt({ ...ok, confirmationRef: "1EG4-TE5-MK73" })).toBe("MBI_NOT_ALLOWED");
  });
});

describe("checkApproval", () => {
  const base = { preparedBy: "m1", approver: "m2", eligibleUserCount: 5 };

  it("lets a different person approve", () => {
    expect(checkApproval(base)).toBeNull();
  });
  it("refuses self-approval when another eligible user exists", () => {
    expect(checkApproval({ ...base, approver: "m1" })).toBe("SELF_APPROVAL");
  });
  it("allows self-approval only when the org has a single eligible user", () => {
    expect(checkApproval({ ...base, approver: "m1", eligibleUserCount: 1 })).toBeNull();
  });
  it("allows approval when the preparer is unknown", () => {
    expect(checkApproval({ ...base, preparedBy: null })).toBeNull();
  });
});

describe("staleSendingOutcome (unknown outcome is never resent)", () => {
  const now = new Date("2026-04-10T12:00:00Z");

  it("moves a stale sending attempt to needs_manual with the verify-first reason", () => {
    const r = staleSendingOutcome({
      status: "sending",
      sendingSince: new Date("2026-04-10T11:00:00Z"),
      now,
      staleAfterMs: 10 * 60_000,
    });
    expect(r).toEqual({
      to: "needs_manual",
      reason: expect.stringContaining("verify with the channel before refiling"),
    });
  });
  it("leaves a fresh sending attempt alone", () => {
    expect(
      staleSendingOutcome({
        status: "sending",
        sendingSince: new Date("2026-04-10T11:58:00Z"),
        now,
        staleAfterMs: 10 * 60_000,
      }),
    ).toBeNull();
  });
  it("never offers a resend (the only outcome is needs_manual)", () => {
    for (const s of ["queued", "sent", "needs_manual"] as const) {
      expect(
        staleSendingOutcome({
          status: s,
          sendingSince: new Date(0),
          now,
          staleAfterMs: 1,
        }),
      ).toBeNull();
    }
  });
});

describe("isProofMissing", () => {
  const now = new Date("2026-04-30T00:00:00Z");
  it("flags a needs_manual attempt past the threshold", () => {
    const created = new Date(now.getTime() - (PROOF_MISSING_DAYS + 1) * 86_400_000);
    expect(isProofMissing({ status: "needs_manual", createdAt: created, now })).toBe(true);
  });
  it("does not flag a young attempt, an acknowledged one or a cancelled one", () => {
    const fresh = new Date(now.getTime() - 86_400_000);
    expect(isProofMissing({ status: "needs_manual", createdAt: fresh, now })).toBe(false);
    const old = new Date(0);
    expect(isProofMissing({ status: "acknowledged", createdAt: old, now })).toBe(false);
    expect(isProofMissing({ status: "cancelled", createdAt: old, now })).toBe(false);
  });
});

describe("buildGuidedChecklist", () => {
  const input = {
    purpose: "appeal_request",
    macName: "Palmetto GBA",
    deadline: "2026-06-01",
  } as const;

  it("is deterministic", () => {
    expect(buildGuidedChecklist(input)).toEqual(buildGuidedChecklist(input));
  });
  it("names the MAC and the deadline from the case", () => {
    const text = JSON.stringify(buildGuidedChecklist(input));
    expect(text).toContain("Palmetto GBA");
    expect(text).toContain("2026-06-01");
  });
  it("hardcodes no URL, fax number or file format of any channel", () => {
    const text = JSON.stringify(buildGuidedChecklist(input));
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/www\./i);
    expect(text).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/);
    expect(text).not.toMatch(/\.(pdf|xml|x12|zip)\b/i);
  });
  it("still works with no MAC and no deadline", () => {
    const steps = buildGuidedChecklist({ purpose: "adr_response", macName: null, deadline: null });
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.every((s) => s.key.length > 0 && s.text.length > 0)).toBe(true);
  });
});

describe("checkAmendment", () => {
  const original = {
    confirmationRef: "A-1",
    receiptAt: "2026-04-09T10:00:00.000Z",
    receiptDocumentId: null,
  };
  const next = {
    confirmationRef: "A-2",
    receiptAt: "2026-04-09T10:00:00.000Z",
    receiptDocumentId: null,
  };

  it("accepts a different correction", () => {
    expect(checkAmendment({ original, amendments: [], next })).toBeNull();
  });
  it("rejects one identical to the original receipt when there are no amendments", () => {
    expect(checkAmendment({ original, amendments: [], next: { ...original } })).toBe(
      "AMENDMENT_DUPLICATE",
    );
  });
  it("rejects one identical to the last amendment, but allows reverting to an earlier value", () => {
    const last = { ...next, confirmationRef: "A-3" };
    const amendments = [next, last];
    expect(checkAmendment({ original, amendments, next: { ...last } })).toBe("AMENDMENT_DUPLICATE");
    expect(checkAmendment({ original, amendments, next: { ...next } })).toBeNull();
  });
  it("caps the amendment count", () => {
    const amendments = Array.from({ length: MAX_RECEIPT_AMENDMENTS }, (_, i) => ({
      ...next,
      confirmationRef: `R-${i}`,
    }));
    expect(checkAmendment({ original, amendments, next: { ...next, confirmationRef: "X" } })).toBe(
      "AMENDMENT_LIMIT",
    );
  });
});

describe("checkCancel", () => {
  const reason = "x".repeat(MIN_CANCEL_REASON);
  it("never cancels the only path to proof (needs_manual)", () => {
    expect(checkCancel({ status: "needs_manual", reason })).toBe("PROOF_ONLY_PATH");
  });
  it("needs a real reason for the other cancellable states", () => {
    expect(checkCancel({ status: "prepared", reason: "short" })).toBe("REASON_REQUIRED");
    expect(checkCancel({ status: "prepared", reason })).toBeNull();
    expect(checkCancel({ status: "queued", reason })).toBeNull();
  });
});

describe("isSubjectTerminal", () => {
  it("is true for withdrawn / closed cases and a non-response ADR, false while the case is live", () => {
    expect(isSubjectTerminal("appeal", "withdrawn")).toBe(true);
    expect(isSubjectTerminal("appeal", "closed")).toBe(true);
    expect(isSubjectTerminal("reopening", "closed")).toBe(true);
    expect(isSubjectTerminal("adr", "denied_no_response")).toBe(true);
    expect(isSubjectTerminal("appeal", "submitted")).toBe(false);
    expect(isSubjectTerminal("adr", "submitted")).toBe(false);
  });
});
