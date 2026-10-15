import type { EscalationRouteAnswer, EscalationRouter } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { EscalationRouterAnswerError, guardEscalationRouter } from "./escalation-router-guard";

const ORG = "00000000-0000-4000-8000-00000000000a";
const PATIENT = "00000000-0000-4000-8000-0000000000d1";
const USER = "00000000-0000-4000-8000-0000000000c1";
const ASK = { patientId: PATIENT, requiredRole: "rn", tier: 1, asOf: "2026-10-15T12:00:00.000Z" };

const routerAnswering = (
  answer: Partial<EscalationRouteAnswer> & { kind: string },
): EscalationRouter => ({
  async resolveTier() {
    return { tier: 1, asOf: ASK.asOf, source: "m19", ...answer } as EscalationRouteAnswer;
  },
});

describe("guardEscalationRouter", () => {
  it("passes a well-formed answer through", async () => {
    const guarded = guardEscalationRouter(
      routerAnswering({
        kind: "resolved",
        userIds: [USER],
        nextTier: null,
        timeZone: "UTC",
      } as never),
    );
    expect(await guarded.resolveTier(ORG, ASK)).toMatchObject({
      kind: "resolved",
      userIds: [USER],
    });
  });

  it("passes the deny-stub's unavailable answer through (the production default today)", async () => {
    const guarded = guardEscalationRouter(
      routerAnswering({
        kind: "unavailable",
        reason: "router_not_bound",
        source: "deny_stub",
      } as never),
    );
    expect(await guarded.resolveTier(ORG, ASK)).toMatchObject({ kind: "unavailable" });
  });

  it("refuses a call whose organization or patient is not an id, before the seam is reached", async () => {
    let reached = false;
    const guarded = guardEscalationRouter({
      async resolveTier() {
        reached = true;
        throw new Error("unreachable");
      },
    });
    await expect(guarded.resolveTier("not-an-org", ASK)).rejects.toBeInstanceOf(
      EscalationRouterAnswerError,
    );
    await expect(guarded.resolveTier(ORG, { ...ASK, patientId: "x" })).rejects.toBeInstanceOf(
      EscalationRouterAnswerError,
    );
    await expect(guarded.resolveTier(ORG, { ...ASK, tier: 0 })).rejects.toBeInstanceOf(
      EscalationRouterAnswerError,
    );
    expect(reached).toBe(false);
  });

  it("refuses an answer for another tier or instant, a test source, and malformed recipients", async () => {
    const bad: Array<Partial<EscalationRouteAnswer> & { kind: string }> = [
      { kind: "unavailable", reason: "router_not_bound", tier: 2 } as never,
      {
        kind: "unavailable",
        reason: "router_not_bound",
        asOf: "2026-10-15T12:00:01.000Z",
      } as never,
      { kind: "unavailable", reason: "router_not_bound", source: "in_memory_fake" } as never,
      { kind: "resolved", userIds: ["not-an-id"], nextTier: null, timeZone: "UTC" } as never,
      { kind: "resolved", userIds: [], nextTier: null, timeZone: "UTC" } as never,
    ];
    for (const answer of bad) {
      await expect(
        guardEscalationRouter(routerAnswering(answer)).resolveTier(ORG, ASK),
      ).rejects.toBeInstanceOf(EscalationRouterAnswerError);
    }
  });

  it("accepts the test source only when a test says so", async () => {
    const fake = routerAnswering({
      kind: "unavailable",
      reason: "router_not_bound",
      source: "in_memory_fake",
    } as never);
    expect(
      await guardEscalationRouter(fake, { allowFakeSource: true }).resolveTier(ORG, ASK),
    ).toMatchObject({
      source: "in_memory_fake",
    });
  });

  it.each([0, 1, -3, 1e9, 1.5, 100])(
    "treats a malformed nextTier (%s) as 'cannot route' instead of throwing",
    async (nextTier) => {
      for (const answer of [
        { kind: "resolved", userIds: [USER], nextTier, timeZone: "UTC" },
        { kind: "coverage_gap", nextTier, timeZone: "UTC" },
      ] as never[]) {
        const guarded = guardEscalationRouter(routerAnswering(answer));
        expect(await guarded.resolveTier(ORG, ASK)).toMatchObject({
          kind: "unavailable",
          tier: 1,
          asOf: ASK.asOf,
          source: "m19",
        });
      }
    },
  );

  it("accepts a nextTier above the tier, up to the ceiling", async () => {
    const guarded = guardEscalationRouter(
      routerAnswering({
        kind: "resolved",
        userIds: [USER],
        nextTier: 99,
        timeZone: "UTC",
      } as never),
    );
    expect(await guarded.resolveTier(ORG, ASK)).toMatchObject({ kind: "resolved", nextTier: 99 });
  });
});
