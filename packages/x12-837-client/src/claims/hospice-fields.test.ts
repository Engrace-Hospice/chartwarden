import { describe, expect, it } from "vitest";
import { compareStediClaimJsonToX12 } from "../clearinghouse/stedi-claim-agreement";
import { buildStediClaimJson } from "../clearinghouse/stedi-claim-json";
import { checkStediEdits } from "../clearinghouse/stedi-edit-rules";
import { Claim837iBuildError, build837iClaim } from "./build-837i-claim";
import { CLAIM_INPUT } from "./claim-fixture-input";

const lines = (x12: string): string[] => x12.split("~").filter((s) => s.length > 0);
const line = CLAIM_INPUT.claim.lines[1];
const withClaim = (patch: object) =>
  ({ ...CLAIM_INPUT, claim: { ...CLAIM_INPUT.claim, ...patch } }) as never;
const withLine = (patch: object, claim: object = {}) =>
  withClaim({ lines: [{ ...line, ...patch }], ...claim });
const agree = (input: never): string[] =>
  compareStediClaimJsonToX12(buildStediClaimJson(input), build837iClaim(input));

describe("noncovered charges (SV207)", () => {
  it("emits nothing for a zero or absent noncovered amount", () => {
    expect(lines(build837iClaim(withLine({ noncoveredCents: 0 })))).toContain(
      "SV2*0652*HC:Q5001*800.00*UN*32",
    );
  });

  it("emits SV207 after an empty SV206 and keeps CLM02 equal to the line charges", () => {
    const input = withLine({ noncoveredCents: 12_345 });
    const segs = lines(build837iClaim(input));
    expect(segs).toContain("SV2*0652*HC:Q5001*800.00*UN*32**123.45");
    expect(segs).toContain("CLM*WXHOSP0001*800.00***81:A:3**A*Y*Y");
  });

  it("carries the amount into the Stedi JSON and the two agree", () => {
    const input = withLine({ noncoveredCents: 5_000 });
    const svc = buildStediClaimJson(input).claimInformation.serviceLines[0];
    expect(svc?.institutionalService.nonCoveredChargeAmount).toBe("50.00");
    expect(agree(input)).toEqual([]);
  });

  it("omits the JSON field when nothing is noncovered", () => {
    const svc = buildStediClaimJson(CLAIM_INPUT).claimInformation.serviceLines[0];
    expect(svc?.institutionalService).not.toHaveProperty("nonCoveredChargeAmount");
  });

  it("refuses noncovered above the line charge, negative, or fractional", () => {
    for (const noncoveredCents of [80_001, -1, 1.5]) {
      expect(() => build837iClaim(withLine({ noncoveredCents }))).toThrow(Claim837iBuildError);
    }
    expect(() => build837iClaim(withLine({ noncoveredCents: 80_000 }))).not.toThrow();
  });

  it("requires a claim-level noncovered total to equal the sum of the lines", () => {
    const lineInput = { noncoveredCents: 5_000 };
    expect(() =>
      build837iClaim(withLine(lineInput, { nonCoveredChargeCents: 5_000 })),
    ).not.toThrow();
    expect(() => build837iClaim(withLine(lineInput, { nonCoveredChargeCents: 4_999 }))).toThrow(
      "invalid 837I claim input: claim.nonCoveredChargeCents",
    );
    expect(() => build837iClaim(withClaim({ nonCoveredChargeCents: 1 }))).toThrow(
      Claim837iBuildError,
    );
  });
});

describe("occurrence spans (HI*BI)", () => {
  const spans = [
    { code: "77", fromDate: "2026-01-05", throughDate: "2026-01-09" },
    { code: "M2", fromDate: "2026-01-10", throughDate: "2026-01-10" },
  ];

  it("emits HI*BI composites with RD8 ranges", () => {
    const x12 = build837iClaim(withClaim({ occurrenceSpans: spans }));
    expect(lines(x12)).toContain("HI*BI:77:RD8:20260105-20260109*BI:M2:RD8:20260110-20260110");
    expect(checkStediEdits(x12)).toEqual([]);
  });

  it("maps spans into the Stedi JSON as an array of arrays, in agreement with the raw X12", () => {
    const input = withClaim({ occurrenceSpans: spans });
    expect(buildStediClaimJson(input).claimInformation.occurrenceSpanInformationList).toEqual([
      [
        { occurrenceSpanCode: "77", occurrenceSpanCodeDate: "20260105-20260109" },
        { occurrenceSpanCode: "M2", occurrenceSpanCodeDate: "20260110-20260110" },
      ],
    ]);
    expect(agree(input)).toEqual([]);
  });

  it("emits nothing when there are no spans", () => {
    expect(build837iClaim(CLAIM_INPUT)).not.toContain("HI*BI");
    expect(buildStediClaimJson(CLAIM_INPUT).claimInformation).not.toHaveProperty(
      "occurrenceSpanInformationList",
    );
  });

  it.each([
    [{ code: "7", fromDate: "2026-01-05", throughDate: "2026-01-09" }],
    [{ code: "77", fromDate: "2026-01-09", throughDate: "2026-01-05" }],
    [{ code: "77", fromDate: "2026-02-30", throughDate: "2026-02-30" }],
  ])("refuses a bad span %#", (span) => {
    expect(() => build837iClaim(withClaim({ occurrenceSpans: [span] }))).toThrow(
      "invalid 837I claim input: claim.occurrenceSpans",
    );
  });
});

describe("admission type (CL101) and source (CL102)", () => {
  it("takes CL101 and CL102 from the input", () => {
    const input = withClaim({ admissionTypeCode: "3", admissionSource: "4" });
    expect(lines(build837iClaim(input))).toContain("CL1*3*4*30");
    expect(buildStediClaimJson(input).claimInformation.claimCodeInformation).toMatchObject({
      admissionTypeCode: "3",
      admissionSourceCode: "4",
    });
    expect(agree(input)).toEqual([]);
  });

  it.each([
    [{ admissionTypeCode: "4" }, "claim.admissionTypeCode"],
    [{ admissionTypeCode: "" }, "claim.admissionTypeCode"],
    [{ admissionTypeCode: undefined }, "claim.admissionTypeCode"],
    [{ admissionSource: "3" }, "claim.admissionSource"],
  ])("refuses a code outside the NUBC set the repo uses %#", (patch, field) => {
    expect(() => build837iClaim(withClaim(patch))).toThrow(`invalid 837I claim input: ${field}`);
  });
});

describe("admission hour on DTP*435", () => {
  it("stays a D8 date without an hour", () => {
    expect(lines(build837iClaim(CLAIM_INPUT))).toContain("DTP*435*D8*20260101");
  });

  it("becomes a DT date-time with an hour, in both builders", () => {
    const input = withClaim({ admissionHour: "0930" });
    expect(lines(build837iClaim(input))).toContain("DTP*435*DT*202601010930");
    expect(
      buildStediClaimJson(input).claimInformation.claimDateInformation.admissionDateAndHour,
    ).toBe("202601010930");
    expect(agree(input)).toEqual([]);
  });

  it("refuses a malformed hour", () => {
    expect(() => build837iClaim(withClaim({ admissionHour: "2460" }))).toThrow(
      "invalid 837I claim input: claim.admissionHour",
    );
  });
});

describe("service line date ranges (DTP*472)", () => {
  it("uses D8 when through equals from or is absent", () => {
    for (const patch of [{}, { serviceThroughDate: "2026-01-02" }]) {
      expect(lines(build837iClaim(withLine(patch)))).toContain("DTP*472*D8*20260102");
    }
  });

  it("uses RD8 when through differs from from, in both builders", () => {
    const input = withLine({ serviceThroughDate: "2026-01-09" });
    expect(lines(build837iClaim(input))).toContain("DTP*472*RD8*20260102-20260109");
    expect(buildStediClaimJson(input).claimInformation.serviceLines[0]?.serviceDate).toBe(
      "20260102-20260109",
    );
    expect(agree(input)).toEqual([]);
  });

  it.each([
    ["through before from", { serviceThroughDate: "2026-01-01" }],
    ["through after the statement window", { serviceThroughDate: "2026-02-01" }],
    [
      "from before the statement window",
      { serviceDate: "2025-12-31", serviceThroughDate: "2026-01-02" },
    ],
  ])("refuses %s", (_n, patch) => {
    expect(() => build837iClaim(withLine(patch))).toThrow("invalid 837I claim input: claim.lines");
  });
});

describe("certifying physician", () => {
  it("has no 837I loop, so no NM1*DN/72/73 is emitted", () => {
    const segs = lines(build837iClaim(CLAIM_INPUT)).filter((s) => s.startsWith("NM1*"));
    expect(segs.map((s) => s.split("*")[1])).toEqual(["41", "40", "85", "IL", "PR", "71"]);
  });
});

describe("compareStediClaimJsonToX12 — guards the new fields", () => {
  const input = withLine(
    { noncoveredCents: 5_000, serviceThroughDate: "2026-01-09" },
    {
      admissionTypeCode: "3",
      occurrenceSpans: [{ code: "77", fromDate: "2026-01-05", throughDate: "2026-01-09" }],
    },
  );
  const raw = build837iClaim(input);
  const tampered = (fn: (c: Record<string, any>) => void): string[] => {
    const json = structuredClone(buildStediClaimJson(input));
    fn(json.claimInformation as unknown as Record<string, any>);
    return compareStediClaimJsonToX12(json, raw);
  };

  type Tamper = (c: Record<string, any>) => void;
  const svc = (c: Record<string, any>) => c.serviceLines[0];
  const cases: [string, Tamper][] = [
    [
      "claim.admissionTypeCode",
      (c) => {
        c.claimCodeInformation.admissionTypeCode = "1";
      },
    ],
    [
      "claim.occurrenceSpans",
      (c) => {
        c.occurrenceSpanInformationList = undefined;
      },
    ],
    [
      "claim.lines",
      (c) => {
        svc(c).institutionalService.nonCoveredChargeAmount = undefined;
      },
    ],
    [
      "claim.lines",
      (c) => {
        svc(c).serviceDate = "20260102";
      },
    ],
  ];
  it.each(cases)("flags a JSON that drifts on %s", (field, fn) => {
    expect(tampered(fn)).toContain(field);
  });
});
