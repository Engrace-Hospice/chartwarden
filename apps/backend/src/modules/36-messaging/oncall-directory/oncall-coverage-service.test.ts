import type { EscalationRouteAnswer, EscalationRouter } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createOnCallCoverageService } from "./oncall-coverage-service";

const ORG = "00000000-0000-4000-8000-00000000000a";
const PATIENT = "00000000-0000-4000-8000-0000000000f1";
const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-06-01T21:07:00.000Z");
const NAMES: Record<string, string | null> = { [U1]: "Dana K.", [U2]: null };

function service(
  answers: Record<number, EscalationRouteAnswer>,
  over: { enabled?: boolean; calls?: number[] } = {},
) {
  const router: EscalationRouter = {
    async resolveTier(_org, request) {
      over.calls?.push(request.tier);
      const answer = answers[request.tier];
      if (!answer) throw new Error(`unexpected tier ${request.tier}`);
      return { ...answer, tier: request.tier, asOf: request.asOf };
    },
  };
  return createOnCallCoverageService({
    isEnabled: async () => over.enabled ?? true,
    router,
    displayName: async (_org, id) => NAMES[id] ?? null,
    now: () => NOW,
  });
}
const base = { asOf: "x", source: "m19" as const };
const input = { role: "rn" as const, patientId: PATIENT };

describe("OnCallCoverageService", () => {
  it("is the uniform 404 when the tenant flag is off and never asks the router", async () => {
    const calls: number[] = [];
    await expect(
      service({}, { enabled: false, calls }).get({ orgId: ORG }, input),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toEqual([]);
  });

  it("says the roster is not connected (unknown, not empty) when the deny-stub answers", async () => {
    const out = await service({
      1: { kind: "unavailable", reason: "router_not_bound", tier: 1, ...base, source: "deny_stub" },
    }).get({ orgId: ORG }, input);
    expect(out).toMatchObject({ status: "roster_not_connected", tiers: [] });
  });

  it("says not configured when M19 has no ladder for the role", async () => {
    const out = await service({
      1: { kind: "unavailable", reason: "no_route_configured", tier: 1, ...base },
    }).get({ orgId: ORG }, input);
    expect(out.status).toBe("not_configured");
  });

  it("walks tiers, names the people, keeps the roster zone and drops a missing or bogus shift end", async () => {
    const calls: number[] = [];
    const out = await service(
      {
        1: {
          kind: "resolved",
          userIds: [U1, U2],
          ranks: ["primary", "backup"],
          nextTier: 2,
          timeZone: "America/Los_Angeles",
          shiftEndsAt: "2026-06-02T02:00:00Z",
          tier: 1,
          ...base,
        },
        2: {
          kind: "resolved",
          userIds: [U1],
          ranks: ["primary"],
          nextTier: null,
          timeZone: "America/Los_Angeles",
          shiftEndsAt: "tomorrow-ish",
          tier: 2,
          ...base,
        },
      },
      { calls },
    ).get({ orgId: ORG }, input);
    expect(calls).toEqual([1, 2]);
    expect(out.status).toBe("covered");
    expect(out.as_of).toBe(NOW.toISOString());
    expect(out.tiers[0]).toEqual({
      tier: 1,
      state: "covering",
      people: [
        { display_name: "Dana K.", rank: "primary" },
        { display_name: null, rank: "backup" },
      ],
      shift_ends_at: "2026-06-02T02:00:00.000Z",
      time_zone: "America/Los_Angeles",
    });
    expect(out.tiers[1]?.shift_ends_at).toBeNull();
    expect(JSON.stringify(out)).not.toContain(U1);
  });

  it("uses the explicit ranks, lists primaries first and keeps the first of a repeated id", async () => {
    const out = await service({
      1: {
        kind: "resolved",
        userIds: [U2, U1, U2],
        ranks: ["backup", "backup", "primary"],
        nextTier: null,
        timeZone: "America/Los_Angeles",
        tier: 1,
        ...base,
      },
    }).get({ orgId: ORG }, input);
    // Explicit ranks, primaries first; a user ranked primary anywhere is primary (U2 is backup first, then primary).
    expect(out.tiers[0]?.people).toEqual([
      { display_name: null, rank: "primary" },
      { display_name: "Dana K.", rank: "backup" },
    ]);
  });

  it("labels nobody primary when the router supplies no ranks (no position inference)", async () => {
    const out = await service({
      1: {
        kind: "resolved",
        userIds: [U1, U2],
        nextTier: null,
        timeZone: "America/Los_Angeles",
        tier: 1,
        ...base,
      },
    }).get({ orgId: ORG }, input);
    expect(out.tiers[0]?.people.map((p) => p.rank)).toEqual(["backup", "backup"]);
  });

  it("reports an explicit coverage gap for tier 1 and still shows the backup", async () => {
    const out = await service({
      1: { kind: "coverage_gap", nextTier: 2, timeZone: "America/New_York", tier: 1, ...base },
      2: {
        kind: "resolved",
        userIds: [U1],
        nextTier: null,
        timeZone: "America/New_York",
        tier: 2,
        ...base,
      },
    }).get({ orgId: ORG }, input);
    expect(out.status).toBe("coverage_gap");
    expect(out.tiers.map((t) => t.state)).toEqual(["coverage_gap", "covering"]);
    expect(out.tiers[0]?.people).toEqual([]);
  });

  it("stops at the tier ceiling", async () => {
    const calls: number[] = [];
    const answer = (tier: number): EscalationRouteAnswer => ({
      kind: "resolved",
      userIds: [U1],
      nextTier: tier + 1,
      timeZone: "UTC",
      tier,
      ...base,
    });
    await service({ 1: answer(1), 2: answer(2), 3: answer(3), 4: answer(4) }, { calls }).get(
      { orgId: ORG },
      input,
    );
    expect(calls).toEqual([1, 2, 3, 4]);
  });

  it("propagates a router failure instead of mapping it to a gap", async () => {
    await expect(service({}).get({ orgId: ORG }, input)).rejects.toThrow("unexpected tier 1");
  });
});
