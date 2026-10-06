// GAP-073 — pure decisions behind POST /remittance/lines/:id/manual-match and /adjustments/:id/override.
import { describe, expect, it } from "vitest";
import { decideAdjustmentOverride, decideManualMatch } from "../manual-posting";

const CLAIM = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("decideManualMatch", () => {
  it("posts an unmatched line", () => {
    const line = { matchState: "unmatched", matchStrategy: null, claimId: null };
    expect(decideManualMatch(line, CLAIM, "paid")).toEqual({ kind: "post", nextState: "posted" });
  });
  it("lands a reversal in reversed", () => {
    const line = { matchState: "unmatched", matchStrategy: null, claimId: null };
    expect(decideManualMatch(line, CLAIM, "recouped")).toEqual({
      kind: "post",
      nextState: "reversed",
    });
  });
  it("completes a legacy manual_matched line bound to the same claim", () => {
    const line = { matchState: "manual_matched", matchStrategy: "manual", claimId: CLAIM };
    expect(decideManualMatch(line, CLAIM, "denied").kind).toBe("post");
  });
  it("is a no-op replay once posted to the same claim", () => {
    const line = { matchState: "posted", matchStrategy: "manual", claimId: CLAIM };
    expect(decideManualMatch(line, CLAIM, "paid")).toEqual({ kind: "noop", matchState: "posted" });
  });
  it("conflicts when a posted line is re-matched to another claim", () => {
    const line = { matchState: "posted", matchStrategy: "manual", claimId: CLAIM };
    expect(decideManualMatch(line, OTHER, "paid").kind).toBe("conflict");
  });
  it("conflicts on an auto-matched line", () => {
    const line = { matchState: "auto_matched", matchStrategy: "payer_icn", claimId: CLAIM };
    expect(decideManualMatch(line, CLAIM, "paid").kind).toBe("conflict");
  });
  it("conflicts on an auto-posted line even for the same claim", () => {
    const line = { matchState: "posted", matchStrategy: "payer_icn", claimId: CLAIM };
    expect(decideManualMatch(line, CLAIM, "paid").kind).toBe("conflict");
  });
});

describe("decideAdjustmentOverride", () => {
  const flagged = { postAction: "flagged_review", amount: 12.5, denialCaseId: null } as const;
  it("write-off needs no patient", () => {
    expect(decideAdjustmentOverride(flagged, "auto_posted", null)).toEqual({
      kind: "apply",
      effect: "write_off",
    });
  });
  it("denial seed needs no patient", () => {
    expect(decideAdjustmentOverride(flagged, "denial_seeded", null)).toEqual({
      kind: "apply",
      effect: "denial",
    });
  });
  it("ledger needs a resolvable patient", () => {
    expect(decideAdjustmentOverride(flagged, "ledger_recorded", null).kind).toBe("conflict");
    expect(decideAdjustmentOverride(flagged, "ledger_recorded", "p1")).toEqual({
      kind: "apply",
      effect: "ledger",
    });
  });
  it("ledger refuses a non-positive amount", () => {
    expect(decideAdjustmentOverride({ ...flagged, amount: 0 }, "ledger_recorded", "p1").kind).toBe(
      "conflict",
    );
  });
  it("same action is an idempotent no-op", () => {
    const done = { postAction: "ledger_recorded", amount: 5, denialCaseId: null } as const;
    expect(decideAdjustmentOverride(done, "ledger_recorded", "p1")).toEqual({ kind: "noop" });
  });
  it("an already-classified adjustment cannot be re-classified", () => {
    const done = { postAction: "auto_posted", amount: 5, denialCaseId: null } as const;
    expect(decideAdjustmentOverride(done, "denial_seeded", null).kind).toBe("conflict");
  });
});
