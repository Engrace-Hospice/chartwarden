// One outcome per FILE from the per-set outcomes of a multi-set 835 interchange. No DB: pure.
import { describe, expect, it } from "vitest";
import type { ReceiveAdviceResult } from "../service";
import { summarizeSetOutcomes } from "../set-outcomes";

const queued = (adviceId: string): ReceiveAdviceResult => ({ outcome: "queued", adviceId });
const duplicate = (existingAdviceId: string): ReceiveAdviceResult => ({
  outcome: "duplicate",
  existingAdviceId,
});
const legacyHeld = (adviceId: string): ReceiveAdviceResult => ({
  outcome: "held_duplicate",
  adviceId,
  existingAdviceId: "existing",
  reason: "LEGACY_IDENTITY_AMBIGUOUS",
});
const stageHeld = (stageId: string): ReceiveAdviceResult => ({
  outcome: "review_required",
  stageId,
  reason: "CLAIMMD_ERA_STAGE_MATCH",
});

describe("summarizeSetOutcomes", () => {
  it("a single set is its own outcome, untouched", () => {
    expect(summarizeSetOutcomes([queued("a")])).toEqual(queued("a"));
    expect(summarizeSetOutcomes([duplicate("d")])).toEqual(duplicate("d"));
    expect(summarizeSetOutcomes([legacyHeld("h")])).toEqual(legacyHeld("h"));
    expect(summarizeSetOutcomes([stageHeld("s")])).toEqual(stageHeld("s"));
  });

  it("prefers a queued set, then a duplicate, as the primary outcome", () => {
    expect(summarizeSetOutcomes([duplicate("d"), queued("q")])).toEqual(queued("q"));
    expect(summarizeSetOutcomes([queued("q1"), queued("q2")])).toEqual(queued("q1"));
    expect(summarizeSetOutcomes([duplicate("d1"), duplicate("d2")])).toEqual(duplicate("d1"));
  });

  it("a held set beside a queued set rides along as heldSets", () => {
    expect(summarizeSetOutcomes([legacyHeld("h"), queued("q")])).toEqual({
      ...queued("q"),
      heldSets: ["LEGACY_IDENTITY_AMBIGUOUS"],
    });
  });

  it("a held set FIRST and a duplicate second reports the duplicate with the held set (not the held set alone)", () => {
    expect(summarizeSetOutcomes([legacyHeld("h"), duplicate("d")])).toEqual({
      ...duplicate("d"),
      heldSets: ["LEGACY_IDENTITY_AMBIGUOUS"],
    });
  });

  it("several held sets with nothing queued report every held reason, not just the first", () => {
    expect(summarizeSetOutcomes([legacyHeld("h"), stageHeld("s")])).toEqual({
      ...legacyHeld("h"),
      heldSets: ["LEGACY_IDENTITY_AMBIGUOUS", "CLAIMMD_ERA_STAGE_MATCH"],
    });
    expect(summarizeSetOutcomes([stageHeld("s1"), stageHeld("s2")])).toEqual({
      ...stageHeld("s1"),
      heldSets: ["CLAIMMD_ERA_STAGE_MATCH", "CLAIMMD_ERA_STAGE_MATCH"],
    });
  });

  it("lists every held set beside a queued one, in file order", () => {
    expect(summarizeSetOutcomes([stageHeld("s"), queued("q"), legacyHeld("h")])).toEqual({
      ...queued("q"),
      heldSets: ["CLAIMMD_ERA_STAGE_MATCH", "LEGACY_IDENTITY_AMBIGUOUS"],
    });
  });

  it("a file with no set outcome is an error, not an undefined outcome", () => {
    expect(() => summarizeSetOutcomes([])).toThrow(/no transaction-set outcome/);
  });
});
