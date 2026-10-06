// @wardenx/billing — FY2027 rule `election_addendum_signed` (42 CFR 418.24(c); MLN Connects 2026-10-01): the
// 2026-10-01 applicability cutoff, the enforcement-discretion warn window (claim through date < 2027-01-01) and
// the blocking boundary, and every passing exception.
import { describe, expect, it } from "vitest";
import {
  type ElectionAddendumSnapshot,
  type ValidationContext,
  electionAddendumSigned,
} from "../src/rules/index";
import { passingContext } from "./_fixtures";

const NONE: ElectionAddendumSnapshot = {
  electionEffectiveDate: "2026-10-05",
  versionCount: 1,
  anyFurnished: false,
  anySigned: false,
  anyRefusalDocumented: false,
  anyExemptionDocumented: false,
  leftCareReason: null,
};

function ctx(addendum: ElectionAddendumSnapshot | undefined, serviceTo: string): ValidationContext {
  const base = passingContext();
  return {
    ...base,
    claim: { ...base.claim, serviceTo },
    ...(addendum ? { electionAddendum: addendum } : {}),
  };
}

const run = (c: ValidationContext, params = electionAddendumSigned.defaultParameters ?? {}) =>
  electionAddendumSigned.check(c, params);

describe("election_addendum_signed", () => {
  it("is a regulatory, compliance-overridable rule in the new `election` category", () => {
    expect(electionAddendumSigned.regulatoryRequired).toBe(true);
    expect(electionAddendumSigned.category).toBe("election");
    expect(electionAddendumSigned.defaultParameters).toEqual({
      applyToElectionsFrom: "2026-10-01",
      enforceFrom: "2027-01-01",
    });
  });

  it("skips when M6's addendum seam is not bound", () => {
    const r = run(ctx(undefined, "2027-02-28"));
    expect(r.passed).toBe(true);
    expect(r.annotations?.skipReason).toBe("seam_not_bound");
  });

  it("does not apply to elections effective before 2026-10-01", () => {
    expect(run(ctx({ ...NONE, electionEffectiveDate: "2026-09-30" }, "2027-02-28")).passed).toBe(
      true,
    );
  });

  it("missing addendum: WARN through 2026-12-31 (enforcement discretion), BLOCK from 2027-01-01", () => {
    const grace = run(ctx(NONE, "2026-12-31"));
    expect(grace).toMatchObject({ passed: false, severity: "warn" });
    const enforced = run(ctx(NONE, "2027-01-01"));
    expect(enforced).toMatchObject({ passed: false, severity: "error" });
  });

  it("a claim spanning the boundary is judged by its through date (blocking)", () => {
    expect(run(ctx(NONE, "2027-01-14")).severity).toBe("error");
  });

  it("passes on a signature, a documented refusal, or a documented exemption", () => {
    expect(run(ctx({ ...NONE, anyFurnished: true, anySigned: true }, "2027-02-28")).passed).toBe(
      true,
    );
    expect(
      run(ctx({ ...NONE, anyFurnished: true, anyRefusalDocumented: true }, "2027-02-28")).passed,
    ).toBe(true);
    expect(run(ctx({ ...NONE, anyExemptionDocumented: true }, "2027-02-28")).passed).toBe(true);
  });

  it("furnished but unsigned passes only once the patient has left care ((d)(4))", () => {
    expect(run(ctx({ ...NONE, anyFurnished: true }, "2027-02-28")).passed).toBe(false);
    expect(
      run(ctx({ ...NONE, anyFurnished: true, leftCareReason: "death" }, "2027-02-28")).passed,
    ).toBe(true);
  });

  it("honours tenant parameter overlays for both dates", () => {
    const r = run(ctx(NONE, "2027-01-15"), {
      applyToElectionsFrom: "2026-10-01",
      enforceFrom: "2027-02-01",
    });
    expect(r.severity).toBe("warn");
  });

  it("skips an election with no effective date", () => {
    expect(
      run(ctx({ ...NONE, electionEffectiveDate: null }, "2027-02-28")).annotations?.skipReason,
    ).toBe("not_applicable");
  });
});
