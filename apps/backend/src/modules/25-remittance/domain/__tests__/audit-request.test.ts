// M25 milestone 7a-1 - the audit request aggregate (RAC / UPIC / SMRC / other). Pure. The authority kinds are labels
// only: nothing here encodes a contractor's window, channel or review outcome (those are SME items).
import { describe, expect, it } from "vitest";
import {
  AUDIT_AUTHORITY_KINDS,
  AUDIT_NO_DEADLINE_ALERT_DAYS,
  auditDueState,
  canTransitionAudit,
  checkAuditCreate,
  isAuditTerminal,
  shouldAlertNoDeadline,
} from "../audit-request";

const TODAY = "2026-03-01";
const base = {
  authorityKind: "upic",
  authorityName: "",
  requestDatedOn: "2026-02-20" as string | null,
  receivedOn: "2026-02-25",
  today: TODAY,
};

describe("audit authority labels", () => {
  it("are exactly the four labels", () => {
    expect([...AUDIT_AUTHORITY_KINDS]).toEqual(["rac", "upic", "smrc", "other"]);
  });
});

describe("checkAuditCreate", () => {
  it("accepts a labelled authority with sane dates", () => {
    expect(checkAuditCreate(base)).toBeNull();
  });
  it("rejects an unknown authority kind", () => {
    expect(checkAuditCreate({ ...base, authorityKind: "cert" })).toBe("AUTHORITY_KIND_INVALID");
  });
  it("requires a name for 'other'", () => {
    expect(checkAuditCreate({ ...base, authorityKind: "other" })).toBe("AUTHORITY_NAME_REQUIRED");
    expect(
      checkAuditCreate({ ...base, authorityKind: "other", authorityName: "State auditor" }),
    ).toBeNull();
  });
  it("rejects a received date in the future", () => {
    expect(checkAuditCreate({ ...base, receivedOn: "2026-03-02" })).toBe("RECEIVED_IN_FUTURE");
  });
  it("rejects a letter dated after it was received", () => {
    expect(checkAuditCreate({ ...base, requestDatedOn: "2026-02-26" })).toBe(
      "DATED_AFTER_RECEIVED",
    );
  });
  it("rejects dates that are not real days", () => {
    expect(checkAuditCreate({ ...base, receivedOn: "2026-02-30" })).toBe("DATE_INVALID");
  });
  it("allows the request date to be omitted", () => {
    expect(checkAuditCreate({ ...base, requestDatedOn: null })).toBeNull();
  });
});

describe("audit state machine", () => {
  it("moves forward only", () => {
    expect(canTransitionAudit("received", "in_assembly")).toBe(true);
    expect(canTransitionAudit("in_assembly", "in_review")).toBe(true);
    expect(canTransitionAudit("in_review", "responded")).toBe(true);
    expect(canTransitionAudit("responded", "closed")).toBe(true);
    expect(canTransitionAudit("in_review", "in_assembly")).toBe(false);
    expect(canTransitionAudit("received", "responded")).toBe(false);
  });
  it("can be withdrawn from any non-terminal state", () => {
    for (const s of ["received", "in_assembly", "in_review", "responded"] as const) {
      expect(canTransitionAudit(s, "withdrawn")).toBe(true);
    }
  });
  it("freezes withdrawn and closed", () => {
    expect(isAuditTerminal("withdrawn")).toBe(true);
    expect(isAuditTerminal("closed")).toBe(true);
    expect(isAuditTerminal("responded")).toBe(false);
    expect(canTransitionAudit("closed", "withdrawn")).toBe(false);
  });
});

describe("auditDueState", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");
  it("says no deadline is recorded when there is none, never a default", () => {
    expect(auditDueState({ state: "received", nextDueAt: null, now })).toBe("no_deadline_recorded");
  });
  it("is open before the recorded date and past after it", () => {
    expect(
      auditDueState({ state: "in_review", nextDueAt: new Date("2026-03-05T00:00:00Z"), now }),
    ).toBe("open");
    expect(
      auditDueState({ state: "in_review", nextDueAt: new Date("2026-02-28T00:00:00Z"), now }),
    ).toBe("past");
  });
  it("is not applicable once the request is over", () => {
    expect(auditDueState({ state: "closed", nextDueAt: null, now })).toBe("not_applicable");
    expect(auditDueState({ state: "withdrawn", nextDueAt: null, now })).toBe("not_applicable");
  });
});

describe("shouldAlertNoDeadline", () => {
  const created = new Date("2026-02-25T12:00:00.000Z");
  const row = { state: "received", createdAt: created, hasDeadline: false, alreadyAlerted: false };
  it("waits the named number of days", () => {
    expect(shouldAlertNoDeadline(row, new Date("2026-02-26T12:00:00.000Z"))).toBe(false);
    expect(shouldAlertNoDeadline(row, new Date("2026-02-27T12:00:00.000Z"))).toBe(true);
  });
  it("is quiet once a deadline exists, once alerted, or once the request is over", () => {
    const later = new Date("2026-03-10T00:00:00.000Z");
    expect(shouldAlertNoDeadline({ ...row, hasDeadline: true }, later)).toBe(false);
    expect(shouldAlertNoDeadline({ ...row, alreadyAlerted: true }, later)).toBe(false);
    expect(shouldAlertNoDeadline({ ...row, state: "closed" }, later)).toBe(false);
  });
  it("names the threshold as a constant of two days", () => {
    expect(AUDIT_NO_DEADLINE_ALERT_DAYS).toBe(2);
  });
});
