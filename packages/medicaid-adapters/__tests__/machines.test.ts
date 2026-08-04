import { describe, expect, it } from "vitest";
import * as claim from "../src/machines/claim";
import * as rbArr from "../src/machines/rb-arrangement";
import * as rbDay from "../src/machines/rb-day";

describe("medicaid_claim machine", () => {
  it("happy path DRAFT → READY → SUBMITTED → ACK_ACCEPTED → PAID", () => {
    expect(claim.reduce("DRAFT", "begin_validation").state).toBe("VALIDATING");
    expect(
      claim.reduce("VALIDATING", "validation_passed", { unresolvedBlockingFailures: 0 }).state,
    ).toBe("READY");
    expect(claim.reduce("READY", "submit", { unresolvedBlockingFailures: 0 }).state).toBe(
      "SUBMITTED",
    );
    expect(claim.reduce("SUBMITTED", "accepted_sync").state).toBe("ACK_PENDING");
    expect(claim.reduce("ACK_PENDING", "ack_accepted").state).toBe("ACK_ACCEPTED");
    expect(claim.reduce("ACK_ACCEPTED", "remittance_paid").state).toBe("PAID");
  });

  it("blocks validation_passed / submit when there are unresolved blocking failures (fail-closed)", () => {
    expect(
      claim.reduce("VALIDATING", "validation_passed", { unresolvedBlockingFailures: 2 }).error,
    ).toBe("GUARD_FAILED");
    // missing ctx ⇒ fail-closed
    expect(claim.reduce("READY", "submit").error).toBe("GUARD_FAILED");
  });

  it("AWAITING_MEDICARE_PRIMARY auto-resolves on ack and fails on reject", () => {
    expect(claim.reduce("READY", "await_medicare_primary").state).toBe("AWAITING_MEDICARE_PRIMARY");
    expect(claim.reduce("AWAITING_MEDICARE_PRIMARY", "medicare_primary_acknowledged").state).toBe(
      "READY",
    );
    expect(claim.reduce("AWAITING_MEDICARE_PRIMARY", "medicare_primary_rejected").state).toBe(
      "FAILED_MEDICARE_PRIMARY",
    );
    expect(claim.reduce("FAILED_MEDICARE_PRIMARY", "medicare_primary_acknowledged").state).toBe(
      "READY",
    );
  });

  it("async poll path and rejection→revalidate/abandon", () => {
    expect(claim.reduce("SUBMITTED", "pending_async").state).toBe("POLLING");
    expect(claim.reduce("POLLING", "poll_still_pending").state).toBe("POLLING");
    expect(claim.reduce("POLLING", "poll_timeout").state).toBe("ACK_TIMEOUT");
    expect(claim.reduce("ACK_REJECTED", "abandon").state).toBe("ABANDONED");
  });

  it("rejects illegal transitions without throwing and reports terminals", () => {
    expect(claim.reduce("PAID", "begin_validation").error).toBe("INVALID_TRANSITION");
    expect(claim.isTerminal("REPLACED")).toBe(true);
    expect(claim.isTerminal("VOIDED")).toBe(true);
    expect(claim.isTerminal("ABANDONED")).toBe(true);
    expect(claim.isTerminal("DRAFT")).toBe(false);
  });
});

describe("rb_arrangement machine", () => {
  it("DRAFT → ACTIVE → {EXPIRED, TERMINATED, SUPERSEDED}", () => {
    expect(rbArr.reduce("DRAFT", "activate").state).toBe("ACTIVE");
    expect(rbArr.reduce("ACTIVE", "expire").state).toBe("EXPIRED");
    expect(rbArr.reduce("ACTIVE", "terminate").state).toBe("TERMINATED");
    expect(rbArr.reduce("ACTIVE", "supersede").state).toBe("SUPERSEDED");
    expect(rbArr.isTerminal("EXPIRED")).toBe(true);
    expect(rbArr.reduce("EXPIRED", "activate").error).toBe("INVALID_TRANSITION");
  });
});

describe("rb_day machine", () => {
  it("pending → billable → billed → billable; excluded revert; void terminal", () => {
    expect(rbDay.reduce("pending", "mark_billable").state).toBe("billable");
    expect(rbDay.reduce("billable", "bill").state).toBe("billed");
    expect(rbDay.reduce("billed", "unbill").state).toBe("billable");
    expect(rbDay.reduce("excluded", "revert_exclusion").state).toBe("billable");
    expect(rbDay.reduce("billable", "void").state).toBe("voided");
    expect(rbDay.isTerminal("voided")).toBe(true);
  });
});
