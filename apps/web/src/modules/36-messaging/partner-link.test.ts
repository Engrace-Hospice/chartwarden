import { describe, expect, it } from "vitest";
import { buildPartnerInvitationLink, parsePartnerFragment } from "./partner-link";

const ORG = "33333333-3333-4333-8333-333333333333";
const TOKEN = `${"Ab_-".repeat(10)}Abc`; // 43 url-safe characters

describe("partner invitation link", () => {
  it("round-trips through the fragment and puts nothing in the query", () => {
    const link = buildPartnerInvitationLink("https://acme.example", ORG, TOKEN);
    expect(link).toBe(`https://acme.example/partner/share#o=${ORG}&t=${TOKEN}`);
    expect(new URL(link).search).toBe("");
    expect(parsePartnerFragment(new URL(link).hash)).toEqual({ organizationId: ORG, token: TOKEN });
  });

  it.each([
    ["empty", ""],
    ["no token", `#o=${ORG}`],
    ["no org", `#t=${TOKEN}`],
    ["short token", `#o=${ORG}&t=abc`],
    ["bad org", `#o=nope&t=${TOKEN}`],
    ["token with a slash", `#o=${ORG}&t=${"a/".repeat(21)}a`],
  ])("rejects a %s", (_name, hash) => {
    expect(parsePartnerFragment(hash)).toBeNull();
  });
});
