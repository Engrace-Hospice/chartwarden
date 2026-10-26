/**
 * REGRESSION: the Claim Workbench offers `partial_paid` in its state filter (and the response schema, the
 * DB enum `m23_claim_state` and the §2.2 machine all carry it), but `ClaimListQuerySchema.state` omitted it,
 * so `GET /api/v1/billing/claims?state=partial_paid` was rejected as a validation error.
 */
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ClaimListQuerySchema } from "../routes/billing-typebox";

describe("ClaimListQuerySchema state filter", () => {
  it.each(["paid", "partial_paid", "ack_partial", "denied"])("accepts state=%s", (state) => {
    expect(Value.Check(ClaimListQuerySchema, { state })).toBe(true);
  });

  it("still rejects an unknown state", () => {
    expect(Value.Check(ClaimListQuerySchema, { state: "bogus" })).toBe(false);
  });
});
