// @wardenx/assessments — LPN cosignature workflow (§7.4, §2.3, §6) — M9-T03.
import { describe, expect, it } from "vitest";
import {
  type CosignAttest,
  LPN_COSIGN_SCALES,
  assertCosignSatisfied,
  cosignRequiredFor,
  cosignSatisfied,
  planCosignAttest,
} from "../src/cosign";

describe("§2.3 cosignRequiredFor", () => {
  it("requires cosign for an LPN capture of PPS / KPS / FAST", () => {
    for (const scale of LPN_COSIGN_SCALES) {
      expect(cosignRequiredFor("LPN", scale)).toBe(true);
      expect(cosignRequiredFor("lpn", scale)).toBe(true); // case-insensitive
    }
  });

  it("does not require cosign for an LPN capture outside {PPS,KPS,FAST}", () => {
    expect(cosignRequiredFor("lpn", "esas_r")).toBe(false);
    expect(cosignRequiredFor("lpn", "painad")).toBe(false);
  });

  it("never requires cosign for an RN / MD / NP capture (§7.1)", () => {
    expect(cosignRequiredFor("rn", "pps")).toBe(false);
    expect(cosignRequiredFor("md", "fast")).toBe(false);
    expect(cosignRequiredFor("np", "pps")).toBe(false);
  });
});

describe("§7.4 cosign read gate", () => {
  it("a non-required row is always satisfied", () => {
    expect(cosignSatisfied(false, false)).toBe(true);
    expect(() => assertCosignSatisfied(false, false)).not.toThrow();
  });

  it("a required-but-uncosigned row fails the gate (412 COSIGN_REQUIRED)", () => {
    expect(cosignSatisfied(true, false)).toBe(false);
    expect(() => assertCosignSatisfied(true, false)).toThrowError(
      expect.objectContaining({ code: "COSIGN_REQUIRED", statusCode: 412 }),
    );
  });

  it("a required-and-cosigned row passes the gate", () => {
    expect(cosignSatisfied(true, true)).toBe(true);
    expect(() => assertCosignSatisfied(true, true)).not.toThrow();
  });
});

describe("§7.4 / §6 planCosignAttest", () => {
  const base: CosignAttest = {
    clinicalAssessmentId: "a1",
    cosignRequired: true,
    alreadyCosigned: false,
    cosignerDiscipline: "RN",
    cosignerIsRecorder: false,
  };

  it("a supervising RN attests a required, un-cosigned row → emits cosigned", () => {
    expect(planCosignAttest(base)).toEqual({ clinicalAssessmentId: "a1", emitsCosigned: true });
    expect(
      planCosignAttest({ ...base, cosignerDiscipline: "clinical_supervisor" }).emitsCosigned,
    ).toBe(true);
  });

  it("refuses to cosign a row that does not require it (422 COSIGN_NOT_REQUIRED)", () => {
    expect(() => planCosignAttest({ ...base, cosignRequired: false })).toThrowError(
      expect.objectContaining({ code: "COSIGN_NOT_REQUIRED", statusCode: 422 }),
    );
  });

  it("refuses a double cosign (409 ALREADY_COSIGNED)", () => {
    expect(() => planCosignAttest({ ...base, alreadyCosigned: true })).toThrowError(
      expect.objectContaining({ code: "ALREADY_COSIGNED", statusCode: 409 }),
    );
  });

  it("refuses an ineligible discipline (403 NOT_COSIGN_ELIGIBLE)", () => {
    expect(() => planCosignAttest({ ...base, cosignerDiscipline: "lpn" })).toThrowError(
      expect.objectContaining({ code: "NOT_COSIGN_ELIGIBLE", statusCode: 403 }),
    );
  });

  it("refuses a self-cosign by the original recorder (403 NOT_COSIGN_ELIGIBLE)", () => {
    expect(() => planCosignAttest({ ...base, cosignerIsRecorder: true })).toThrowError(
      expect.objectContaining({ code: "NOT_COSIGN_ELIGIBLE", statusCode: 403 }),
    );
  });
});
