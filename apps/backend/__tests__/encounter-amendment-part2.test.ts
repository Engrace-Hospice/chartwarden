// S1 PR E2b - an amendment of a section whose ORIGINAL is 42 CFR Part 2 derived needs an author who may read Part 2 content (ADR-0114 VN-D30,
// VN-D13). A viewer without disclosure drafts without the SUD sources, so their amendment would silently shorten the current view: it is refused at
// naming and again at sign (the verdict can change between the two). Pure: a fake verdict, no database.
import { describe, expect, it, vi } from "vitest";
import { assertMayAmendPart2 } from "../src/modules/08-encounters/drafting/amendment-part2";
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

  it("refuses an author without disclosure with 422 AMENDMENT_PART2_NOT_ENTITLED and no section in the error", async () => {
    const error = await assertMayAmendPart2({
      part2Sections: ["interventions"],
      entitled: async () => false,
      unavailable,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EncounterStateError);
    expect(error).toMatchObject({ code: "AMENDMENT_PART2_NOT_ENTITLED", statusCode: 422 });
    expect(
      JSON.stringify({ message: (error as Error).message, ...(error as object) }),
    ).not.toContain("interventions");
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
