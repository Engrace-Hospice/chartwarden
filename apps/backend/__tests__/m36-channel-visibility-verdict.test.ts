// M36 scheduled send: the throw-vs-false decision of `canViewChannel` (no DB; fake Part 2 gate and CareTeamProvider seam).
// An outage with no definitive verdict THROWS (only when asked to), a denial is false, and a non-member is false.
import { beforeEach, describe, expect, it, vi } from "vitest";

const careTeamMembers = vi.fn<(input: unknown) => Promise<readonly string[]>>();
vi.mock("../src/bootstrap/index", () => ({
  getSeam: () => ({ careTeamMembers }),
}));

import {
  VisibilitySeamUnavailableError,
  channelVisibilityVerdict,
} from "../src/modules/36-messaging/messaging-route-service-db";
import type { Part2ChannelGate } from "../src/modules/36-messaging/part2-channel-gate";

const USER = "u1";
type Mode = "allow" | "deny" | "throw" | "m39-unanswerable";
const gate = (mode: Mode): Part2ChannelGate => ({
  async allowedUserIds({ userIds, onUnavailable }) {
    if (mode === "throw") throw new Error("flag read failed");
    if (mode === "m39-unanswerable") {
      for (const u of userIds) onUnavailable?.(u);
      return new Set();
    }
    return new Set(mode === "allow" ? userIds : []);
  },
});
const candidate = (memberSource: "auto" | "manual" | null) => ({
  kind: "care_team" as const,
  subjectId: "patient-1",
  memberSource,
});
const verdict = (
  mode: Mode,
  memberSource: "auto" | "manual" | null,
  throwOnSeamUnavailable: boolean,
) =>
  channelVisibilityVerdict("org", USER, candidate(memberSource), gate(mode), undefined, {
    throwOnSeamUnavailable,
  });

beforeEach(() => {
  careTeamMembers.mockReset();
  careTeamMembers.mockResolvedValue([USER]);
});

describe("channelVisibilityVerdict: outage vs denial", () => {
  it("a visible member is true", async () => {
    await expect(verdict("allow", "auto", true)).resolves.toBe(true);
  });

  it("an explicit Part 2 denial is false, never a throw", async () => {
    await expect(verdict("deny", "manual", true)).resolves.toBe(false);
  });

  it.each(["throw", "m39-unanswerable"] as const)(
    "a Part 2 gate outage (%s) throws only when asked to, for a live member",
    async (mode) => {
      await expect(verdict(mode, "manual", true)).rejects.toBeInstanceOf(
        VisibilitySeamUnavailableError,
      );
      await expect(verdict(mode, "manual", false)).resolves.toBe(false);
    },
  );

  it("a CareTeamProvider roster throw throws when asked to, and is false by default", async () => {
    careTeamMembers.mockRejectedValue(new Error("roster down"));
    await expect(verdict("allow", "auto", true)).rejects.toBeInstanceOf(
      VisibilitySeamUnavailableError,
    );
    await expect(verdict("allow", "auto", false)).resolves.toBe(false);
  });

  it("a non-member is false even while the seam is down (nothing to retry)", async () => {
    await expect(verdict("throw", null, true)).resolves.toBe(false);
    await expect(verdict("m39-unanswerable", null, true)).resolves.toBe(false);
  });

  it("a definitive Part 2 denial is not turned into an outage by a failing roster call", async () => {
    careTeamMembers.mockRejectedValue(new Error("roster down"));
    await expect(verdict("deny", "auto", true)).resolves.toBe(false);
    expect(careTeamMembers).not.toHaveBeenCalled();
  });

  it("a roster that no longer lists the user is a plain denial", async () => {
    careTeamMembers.mockResolvedValue(["someone-else"]);
    await expect(verdict("allow", "auto", true)).resolves.toBe(false);
  });
});
