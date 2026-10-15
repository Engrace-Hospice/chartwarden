// WP 4.1 - the consume-time qualification: a clean no is false, a lookup failure propagates (the outbox retries).
import { describe, expect, it } from "vitest";
import { buildUrgentBinding } from "./binding";

const ORG = "o";
const USER = "u";
const CH = "c";
const PAT = "00000000-0000-4000-8000-0000000000e1";
const KEYS = ["messaging.read", "messaging.send", "patient.read", "messaging.urgent.receive"];

function make(over: {
  active?: boolean;
  keys?: string[];
  kind?: string;
  part2?: (ids: string[]) => Set<string>;
  failPermissions?: boolean;
  failGate?: boolean;
}) {
  return buildUrgentBinding({
    messaging: { canViewChannel: async () => true, sendMessage: (async () => ({})) as never },
    channelFacts: async () => ({ kind: over.kind ?? "care_team", subjectId: PAT }),
    displayName: async () => null,
    eligibility: {
      isActiveUser: async () => over.active !== false,
      permissionsFor: async () => {
        if (over.failPermissions) throw new Error("db blip");
        return new Set(over.keys ?? KEYS);
      },
      part2Gate: {
        allowedUserIds: async ({ userIds }: { userIds: string[] }) => {
          if (over.failGate) throw new Error("gate down");
          return over.part2 ? over.part2(userIds) : new Set(userIds);
        },
      } as never,
    },
  }).stillQualified;
}

describe("stillQualified", () => {
  it("is true for an active, keyed, Part-2-admitted user on a patient channel", async () => {
    expect(await make({})(ORG, USER, CH)).toBe(true);
  });

  it.each([
    ["inactive", { active: false }],
    ["missing urgent.receive", { keys: ["messaging.read", "messaging.send", "patient.read"] }],
    [
      "missing patient.read",
      { keys: ["messaging.read", "messaging.send", "messaging.urgent.receive"] },
    ],
    ["not a patient channel", { kind: "location" }],
    ["blocked by Part 2", { part2: () => new Set<string>() }],
  ])("is a clean false when the recipient is %s", async (_n, over) => {
    expect(await make(over)(ORG, USER, CH)).toBe(false);
  });

  it.each([
    ["the permission lookup", { failPermissions: true }],
    ["the Part 2 gate", { failGate: true }],
  ])("propagates a failure of %s instead of answering no", async (_n, over) => {
    await expect(make(over)(ORG, USER, CH)).rejects.toThrow();
  });
});
