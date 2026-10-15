import { WardenXError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { createInMemoryEscalationRouter } from "../src/escalation/in-memory-escalation-router";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const PATIENT = "00000000-0000-4000-8000-0000000000f1";
const RN = "rn";

const NY = "America/New_York";
const day = { startTime: "07:00", endTime: "19:00" } as const;
const night = { startTime: "19:00", endTime: "07:00" } as const;

function routerA() {
  return createInMemoryEscalationRouter({
    orgId: ORG_A,
    ladders: [
      {
        role: RN,
        tiers: [
          {
            tier: 1,
            rotations: [
              { timeZone: NY, windows: [day], userIds: ["u-day"] },
              { timeZone: NY, windows: [night], userIds: ["u-night"] },
            ],
          },
          { tier: 2, rotations: [{ timeZone: "Asia/Tokyo", windows: [day], userIds: ["u-sup"] }] },
        ],
      },
    ],
  });
}

const ask = (r: ReturnType<typeof routerA>, tier: number, asOf: string, role = RN, orgId = ORG_A) =>
  r.resolveTier(orgId, { patientId: PATIENT, requiredRole: role, tier, asOf });

describe("in-memory EscalationRouter", () => {
  it("resolves the day rotation inside the day shift and names the next tier and the schedule zone", async () => {
    const answer = await ask(routerA(), 1, "2026-06-01T16:00:00Z"); // 12:00 EDT
    expect(answer).toEqual({
      kind: "resolved",
      tier: 1,
      userIds: ["u-day"],
      nextTier: 2,
      timeZone: NY,
      asOf: "2026-06-01T16:00:00Z",
      source: "in_memory_fake",
    });
  });

  it("switches exactly at the shift boundary: end exclusive, start inclusive", async () => {
    const r = routerA();
    // 19:00 EDT = 23:00Z
    const before = await ask(r, 1, "2026-06-01T22:59:59Z");
    const at = await ask(r, 1, "2026-06-01T23:00:00Z");
    expect(before.kind === "resolved" && before.userIds).toEqual(["u-day"]);
    expect(at.kind === "resolved" && at.userIds).toEqual(["u-night"]);
  });

  it("evaluates each tier in that tier's own zone", async () => {
    // 2026-06-01T03:00Z is 12:00 in Tokyo (inside the tier-2 day shift) and 23:00 in New York.
    const answer = await ask(routerA(), 2, "2026-06-01T03:00:00Z");
    expect(answer).toMatchObject({
      kind: "resolved",
      userIds: ["u-sup"],
      nextTier: null,
      timeZone: "Asia/Tokyo",
    });
  });

  it("answers the same for the same instant across a spring-forward night", async () => {
    const r = routerA();
    // 07:00 EDT on 2026-03-08 is 11:00Z; the minute before is still the night rotation.
    const night1 = await ask(r, 1, "2026-03-08T10:59:00Z");
    const day1 = await ask(r, 1, "2026-03-08T11:00:00Z");
    expect(night1.kind === "resolved" && night1.userIds).toEqual(["u-night"]);
    expect(day1.kind === "resolved" && day1.userIds).toEqual(["u-day"]);
    expect(await ask(r, 1, "2026-03-08T10:59:00Z")).toEqual(night1);
  });

  it("answers every minute across a fall-back day with exactly one rotation", async () => {
    const r = routerA();
    const start = Date.parse("2026-10-31T20:00:00Z");
    for (let t = start; t < start + 36 * 3_600_000; t += 15 * 60_000) {
      const a = await ask(r, 1, new Date(t).toISOString());
      expect(a.kind === "resolved" && a.userIds.length).toBe(1);
    }
  });

  it("reports a coverage gap, not an empty recipient list, when no rotation covers the instant", async () => {
    const r = createInMemoryEscalationRouter({
      orgId: ORG_A,
      ladders: [
        {
          role: RN,
          tiers: [{ tier: 1, rotations: [{ timeZone: NY, windows: [day], userIds: ["u-day"] }] }],
        },
      ],
    });
    const answer = await ask(r, 1, "2026-06-02T04:00:00Z"); // 00:00 EDT
    expect(answer).toMatchObject({ kind: "coverage_gap", tier: 1, nextTier: null, timeZone: NY });
  });

  it("reports a coverage gap with no next tier when the ladder is exhausted", async () => {
    const answer = await ask(routerA(), 3, "2026-06-01T16:00:00Z");
    expect(answer).toMatchObject({ kind: "coverage_gap", tier: 3, nextTier: null });
  });

  it("says unavailable (no_route_configured) for a role with no ladder", async () => {
    const answer = await ask(routerA(), 1, "2026-06-01T16:00:00Z", "chaplain");
    expect(answer).toMatchObject({
      kind: "unavailable",
      reason: "no_route_configured",
      source: "in_memory_fake",
    });
  });

  it("refuses a call for another org rather than answering from its own roster", async () => {
    const promise = ask(routerA(), 1, "2026-06-01T16:00:00Z", RN, ORG_B);
    await expect(promise).rejects.toBeInstanceOf(WardenXError);
    await expect(promise).rejects.toMatchObject({
      code: "ESCALATION_ORG_MISMATCH",
      statusCode: 403,
    });
  });

  it("never returns another org's users: two routers keep separate rosters", async () => {
    const b = createInMemoryEscalationRouter({
      orgId: ORG_B,
      ladders: [
        {
          role: RN,
          tiers: [{ tier: 1, rotations: [{ timeZone: NY, windows: [day], userIds: ["b-user"] }] }],
        },
      ],
    });
    const a = await ask(routerA(), 1, "2026-06-01T16:00:00Z");
    const bAnswer = await ask(b, 1, "2026-06-01T16:00:00Z", RN, ORG_B);
    expect(a.kind === "resolved" && a.userIds).toEqual(["u-day"]);
    expect(bAnswer.kind === "resolved" && bAnswer.userIds).toEqual(["b-user"]);
  });

  it("throws on an invalid request instead of guessing", async () => {
    const r = routerA();
    await expect(ask(r, 0, "2026-06-01T16:00:00Z")).rejects.toMatchObject({
      code: "ESCALATION_REQUEST_INVALID",
    });
    await expect(ask(r, 1, "yesterday")).rejects.toBeInstanceOf(WardenXError);
  });

  it("rejects an unknown schedule zone when the router is built", () => {
    expect(() =>
      createInMemoryEscalationRouter({
        orgId: ORG_A,
        ladders: [
          {
            role: RN,
            tiers: [
              {
                tier: 1,
                rotations: [{ timeZone: "Nowhere/Land", windows: [day], userIds: ["x"] }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/time zone/i);
  });
});
