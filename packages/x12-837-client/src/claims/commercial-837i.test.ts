// M41 (ADR-0100): the commercial primary shape of the shared 837I builder. The Medicare shape is untouched; its goldens
// stay byte-identical in build-837i-claim.test.ts.
import { describe, expect, it } from "vitest";
import { buildStediClaimJson } from "../clearinghouse/stedi-claim-json";
import { Claim837iBuildError, type Claim837iInput, build837iClaim } from "./build-837i-claim";
import { CLAIM_INPUT } from "./claim-fixture-input";

const lines = (x12: string): string[] => x12.split("~").filter((s) => s.length > 0);

const commercial = {
  ...CLAIM_INPUT,
  subscriber: { ...CLAIM_INPUT.subscriber, mbi: "MEM-0001234" },
  payer: { name: "Synthetic Commercial Health", payerId: "SYNTH01" },
  commercial: { claimFilingIndicator: "CI", groupNumber: "GRP100" },
  claim: {
    ...CLAIM_INPUT.claim,
    lines: [
      {
        revenueCode: "0651",
        chargeCents: 150_000,
        units: 10,
        serviceDate: "2026-01-01",
        serviceThroughDate: "2026-01-10",
      },
    ],
  },
} as unknown as Claim837iInput;

const segs = (i: Claim837iInput): string[] => lines(build837iClaim(i));

describe("build837iClaim - commercial primary (M41)", () => {
  it("carries the filing indicator, group and member id, and bills a revenue code without HCPCS", () => {
    const s = segs(commercial);
    expect(s).toContain("SBR*P*18*GRP100******CI");
    expect(s).toContain("NM1*IL*1*DOE*JANE****MI*MEM-0001234");
    expect(s).toContain("NM1*PR*2*SYNTHETIC COMMERCIAL HEALTH*****PI*SYNTH01");
    expect(s).toContain("SV2*0651**1500.00*UN*10");
  });

  it("emits loop 2320 for a Medicare secondary between the attending physician and the lines", () => {
    const s = segs({
      ...commercial,
      claim: {
        ...commercial.claim,
        otherPayers: [
          {
            responsibility: "S",
            claimFilingIndicator: "MA",
            memberId: "1EG4TE5MK73",
            payerName: "Synthetic Medicare",
            payerId: "MEDI01",
          },
        ],
      },
    });
    const at = (p: string): number => s.findIndex((x) => x.startsWith(p));
    expect(s).toContain("SBR*S*18*******MA");
    expect(s).toContain("NM1*PR*2*SYNTHETIC MEDICARE*****PI*MEDI01");
    expect(at("NM1*71")).toBeLessThan(at("SBR*S"));
    expect(at("SBR*S")).toBeLessThan(at("LX*1"));
  });

  it.each(["MA", "MB", "MC", "16", "09", "10", "TV", "", "CIX"])(
    "refuses filing indicator %s",
    (claimFilingIndicator) => {
      expect(() => build837iClaim({ ...commercial, commercial: { claimFilingIndicator } })).toThrow(
        Claim837iBuildError,
      );
    },
  );

  it("refuses other payers on a Medicare claim, and a missing HCPCS on a Medicare line", () => {
    const other = {
      responsibility: "S",
      claimFilingIndicator: "MC",
      memberId: "MCD12345",
      payerName: "Synthetic Medicaid",
      payerId: "MCD01",
    };
    expect(() =>
      build837iClaim({
        ...CLAIM_INPUT,
        claim: { ...CLAIM_INPUT.claim, otherPayers: [other] },
      } as never),
    ).toThrow(Claim837iBuildError);
    expect(() =>
      build837iClaim({
        ...CLAIM_INPUT,
        claim: {
          ...CLAIM_INPUT.claim,
          lines: [{ revenueCode: "0651", chargeCents: 100, units: 1, serviceDate: "2026-01-01" }],
        },
      } as never),
    ).toThrow(Claim837iBuildError);
  });

  it("the Stedi JSON route fails closed on what it cannot carry: a group number, another payer, a line without HCPCS", () => {
    expect(() => buildStediClaimJson(commercial)).toThrow(Claim837iBuildError); // group number GRP100
    const noGroup = { ...commercial, commercial: { claimFilingIndicator: "CI" } } as Claim837iInput;
    expect(() => buildStediClaimJson(noGroup)).toThrow(Claim837iBuildError); // line without HCPCS
    const withHcpcs = {
      ...noGroup,
      claim: {
        ...noGroup.claim,
        lines: noGroup.claim.lines.map((l) => ({ ...l, hcpcs: "Q5001" })),
      },
    } as Claim837iInput;
    expect(buildStediClaimJson(withHcpcs).claimInformation.claimFilingCode).toBe("CI");
  });
});
