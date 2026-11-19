// S1 PR E2b - an amendment of a section whose ORIGINAL is 42 CFR Part 2 derived needs an author who may read Part 2 content (ADR-0114 VN-D30,
// VN-D13). A viewer without disclosure drafts without the SUD sources, so their amendment would silently shorten the current view: it is refused at
// naming and again at sign (the verdict can change between the two). Pure: a fake verdict, no database.
import { describe, expect, it, vi } from "vitest";
import {
  assertMayAmendPart2,
  part2SectionsAmong,
} from "../src/modules/08-encounters/drafting/amendment-part2";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";

const unavailable = (cause: unknown) =>
  new EncounterStateError(
    "COMPLIANCE_GATE_UNAVAILABLE",
    "the check could not be decided",
    undefined,
    {
      cause,
    },
  );

describe("assertMayAmendPart2", () => {
  it("asks nobody when no named section is Part 2 derived", async () => {
    const entitled = vi.fn(async () => false);
    await expect(
      assertMayAmendPart2({ part2Sections: [], entitled, unavailable }),
    ).resolves.toBeUndefined();
    expect(entitled).not.toHaveBeenCalled();
  });

  it("passes an entitled author, asking the verdict once however many sections are Part 2", async () => {
    const entitled = vi.fn(async () => true);
    await assertMayAmendPart2({ part2Sections: ["interventions", "plan"], entitled, unavailable });
    expect(entitled).toHaveBeenCalledTimes(1);
  });

  it("refuses an author without disclosure with 422 AMENDMENT_PART2_NOT_ENTITLED, naming no section and saying nothing of Part 2", async () => {
    const error = await assertMayAmendPart2({
      part2Sections: ["interventions"],
      entitled: async () => false,
      unavailable,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EncounterStateError);
    expect(error).toMatchObject({ code: "AMENDMENT_PART2_NOT_ENTITLED", statusCode: 422 });
    const body = JSON.stringify({ message: (error as Error).message, ...(error as object) });
    expect(body).not.toContain("interventions");
    // The refusal is the one fact a signer without disclosure must not learn from its wording (C6); the code is the client's key.
    expect((error as Error).message).not.toMatch(/part\s*2|42\s*cfr|protected/i);
    expect((error as Error).message).toBe("a named section cannot be amended by this signer");
  });

  it("a verdict that cannot be decided is the caller's 503, never a denial and never a pass, and the cause stays on the error", async () => {
    const outage = new Error("synthetic M39 outage");
    const error = await assertMayAmendPart2({
      part2Sections: ["plan"],
      entitled: async () => {
        throw outage;
      },
      unavailable,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
    expect((error as { cause?: unknown }).cause).toBe(outage);
    expect((error as Error).message).not.toContain("synthetic");
  });
});

describe("part2SectionsAmong: the LATEST version of a section decides (B3)", () => {
  const original = (sectionId: string, part2Derived: boolean) => ({ sectionId, part2Derived });
  const originals = [
    original("chief_concern", false),
    original("interventions", true),
    original("plan", false),
  ];

  it("a section whose original is Part 2 derived is guarded while no amendment has replaced it", () => {
    expect(part2SectionsAmong(originals, [], ["interventions", "plan"])).toEqual(["interventions"]);
  });

  it("a section whose original was NOT Part 2 but whose latest signed amendment is, is guarded (the entitled reader's current view holds the SUD text)", () => {
    expect(
      part2SectionsAmong(originals, [{ sectionId: "plan", part2Derived: true }], ["plan"]),
    ).toEqual(["plan"]);
  });

  it("a Part 2 original replaced by a later amendment that holds none is no longer guarded: the latest version, oldest-first, wins", () => {
    const amendments = [
      { sectionId: "interventions", part2Derived: true },
      { sectionId: "interventions", part2Derived: false },
    ];
    expect(part2SectionsAmong(originals, amendments, ["interventions"])).toEqual([]);
    expect(part2SectionsAmong(originals, [...amendments].reverse(), ["interventions"])).toEqual([
      "interventions",
    ]);
  });

  it("only the named sections are reported, in note order", () => {
    expect(
      part2SectionsAmong(
        originals,
        [{ sectionId: "plan", part2Derived: true }],
        ["plan", "interventions"],
      ),
    ).toEqual(["interventions", "plan"]);
    expect(part2SectionsAmong(originals, [], [])).toEqual([]);
  });
});
