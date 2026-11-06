// apps/backend/__tests__/bereavement-care-goals.test.ts — ADR-0109: a contact's 1-3 care goals are sealed with the tenant DEK,
// redacted under the D10 volunteer scope, and refused (503) while no cipher is bound.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBereavementCipher } from "../src/modules/16-bereavement/bereavement-crypto";
import {
  CARE_GOALS_MAX,
  CARE_GOAL_MAX_CHARS,
  decodeCareGoals,
  encodeCareGoals,
  normalizeCareGoals,
} from "../src/modules/16-bereavement/care-goals";
import { BereavementStateError } from "../src/modules/16-bereavement/lifecycle/index";
import {
  PORTAL_SELF_DISCLOSURE,
  resolveBereavementDisclosure,
} from "../src/modules/16-bereavement/routes/disclosure";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const key = randomBytes(32);
const cipher = createBereavementCipher({
  dekForOrg: async () => ({ version: "3", key }),
  dekForOrgVersion: async () => ({ version: "3", key }),
});

describe("normalizeCareGoals", () => {
  it("trims each goal and keeps at most three", () => {
    expect(normalizeCareGoals(["  Sleep through the night ", "Call my sister"])).toEqual([
      "Sleep through the night",
      "Call my sister",
    ]);
    expect(normalizeCareGoals([])).toEqual([]);
  });

  it.each([
    ["a fourth goal", ["a", "b", "c", "d"]],
    ["a blank goal", ["a", "   "]],
    ["a goal over the limit", ["x".repeat(CARE_GOAL_MAX_CHARS + 1)]],
  ])("refuses %s with 422 CARE_GOALS_INVALID", (_name, goals) => {
    try {
      normalizeCareGoals(goals);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BereavementStateError);
      expect((error as BereavementStateError).code).toBe("CARE_GOALS_INVALID");
      expect((error as BereavementStateError).statusCode).toBe(422);
    }
  });

  it("the limit constants match the wire schema", () => {
    expect(CARE_GOALS_MAX).toBe(3);
    expect(CARE_GOAL_MAX_CHARS).toBe(280);
  });
});

describe("encode / decode", () => {
  it("round-trips through the tenant DEK and never stores a goal in the clear", async () => {
    const goals = ["Get back to the garden", "Join the Thursday group"];
    const blob = await cipher.encrypt(ORG, "bereaved_contact.care_goals", encodeCareGoals(goals));
    expect(blob).not.toContain("garden");
    expect(decodeCareGoals(await cipher.decrypt(ORG, "bereaved_contact.care_goals", blob))).toEqual(
      goals,
    );
  });

  it("will not open a goals blob as another column (AAD binding)", async () => {
    const blob = await cipher.encrypt(ORG, "bereaved_contact.care_goals", encodeCareGoals(["x"]));
    await expect(cipher.decrypt(ORG, "bereaved_contact.phone", blob)).rejects.toThrow();
  });

  it("decodes anything that is not a short array of strings as null (never a partial list)", () => {
    expect(decodeCareGoals("not json")).toBeNull();
    expect(decodeCareGoals('{"a":1}')).toBeNull();
    expect(decodeCareGoals('["a", 2]')).toBeNull();
    expect(decodeCareGoals('["a","b","c","d"]')).toBeNull();
    expect(decodeCareGoals("[]")).toEqual([]);
  });
});

describe("D10 disclosure — care goals", () => {
  const actor = (roles: string[], sessionClass = "staff") => ({
    organizationId: ORG,
    userId: "u",
    membershipId: "m",
    roles,
    sessionClass,
    locationIds: [],
    portalAccountId: null,
  });
  const cleared = { part2ReleaseActive: async () => true };

  it("a counselor reads them; a volunteer and a portal session do not", async () => {
    expect(
      (await resolveBereavementDisclosure(actor(["bereavement_counselor"]), PATIENT, cleared))
        .careGoalsAllowed,
    ).toBe(true);
    expect(
      (await resolveBereavementDisclosure(actor(["bereavement_volunteer"]), PATIENT, cleared))
        .careGoalsAllowed,
    ).toBe(false);
    expect(
      (
        await resolveBereavementDisclosure(
          actor(["bereavement_counselor"], "bereaved_portal"),
          PATIENT,
          cleared,
        )
      ).careGoalsAllowed,
    ).toBe(false);
    expect(PORTAL_SELF_DISCLOSURE.careGoalsAllowed).toBe(false);
  });
});
