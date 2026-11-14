import { describe, expect, it } from "vitest";
import { assessNoticeDeadline } from "./notice-deadline-policy";

const now = (value: string) => new Date(value);
const evaluate = (over: Record<string, unknown> = {}) => assessNoticeDeadline({
  kind: "noe", state: "ready", triggerDate: "2026-10-31", persistedDueDate: "2026-11-05",
  acceptedAt: null, now: now("2026-11-03T17:00:00.000Z"), ...over,
} as Parameters<typeof assessNoticeDeadline>[0]);

describe("Medicare notice deadline policy", () => {
  it("uses the persisted five-calendar-day target and Eastern calendar day", () => {
    expect(evaluate().risk).toBe("approaching");
    expect(evaluate({ now: now("2026-11-05T05:00:00.000Z") }).risk).toBe("due_today");
    expect(evaluate({ now: now("2026-11-06T15:00:00.000Z") }).risk).toBe("overdue");
  });

  it.each([
    ["month boundary", "2026-01-29", "2026-02-03"],
    ["year boundary", "2026-12-29", "2027-01-03"],
    ["leap year", "2024-02-27", "2024-03-03"],
  ])("does not recompute or drift historical due dates (%s)", (_label, triggerDate, dueDate) => {
    expect(evaluate({ triggerDate, persistedDueDate: dueDate }).dueDate).toBe(dueDate);
  });

  it("does not count a transport receipt or a submitted state as MAC acceptance", () => {
    expect(evaluate({ state: "ack_pending" })).toMatchObject({
      risk: "submitted_awaiting_verification", acceptance: "not_verified", timeliness: "unknown",
    });
    expect(evaluate({ state: "ack_accepted", acceptedAt: null })).toMatchObject({
      risk: "filing_timeliness_unknown", acceptance: "unknown",
    });
  });

  it("keeps external filing assertions and transport receipts separate from acceptance", () => {
    expect(evaluate({ state: "ready", externalFilingOn: "2026-11-04" })).toMatchObject({
      risk: "filing_timeliness_unknown", lifecycle: "external_filing_recorded",
      acceptance: "not_verified", timeliness: "unknown",
    });
    expect(evaluate({ state: "submitted", attempt: {
      dispatchState: "finished", outcome: "submitted", submittedAt: "2026-11-04T12:00:00Z",
      dispatchStartedAt: "2026-11-04T11:59:00Z",
    } })).toMatchObject({
      risk: "submitted_awaiting_verification", lifecycle: "transport_receipt_confirmed",
      acceptance: "not_verified", timeliness: "unknown",
    });
  });

  it("keeps ambiguous dispatch in reconciliation and distinguishes a known pre-send failure", () => {
    expect(evaluate({ state: "submitted", attempt: {
      dispatchState: "in_doubt", outcome: "queued", submittedAt: null,
      dispatchStartedAt: "2026-11-04T11:59:00Z",
    } })).toMatchObject({
      risk: "filing_timeliness_unknown", lifecycle: "outcome_unknown", acceptance: "unknown",
    });
    expect(evaluate({ state: "ready", attempt: {
      dispatchState: "finished", outcome: "failed_worker", submittedAt: null, dispatchStartedAt: null,
    } })).toMatchObject({ lifecycle: "known_not_sent", risk: "approaching" });
  });

  it("does not clear deadline risk on a transport rejection", () => {
    expect(evaluate({ state: "ready", attempt: {
      dispatchState: "finished", outcome: "failed_portal", submittedAt: null,
      dispatchStartedAt: "2026-11-04T11:59:00Z",
    } })).toMatchObject({ risk: "transport_rejected", acceptance: "not_verified", timeliness: "unknown" });
  });

  it("classifies only timestamped MAC acknowledgment evidence for timeliness", () => {
    expect(evaluate({ state: "ack_accepted", acceptedAt: "2026-11-06T03:30:00.000Z" })).toMatchObject({
      risk: "accepted_within_deadline", timeliness: "timely", acceptance: "verified",
    });
    expect(evaluate({ state: "ack_accepted", acceptedAt: "2026-11-07T15:00:00.000Z" })).toMatchObject({
      risk: "accepted_after_deadline", timeliness: "late",
    });
  });

  it("fails closed on contradictory acknowledgment evidence or a mismatched persisted target", () => {
    expect(evaluate({
      state: "ack_accepted", acceptedAt: "2026-11-04T12:00:00Z", rejectedAt: "2026-11-04T13:00:00Z",
    })).toMatchObject({ risk: "filing_timeliness_unknown", acceptance: "unknown", timeliness: "unknown" });
    expect(evaluate({ persistedDueDate: "2026-11-04" })).toMatchObject({
      risk: "not_determinable", timeliness: "unknown",
    });
  });

  it("does not apply NOE/NOTR deadlines to transfer or cancellation transactions", () => {
    expect(evaluate({ kind: "transfer_8xc" })).toMatchObject({ applies: false, risk: "not_applicable" });
    expect(evaluate({ kind: "cancellation_8xd" })).toMatchObject({ applies: false, risk: "not_applicable" });
    expect(evaluate({ kind: "notr", triggerDate: "2026-11-01", persistedDueDate: "2026-11-06", state: "ready" }).dueDate).toBe("2026-11-06");
    expect(evaluate({ kind: "notr", triggerDate: "2026-11-01", persistedDueDate: "2026-11-06", state: "ready", now: now("2026-11-07T15:00:00Z") }).risk).toBe("overdue");
  });

  it("honors only the persisted final-claim exception for a discharge NOTR", () => {
    expect(evaluate({ kind: "notr", finalClaimFiled: true })).toMatchObject({
      applies: false, risk: "not_applicable", timeliness: "not_applicable",
    });
    expect(evaluate({ kind: "notr", finalClaimFiled: false })).toMatchObject({ applies: true });
  });

  it("fails closed when the event date or stored target is missing/invalid", () => {
    expect(evaluate({ triggerDate: null }).risk).toBe("not_determinable");
    expect(evaluate({ persistedDueDate: "2026-02-30" }).risk).toBe("not_determinable");
  });
});
