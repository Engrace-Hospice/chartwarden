import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  M36_PROMOTION_OUTCOME_CONSUMER,
  PROMOTION_DECIDED_TEXT,
  buildM36PromotionOutcomesConsumer,
} from "./promotion-outcomes";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const RESULT = "44444444-4444-4444-8444-444444444444";
const AT = "2026-10-14T12:00:00.000Z";

const event = (id: string, eventType: string, payload: Record<string, unknown>) =>
  ({
    id,
    eventType,
    organizationId: ORG,
    createdAt: new Date(AT),
    payload: {
      organizationId: "attacker-copy-is-ignored",
      promotionRequestId: REQ,
      outcome: "accepted",
      resultRef: RESULT,
      decidedByUserId: USER,
      reasonCode: null,
      at: AT,
      ...payload,
    },
  }) as never;

function setup(applied: unknown = { applied: "accepted", requestedByUserId: USER }) {
  const emit = vi.fn(async (_org: string, _input: unknown) => ({
    alertId: "a",
    resolvedRecipientCount: 1,
  }));
  const applyOutcome = vi.fn(async () => applied as never);
  const warn = vi.fn();
  const consumer = buildM36PromotionOutcomesConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    applyOutcome,
    warn,
  });
  return { emit, applyOutcome, warn, consumer };
}

describe("M36 chart-promotion outcomes consumer", () => {
  it("binds both owner events under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_PROMOTION_OUTCOME_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes].sort()).toEqual([
      "m14.chart_promotion.decided",
      "m8.chart_promotion.decided",
    ]);
  });

  it("takes the tenant from the envelope and the owner from the event NAME, never the payload", async () => {
    const { applyOutcome, consumer } = setup();
    await consumer.handle(
      event("evt-1", "m8.chart_promotion.decided", { ownerModule: "m14", organizationId: "x" }),
    );
    expect(applyOutcome).toHaveBeenCalledWith(ORG, {
      ownerModule: "m8",
      promotionRequestId: REQ,
      outcome: "accepted",
      resultRef: RESULT,
      decidedByUserId: USER,
      reasonCode: null,
      at: new Date(AT),
    });
  });

  it("tells the requester once with fixed, PHI-free text when a decision is applied", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(event("evt-1", "m14.chart_promotion.decided", {}));
    expect(emit).toHaveBeenCalledWith(ORG, {
      eventType: "m36.promotion.decided",
      severity: "info",
      correlationId: `promotion:${REQ}:evt-1:m36.promotion.decided`,
      payload: {
        requestedByUserId: USER,
        promotionRequestId: REQ,
        message: PROMOTION_DECIDED_TEXT.accepted,
        deepLink: "/notifications?tab=promotions",
      },
    });
  });

  it("uses the not-accepted wording for a rejection and drops an unknown reason code", async () => {
    const { emit, applyOutcome, consumer } = setup({
      applied: "rejected",
      requestedByUserId: USER,
    });
    await consumer.handle(
      event("evt-2", "m8.chart_promotion.decided", {
        outcome: "rejected",
        resultRef: null,
        reasonCode: "because I said so",
      }),
    );
    expect(applyOutcome).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ outcome: "rejected", reasonCode: null }),
    );
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      payload: { message: PROMOTION_DECIDED_TEXT.rejected },
    });
  });

  it.each(["noop", "ignored", "conflict", "unknown"])(
    "alerts nobody and throws nothing when the outcome is %s",
    async (applied) => {
      const { emit, warn, consumer } = setup({ applied });
      await expect(
        consumer.handle(event("evt-3", "m8.chart_promotion.decided", {})),
      ).resolves.toBeUndefined();
      expect(emit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(applied === "noop" ? 0 : 1);
    },
  );

  it("ignores a malformed event (no id, unknown outcome, bad instant) with a log and no write", async () => {
    const { applyOutcome, warn, consumer } = setup();
    for (const bad of [{ promotionRequestId: "" }, { outcome: "maybe" }, { at: "not a date" }]) {
      await consumer.handle(event("evt-4", "m8.chart_promotion.decided", bad));
    }
    expect(applyOutcome).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
