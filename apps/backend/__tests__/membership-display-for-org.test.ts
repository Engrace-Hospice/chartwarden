// The identity-owned staff display seam (`membershipDisplayForOrg`) — the pure halves. The RLS/JOIN
// behaviour is proven live, as the NOBYPASSRLS `chartwarden_app` role, in `m14-idg-read-service.live.test.ts`.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_DISPLAY_MAX_IDS,
  membershipDisplayForOrg,
  toMembershipDisplayLabel,
} from "../src/modules/02-identity/membership-display-for-org";

describe("toMembershipDisplayLabel", () => {
  it("trims the name and exposes ONLY {membershipId, displayName}", () => {
    expect(toMembershipDisplayLabel({ membershipId: "m1", name: "  Dana C.  " })).toEqual({
      membershipId: "m1",
      displayName: "Dana C.",
    });
  });
  it("a null or blank name is null — never an email/id stand-in", () => {
    expect(toMembershipDisplayLabel({ membershipId: "m1", name: null }).displayName).toBeNull();
    expect(toMembershipDisplayLabel({ membershipId: "m1", name: "   " }).displayName).toBeNull();
  });
});

describe("membershipDisplayForOrg guards (no DB touched)", () => {
  // A db that throws on any use proves the early returns/refusals happen before a query is issued.
  const explodingDb = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("db must not be touched");
      },
    },
  ) as unknown as DbClient;

  it("empty input performs no query", async () => {
    expect((await membershipDisplayForOrg(explodingDb, "org", [])).size).toBe(0);
  });
  it("de-duplicates before applying the cap, and refuses an oversized id list", async () => {
    const dup = Array.from({ length: MEMBERSHIP_DISPLAY_MAX_IDS + 5 }, () => "same");
    // 505 copies of one id is ONE id — passes the cap and reaches the (exploding) db.
    await expect(membershipDisplayForOrg(explodingDb, "org", dup)).rejects.toThrow(
      /db must not be touched/,
    );
    const many = Array.from({ length: MEMBERSHIP_DISPLAY_MAX_IDS + 1 }, (_, i) => `m${i}`);
    await expect(membershipDisplayForOrg(explodingDb, "org", many)).rejects.toThrow(
      /exceeds the 500 cap/,
    );
  });
});
