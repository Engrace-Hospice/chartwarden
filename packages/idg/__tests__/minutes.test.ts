// @wardenx/idg — D10 minutes finalization + §164.526 amendment workflow — M14-T03.
import { describe, expect, it } from "vitest";
import {
  assertMinutesMutable,
  planMinutesFinalize,
  planMinutesAmendmentRequest,
  planMinutesAmendmentApproval,
  outboxEvents,
} from "../src/lifecycle";

describe("D10 in_progress mutability", () => {
  it("permits annotation while in_progress", () => {
    expect(() => assertMinutesMutable("in_progress")).not.toThrow();
  });

  it("refuses a direct mutation of final minutes (422 MINUTES_FINAL)", () => {
    expect(() => assertMinutesMutable("final")).toThrowError(
      expect.objectContaining({ code: "MINUTES_FINAL", statusCode: 422 }),
    );
  });
});

describe("D10 finalize on adjournment", () => {
  it("flips in_progress→final and emits minutes.signed", () => {
    const r = planMinutesFinalize("in_progress");
    expect(r.to).toBe("final");
    expect(r.effects).toContainEqual({ kind: "set_timestamp", field: "finalized_at" });
    expect(outboxEvents(r.effects)).toEqual(["m14.minutes.signed"]);
  });

  it("refuses finalize of non-in-progress minutes (409 MINUTES_NOT_IN_PROGRESS)", () => {
    expect(() => planMinutesFinalize("final")).toThrowError(
      expect.objectContaining({ code: "MINUTES_NOT_IN_PROGRESS", statusCode: 409 }),
    );
  });
});

describe("D10 / W-MIN-01 amendment workflow", () => {
  it("requesting an amendment against final minutes notifies Compliance (no event yet)", () => {
    const e = planMinutesAmendmentRequest("final");
    expect(e).toContainEqual({ kind: "notify_compliance" });
    expect(outboxEvents(e)).toEqual([]);
  });

  it("refuses an amendment request against non-final minutes", () => {
    expect(() => planMinutesAmendmentRequest("in_progress")).toThrowError(
      expect.objectContaining({ code: "MINUTES_NOT_IN_PROGRESS" }),
    );
  });

  it("approving a pending amendment emits minutes.amended", () => {
    const e = planMinutesAmendmentApproval({ approvedAt: null });
    expect(e).toContainEqual({ kind: "set_timestamp", field: "approved_at" });
    expect(outboxEvents(e)).toEqual(["m14.minutes.amended"]);
  });

  it("refuses to re-approve an already-approved amendment (409)", () => {
    expect(() => planMinutesAmendmentApproval({ approvedAt: "2026-06-19T00:00:00Z" })).toThrowError(
      expect.objectContaining({ code: "AMENDMENT_ALREADY_APPROVED", statusCode: 409 }),
    );
  });
});
