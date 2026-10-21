import type { AlertEmitter } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  M36_PROMOTION_NOTIFICATION_CONSUMER,
  PROMOTION_MAX_REVIEWERS,
  PROMOTION_NOTIFICATION_TEXT,
  buildM36PromotionNotificationsConsumer,
} from "./promotion-notifications";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const REQUESTER = "u-requester";
const PATIENT = "p-1";

const requested = (id = "evt-1") =>
  ({
    id,
    eventType: "m36.promotion.requested",
    organizationId: ORG,
    payload: { organizationId: "attacker-copy-is-ignored", promotionRequestId: REQ },
  }) as never;

interface Opts {
  targetModule?: string;
  status?: string;
  team?: string[];
  signers?: string[];
  idgReached?: number;
  gone?: boolean;
}

function setup(o: Opts = {}) {
  const emit = vi.fn(async (_org: string, input: { eventType: string }) => ({
    alertId: "a",
    resolvedRecipientCount:
      input.eventType === "m36.promotion.idg_review_requested" ? (o.idgReached ?? 1) : 1,
  }));
  const consumer = buildM36PromotionNotificationsConsumer({
    alerts: { emit } as unknown as AlertEmitter,
    requestFacts: async () =>
      o.gone
        ? null
        : {
            requestedByUserId: REQUESTER,
            targetModule: o.targetModule ?? "m8",
            status: o.status ?? "proposed",
            patientId: PATIENT,
          },
    careTeamMembers: async () => o.team ?? [REQUESTER, "u-rn", "u-aide"],
    canSignAddendum: async (_org, userId) => (o.signers ?? ["u-rn", REQUESTER]).includes(userId),
  });
  return { emit, consumer };
}

const types = (emit: ReturnType<typeof setup>["emit"]) =>
  emit.mock.calls.map((c) => c[1].eventType);

describe("M36 chart-promotion notifications consumer", () => {
  it("subscribes to the requested event under its own name", () => {
    const { consumer } = setup();
    expect(consumer.consumerName).toBe(M36_PROMOTION_NOTIFICATION_CONSUMER);
    expect(consumer.consumerModule).toBe("m36");
    expect([...consumer.eventTypes]).toEqual(["m36.promotion.requested"]);
  });

  it("m8: alerts care-team members who can sign an addendum, never the requester or an aide", async () => {
    const { emit, consumer } = setup();
    await consumer.handle(requested());
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        eventType: "m36.promotion.review_requested",
        correlationId: `promotion:${REQ}:evt-1:m36.promotion.review_requested:u-rn`,
        payload: {
          reviewerUserId: "u-rn",
          promotionRequestId: REQ,
          message: PROMOTION_NOTIFICATION_TEXT.reviewRequested,
          deepLink: "/notifications",
        },
      }),
    );
  });

  it("m8: caps the audience", async () => {
    const team = Array.from({ length: 50 }, (_, i) => `u-${i}`);
    const { emit, consumer } = setup({ team, signers: team });
    await consumer.handle(requested());
    expect(emit).toHaveBeenCalledTimes(PROMOTION_MAX_REVIEWERS);
  });

  it("m8: tells the requester when nobody on the team can review", async () => {
    const { emit, consumer } = setup({ signers: [] });
    await consumer.handle(requested());
    expect(types(emit)).toEqual(["m36.promotion.no_reviewer"]);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      payload: { requestedByUserId: REQUESTER, message: PROMOTION_NOTIFICATION_TEXT.noReviewer },
    });
  });

  it("m14: alerts the coordinator audience once, and the requester when it resolves to nobody", async () => {
    const reached = setup({ targetModule: "m14" });
    await reached.consumer.handle(requested());
    expect(types(reached.emit)).toEqual(["m36.promotion.idg_review_requested"]);
    const nobody = setup({ targetModule: "m14", idgReached: 0 });
    await nobody.consumer.handle(requested());
    expect(types(nobody.emit)).toEqual([
      "m36.promotion.idg_review_requested",
      "m36.promotion.no_reviewer",
    ]);
  });

  it.each([{ status: "withdrawn" }, { status: "accepted" }, { gone: true }])(
    "a stale event (%o) alerts nobody",
    async (o) => {
      const { emit, consumer } = setup(o);
      await consumer.handle(requested());
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it("throws on a payload without a request id so the delivery is retried", async () => {
    const { consumer } = setup();
    await expect(
      consumer.handle({ ...(requested() as object), payload: {} } as never),
    ).rejects.toThrow(/promotionRequestId/);
  });
});
