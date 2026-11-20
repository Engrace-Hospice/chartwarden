// WF09 — the scheduled purposes whose reason is not a judgement suggest it; every other purpose suggests nothing.
import { describe, expect, it } from "vitest";
import { suggestedReasonCode } from "./encounters-api";

const OFFERED = [
  { code: "nv.reason.routine" },
  { code: "nv.reason.psychosocial" },
  { code: "nv.reason.spiritual_assessment" },
];

describe("suggestedReasonCode", () => {
  it("maps the purposes that name their own reason", () => {
    expect(suggestedReasonCode("routine_visit", OFFERED)).toBe("nv.reason.routine");
    expect(suggestedReasonCode("aide_poc", OFFERED)).toBe("nv.reason.routine");
    expect(suggestedReasonCode("msw_assessment", OFFERED)).toBe("nv.reason.psychosocial");
    expect(suggestedReasonCode("chaplain_assessment", OFFERED)).toBe(
      "nv.reason.spiritual_assessment",
    );
  });

  it("suggests nothing for a purpose that only names the kind of visit", () => {
    for (const purpose of [
      "prn",
      "f2f",
      "recert",
      "admission_visit",
      "loc_change",
      "sfv",
      "huv1",
    ]) {
      expect(suggestedReasonCode(purpose, OFFERED), purpose).toBeNull();
    }
  });

  it("suggests nothing the visit's menu does not offer, or for a purpose it has never heard of", () => {
    expect(suggestedReasonCode("routine_visit", [{ code: "nv.reason.pain" }])).toBeNull();
    expect(suggestedReasonCode("toString", OFFERED)).toBeNull();
    expect(suggestedReasonCode("a_future_purpose", OFFERED)).toBeNull();
  });
});
