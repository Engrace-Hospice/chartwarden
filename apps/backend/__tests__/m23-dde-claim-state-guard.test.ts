// ADR-0052: the server refuses a claim-subject DDE item the claim's state cannot support (mirrors the web mapping).
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { assertClaimStateAllowsDdeItem } from "../src/modules/23-billing-medicare/services/dde-queue-subject";

describe("assertClaimStateAllowsDdeItem", () => {
  it.each(["adjustment", "cancel"] as const)("%s needs an adjudicated claim", (itemType) => {
    for (const ok of ["paid", "partial_paid", "denied"]) {
      expect(() => assertClaimStateAllowsDdeItem(itemType, ok)).not.toThrow();
    }
    for (const bad of ["draft", "submitted", "ack_pending", "ack_rejected", "replaced", "voided"]) {
      expect(() => assertClaimStateAllowsDdeItem(itemType, bad)).toThrow(ChartWardenError);
    }
  });

  it("rtp_correction needs a payer-rejected or 277CA-accepted claim", () => {
    for (const ok of ["ack_rejected", "ack_accepted", "ack_partial"]) {
      expect(() => assertClaimStateAllowsDdeItem("rtp_correction", ok)).not.toThrow();
    }
    for (const bad of ["draft", "ack_pending", "paid", "denied"]) {
      expect(() => assertClaimStateAllowsDdeItem("rtp_correction", bad)).toThrow(ChartWardenError);
    }
  });

  it("refuses with a stable 409 code", () => {
    expect(() => assertClaimStateAllowsDdeItem("cancel", "draft")).toThrow(
      expect.objectContaining({ code: "DDE_CLAIM_STATE_NOT_ELIGIBLE", statusCode: 409 }),
    );
  });
});
