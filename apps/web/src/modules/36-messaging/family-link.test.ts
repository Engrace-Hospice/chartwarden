import { describe, expect, it } from "vitest";
import { buildFamilyInvitationLink, parseFamilyFragment } from "./family-link";

const ORG = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);

describe("family link", () => {
  it("round-trips token and organisation through the fragment, never the query, and carries no phone number", () => {
    const link = buildFamilyInvitationLink("https://app.example", ORG, TOKEN);
    expect(link.startsWith("https://app.example/family/open#")).toBe(true);
    expect(link.includes("?")).toBe(false);
    expect(link).not.toContain("n=");
    expect(parseFamilyFragment(`#${link.split("#")[1]}`)).toEqual({
      invitation: { organizationId: ORG, token: TOKEN },
    });
  });

  it("returns no invitation for a malformed link, and ignores any number a forged link carries", () => {
    expect(parseFamilyFragment("#t=x&o=y&n=555-0100")).toEqual({ invitation: null });
    expect(parseFamilyFragment("")).toEqual({ invitation: null });
    expect(parseFamilyFragment(`#t=${TOKEN}&o=${ORG}&n=555-0100`)).toEqual({
      invitation: { organizationId: ORG, token: TOKEN },
    });
  });
});
