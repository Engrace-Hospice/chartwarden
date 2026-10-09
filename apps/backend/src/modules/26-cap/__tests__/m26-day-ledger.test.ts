// GAP-038 — the inpatient day ledger's claim identity + reversal path (pure dispatch/handler proof).
// The SQL half (reconcile, ON CONFLICT identity stamp, re-pay clears reversal) is proven live in
// `apps/backend/__tests__/m26-cap-consumer-store.live.test.ts`.
import { describe, expect, it, vi } from "vitest";
import {
  type CapConsumerStore,
  M26_UPSTREAM_SUBSCRIPTIONS,
  createInMemoryCapConsumerStore,
  dispatchM26UpstreamEvent,
} from "../consumers/index";

const storeWith = (over: Partial<CapConsumerStore>): CapConsumerStore => ({
  ...createInMemoryCapConsumerStore(),
  ...over,
});

describe("GAP-038 day ledger — claim identity", () => {
  it("passes the finalized event's claimId through to recordInpatientDay", async () => {
    const recordInpatientDay = vi.fn(async () => ({ recorded: true }));
    await dispatchM26UpstreamEvent(
      {
        topic: "m23.claim.line_finalized",
        payload: {
          organizationId: "o1",
          claimId: "c1",
          patientId: "p1",
          claimLineId: "cl1",
          revenueCode: "0656",
          days: 3,
          serviceFrom: "2025-01-01",
          serviceTo: "2025-01-03",
          finalizedAt: "2025-02-01T00:00:00Z",
        },
      },
      storeWith({ recordInpatientDay }),
    );
    expect(recordInpatientDay).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: "c1", sourceId: "cl1" }),
    );
  });

  it("refuses a finalized line that carries no claimId (the ledger identity is mandatory)", async () => {
    const recordInpatientDay = vi.fn(async () => ({ recorded: true }));
    const r = await dispatchM26UpstreamEvent(
      {
        topic: "m23.claim.line_finalized",
        payload: {
          organizationId: "o1",
          patientId: "p1",
          claimLineId: "cl1",
          revenueCode: "0656",
          days: 3,
          serviceFrom: "2025-01-01",
          serviceTo: "2025-01-03",
          finalizedAt: "2025-02-01T00:00:00Z",
        },
      },
      storeWith({ recordInpatientDay }),
    );
    expect(r.handled).toBe(false);
    expect(recordInpatientDay).not.toHaveBeenCalled();
  });
});

describe("GAP-038 day ledger — reversal", () => {
  it.each([
    ["m23.claim.replaced", { originalClaimId: "c1", replacementClaimId: "c2", reason: "x" }, "c1"],
    ["m23.claim.voided", { originalClaimId: "c1", voidClaimId: "c3", reason: "x" }, "c1"],
    [
      "m25.remittance.claim_recouped",
      { claimId: "c1", patientId: null, serviceFrom: null, serviceTo: null },
      "c1",
    ],
  ])("%s reverses the days of claim %s's lines", async (topic, payload, claimId) => {
    const reverseInpatientDays = vi.fn(async () => ({ reversed: 2 }));
    const r = await dispatchM26UpstreamEvent(
      {
        topic,
        payload: { ...payload, organizationId: "o1", postedAt: "2025-03-01T00:00:00Z" },
      },
      storeWith({ reverseInpatientDays }),
    );
    expect(reverseInpatientDays).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "o1", claimId }),
    );
    expect(r.handled).toBe(true);
  });

  it("the replaced/voided reversal never keys on the replacement or void claim id", async () => {
    const reverseInpatientDays = vi.fn(async () => ({ reversed: 0 }));
    await dispatchM26UpstreamEvent(
      {
        topic: "m23.claim.replaced",
        payload: {
          organizationId: "o1",
          originalClaimId: "orig",
          replacementClaimId: "repl",
          reason: "x",
        },
      },
      storeWith({ reverseInpatientDays }),
    );
    expect(reverseInpatientDays).toHaveBeenCalledTimes(1);
    expect(reverseInpatientDays).toHaveBeenCalledWith(expect.objectContaining({ claimId: "orig" }));
  });

  it("an event with no claim id reverses nothing", async () => {
    const reverseInpatientDays = vi.fn(async () => ({ reversed: 0 }));
    const r = await dispatchM26UpstreamEvent(
      { topic: "m23.claim.voided", payload: { organizationId: "o1" } },
      storeWith({ reverseInpatientDays }),
    );
    expect(reverseInpatientDays).not.toHaveBeenCalled();
    expect(r.handled).toBe(false);
  });

  it("keeps the money-side subscriptions unchanged (no new topics)", () => {
    expect(M26_UPSTREAM_SUBSCRIPTIONS).toHaveLength(10);
  });
});
