import { describe, expect, it } from "vitest";
import { buildFamilyInvitationLink, parseFamilyFragment } from "./family-link";

const ORG = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);

describe("family link", () => {
  it("round-trips token, organisation and phone through the fragment, never the query", () => {
    const link = buildFamilyInvitationLink("https://app.example", ORG, TOKEN, "555-0100");
    expect(link.startsWith("https://app.example/family/open#")).toBe(true);
    expect(link.includes("?")).toBe(false);
    const parsed = parseFamilyFragment(`#${link.split("#")[1]}`);
    expect(parsed).toEqual({
      invitation: { organizationId: ORG, token: TOKEN },
      phone: "555-0100",
    });
  });

  it("returns no invitation for a malformed link but keeps a phone-shaped number", () => {
    expect(parseFamilyFragment("#t=x&o=y&n=555-0100")).toEqual({
      invitation: null,
      phone: "555-0100",
    });
    expect(parseFamilyFragment("")).toEqual({ invitation: null, phone: null });
  });

  it("drops a number that is not phone-shaped", () => {
    expect(parseFamilyFragment(`#t=${TOKEN}&o=${ORG}&n=<script>`).phone).toBeNull();
  });
});
