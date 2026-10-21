// ADR-0087 S2 - the pure decision matrix of a break-glass READ, and the static ratchet that the read predicate never reaches a write route.
// The database-backed behaviour (the real service, the trail, expiry on the database clock) is proven live in test:m36:break-glass:live.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BreakGlassDenyReason,
  type BreakGlassReadFacts,
  decideBreakGlassRead,
} from "./break-glass-read-access";

const OK: BreakGlassReadFacts = {
  flagOn: true,
  activeUser: true,
  channelKind: "discipline",
  liveGrant: true,
  excludedCategory: false,
  part2: "not_applicable",
};
const verdict = (over: Partial<BreakGlassReadFacts>): BreakGlassDenyReason | "allowed" => {
  const d = decideBreakGlassRead({ ...OK, ...over });
  return d.allowed ? "allowed" : d.reason;
};

describe("decideBreakGlassRead", () => {
  it("allows a live grant on an ordinary channel", () => {
    expect(verdict({})).toBe("allowed");
  });

  it("allows a care-team channel only when the Part 2 gate allows", () => {
    expect(verdict({ channelKind: "care_team", part2: "allowed" })).toBe("allowed");
    expect(verdict({ channelKind: "care_team", part2: "denied" })).toBe("part2_denied");
    expect(verdict({ channelKind: "care_team", part2: "unavailable" })).toBe("part2_unavailable");
  });

  it.each([
    ["flag off", { flagOn: false }, "flag_off"],
    ["inactive user", { activeUser: false }, "inactive_user"],
    ["unknown or cross-organisation channel", { channelKind: null }, "no_channel"],
    [
      "announcement (already org-wide; never the reason)",
      { channelKind: "announcement" },
      "announcement",
    ],
    [
      "no live grant (revoked, expired, other channel or other user)",
      { liveGrant: false },
      "no_live_grant",
    ],
    ["excluded role category", { excludedCategory: true }, "excluded_category"],
  ] as const)("refuses: %s", (_name, over, reason) => {
    expect(verdict(over)).toBe(reason);
  });

  it("evaluates the cheap facts first: the flag beats everything, then the user, then the channel", () => {
    expect(verdict({ flagOn: false, activeUser: false, channelKind: null, liveGrant: false })).toBe(
      "flag_off",
    );
    expect(verdict({ activeUser: false, channelKind: null, liveGrant: false })).toBe(
      "inactive_user",
    );
    expect(verdict({ channelKind: null, liveGrant: false })).toBe("no_channel");
  });

  it("a denial of any one fact is final: an allowed Part 2 verdict never rescues a refused category or a missing grant", () => {
    expect(verdict({ channelKind: "care_team", part2: "allowed", excludedCategory: true })).toBe(
      "excluded_category",
    );
    expect(verdict({ channelKind: "care_team", part2: "allowed", liveGrant: false })).toBe(
      "no_live_grant",
    );
  });
});

describe("the read predicate stays on the read routes", () => {
  const routes = readFileSync(join(__dirname, "../routes/messaging-routes.ts"), "utf8");

  it("VIEW_CHANNEL_READ guards exactly the three read GETs and no write", () => {
    // Every mention of the identifier: one definition and exactly three uses, so no other route (pins, search...) can be widened unnoticed.
    expect(routes.match(/\bVIEW_CHANNEL_READ\b/g)).toHaveLength(4);
    const uses = [...routes.matchAll(/preHandler: \[([^\]]*VIEW_CHANNEL_READ[^\]]*)\]/g)];
    expect(uses).toHaveLength(3);
    // Each use sits in an app.get( block: walk back from the match to the nearest route registration call.
    for (const m of uses) {
      const before = routes.slice(0, m.index);
      const registration = [...before.matchAll(/app\.(get|post|put|patch|delete)\(/g)].at(-1);
      expect(registration?.[1]).toBe("get");
    }
  });

  it("no other route file uses the read predicate or the read resolver as a guard", () => {
    for (const f of [
      "../routes/reaction-pin-routes.ts",
      "../routes/search-routes.ts",
      "../routes/attachment-routes.ts",
      "../routes/ack-routes.ts",
      "../routes/task-routes.ts",
      "../routes/draft-routes.ts",
    ]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src, f).not.toContain("CHANNEL_VISIBILITY_READ_PREDICATE");
      expect(src, f).not.toContain("canReadChannel");
    }
  });
});
