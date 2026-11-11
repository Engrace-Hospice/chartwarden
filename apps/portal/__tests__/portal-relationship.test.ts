import { describe, expect, it } from "vitest";
import { fetchSignedInName } from "../src/auth-http";
import {
  firstNameOf,
  greetingFor,
  isOwnRecord,
  relationshipLabel,
} from "../src/portal-relationship";

const at = (hour: number) => new Date(2099, 0, 1, hour, 0, 0);

describe("portal relationship helpers", () => {
  it("treats only patient_self as the patient's own record", () => {
    expect(isOwnRecord("patient_self")).toBe(true);
    for (const kind of [
      "family_caregiver",
      "dpoa_healthcare_agent",
      "personal_representative_post_death",
      "patient",
      null,
      undefined,
    ]) {
      expect(isOwnRecord(kind)).toBe(false);
    }
  });

  it("labels every backend relationship in lay language and humanizes unknown kinds", () => {
    expect(relationshipLabel("patient_self")).toBe("Patient");
    expect(relationshipLabel("family_caregiver")).toBe("Family caregiver");
    expect(relationshipLabel("dpoa_healthcare_agent")).toBe("Healthcare agent");
    expect(relationshipLabel("personal_representative_post_death")).toBe("Personal representative");
    expect(relationshipLabel("some_new_kind")).toBe("Some New Kind");
  });

  it("greets by the viewer's local time of day", () => {
    expect(greetingFor(at(6))).toBe("Good morning");
    expect(greetingFor(at(12))).toBe("Good afternoon");
    expect(greetingFor(at(17))).toBe("Good afternoon");
    expect(greetingFor(at(18))).toBe("Good evening");
    expect(greetingFor(at(23))).toBe("Good evening");
  });

  it("takes the first word of a display name, or null when there is none", () => {
    expect(firstNameOf("Pat Portal")).toBe("Pat");
    expect(firstNameOf("  Dana   Lee ")).toBe("Dana");
    expect(firstNameOf("")).toBeNull();
    expect(firstNameOf("   ")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});

describe("fetchSignedInName", () => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("returns the Better Auth session user's name", async () => {
    let url = "";
    const name = await fetchSignedInName(async (input) => {
      url = input;
      return reply(200, { user: { name: "Pat Portal" } });
    });
    expect(url).toBe("/api/auth/get-session");
    expect(name).toBe("Pat Portal");
  });

  it("is null for no session, a bad status, a nameless user, or a network failure", async () => {
    expect(await fetchSignedInName(async () => reply(200, null))).toBeNull();
    expect(await fetchSignedInName(async () => reply(401, {}))).toBeNull();
    expect(await fetchSignedInName(async () => reply(200, { user: { name: "  " } }))).toBeNull();
    expect(
      await fetchSignedInName(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
});
