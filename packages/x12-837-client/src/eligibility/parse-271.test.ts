import { describe, expect, it } from "vitest";
import { type Hets271Scenario, type SyntheticHospicePeriod, synthetic271 } from "./fixtures";
import { deriveHospiceHistory } from "./hospice-history";
import {
  HETS_271_MAX_CHARS,
  HETS_271_MAX_HOSPICE_RECORDS,
  MbiLeakError,
  assertNoMbi,
  parse271,
} from "./parse-271";
import { X12FormatError } from "./x12-envelope";

const MBI = "1EG4TE5MK73";
const ctx = {
  traceNumber: "chk-0001",
  submitterId: "A123456",
  providerNpi: "1234567893",
  mbi: MBI,
  lastName: "LNAME",
  firstName: "FNAME",
};
const AS_OF = { asOfServiceDate: "2026-10-06" };

/**
 * The Companion Guide §7.16 example ("Hospice Care with one NOE and three Hospice episodes"), verbatim
 * apart from the explanatory parentheses, inside the Appendix B envelope (which echoes the MBI).
 */
const CG_716_EXAMPLE = [
  "ISA*00*          *00*          *ZZ*CMS            *ZZ*SUBMITTERID    *210315*0734*^*00501*111111111*0*P*|",
  "GS*HB*CMS*SUBMITTERID*20210315*07340000*1*X*005010X279A1",
  "ST*271*0001*005010X279A1",
  "BHT*0022*11*TRANSA*20210315*07342355",
  "HL*1**20*1",
  "NM1*PR*2*CMS*****PI*CMS",
  "HL*2*1*21*1",
  "NM1*1P*2*IRNAME*****XX*1234567893",
  "HL*3*2*22*0",
  "TRN*2*TRACKNUM*ABCDEFGHIJ",
  `NM1*IL*1*LNAME*FNAME*M***MI*${MBI}`,
  "N3*ADDRESSLINE1*ADDRESSLINE2",
  "N4*CITY*ST*ZIPCODE",
  "DMG*D8*19400401*F",
  "EB*1**30^10^42^45^48^49^69^76^83^A5^A7^AG^BT^BU^BV^RN*MA",
  "DTP*291*D8*20050401",
  "MSG*0 – Beneficiary insured due to age OASI",
  "EB*1**80*MA",
  "DTP*771*D8*20210315",
  "EB*X**45*MA**26",
  "DTP*292*D8*20190701",
  "MSG*Revocation Code – 0",
  "LS*2120",
  "NM1*1P*2******XX*1234567893",
  "LE*2120",
  "EB*X**45*MA**26",
  "HSD*DY*60",
  "DTP*292*RD8*20180515-20180713",
  "DTP*435*RD8*20180515-20180713",
  "MSG*Revocation Code – 1",
  "LS*2120",
  "NM1*1P*2******XX*1649726464",
  "LE*2120",
  "EB*X**45*MA**26",
  "HSD*DY*90",
  "DTP*292*RD8*20180214-20180514",
  "DTP*435*RD8*20180214-20180514",
  "MSG*Revocation Code – 1",
  "LS*2120",
  "NM1*1P*2******XX*1649726464",
  "LE*2120",
  "EB*X**45*MA**26",
  "HSD*DY*90",
  "DTP*292*RD8*20171116-20180213",
  "DTP*435*RD8*20171116-20180213",
  "MSG*Revocation Code – 1",
  "LS*2120",
  "NM1*1P*2******XX*1649726464",
  "LE*2120",
  "SE*48*0001",
  "GE*1*1",
  "IEA*1*111111111",
]
  .map((s) => `${s}~`)
  .join("\n");

describe("parse271 — Companion Guide §7.16 example", () => {
  const parsed = parse271(CG_716_EXAMPLE, { asOfServiceDate: "2021-03-15" });

  it("reads Part A active and the trace number", () => {
    expect(parsed.transaction).toBe("271");
    expect(parsed.outcome).toBe("active_part_a");
    expect(parsed.traceNumber).toBe("TRACKNUM");
    expect(parsed.partA.entitlements).toEqual([{ start: "2005-04-01", end: null }]);
  });

  it("reads one NOE and three billed periods with NPI, days used, revocation and DOEBA/DOLBA", () => {
    expect(parsed.hospiceRecords).toEqual([
      {
        kind: "election",
        startDate: "2019-07-01",
        endDate: null,
        daysUsed: null,
        billingActivityStart: null,
        billingActivityEnd: null,
        revocationCode: "0",
        hospiceNpi: "1234567893",
      },
      {
        kind: "benefit_period",
        startDate: "2018-05-15",
        endDate: "2018-07-13",
        daysUsed: 60,
        billingActivityStart: "2018-05-15",
        billingActivityEnd: "2018-07-13",
        revocationCode: "1",
        hospiceNpi: "1649726464",
      },
      expect.objectContaining({ startDate: "2018-02-14", endDate: "2018-05-14", daysUsed: 90 }),
      expect.objectContaining({ startDate: "2017-11-16", endDate: "2018-02-13", daysUsed: 90 }),
    ]);
  });

  it("never carries the echoed MBI, name, address or DOB", () => {
    const text = JSON.stringify(parsed);
    expect(text).not.toContain(MBI);
    expect(text).not.toContain("LNAME");
    expect(text).not.toContain("ADDRESSLINE1");
    expect(text).not.toContain("19400401");
    expect(() => assertNoMbi(parsed, MBI)).not.toThrow();
  });

  it("derives an open election (NOE code 0 after three revoked periods) — no next number", () => {
    const history = deriveHospiceHistory(parsed.hospiceRecords, { asOfServiceDate: "2021-03-15" });
    expect(history.electionOpen).toBe(true);
    expect(history.nextPeriodNumber).toBeNull();
    expect(history.nextPeriodBasis).toBe("election_open");
    expect(
      history.periods.filter((p) => p.kind === "benefit_period").map((p) => p.periodNumber),
    ).toEqual([1, 2, 3]);
    expect(history.periods[2]).toMatchObject({
      startDate: "2018-05-15",
      revocationOrDischargeDate: "2018-07-13",
    });
  });
});

describe("parse271 — synthetic scenarios", () => {
  const run = (scenario: Hets271Scenario) => parse271(synthetic271(scenario, ctx), AS_OF);

  it("active Part A with revoked history at other hospices → next period 4", () => {
    const parsed = run("active_with_history");
    expect(parsed.outcome).toBe("active_part_a");
    const history = deriveHospiceHistory(parsed.hospiceRecords, AS_OF);
    expect(history.electionOpen).toBe(false);
    expect(history.billedPeriodCount).toBe(3);
    expect(history.nextPeriodNumber).toBe(4);
    expect(history.nextPeriodBasis).toBe("computed");
    expect(history.periods.at(-1)).toMatchObject({
      kind: "benefit_period",
      periodNumber: 3,
      hospiceNpi: "1234567893",
      revocationCode: "2",
      revocationOrDischargeDate: "2023-08-20",
    });
  });

  it("open election at another hospice → electionOpen, next number null", () => {
    const history = deriveHospiceHistory(run("open_election").hospiceRecords, AS_OF);
    expect(history.electionOpen).toBe(true);
    expect(history.nextPeriodNumber).toBeNull();
    expect(history.nextPeriodBasis).toBe("election_open");
  });

  it("no hospice history → first period", () => {
    const parsed = run("no_hospice_history");
    expect(parsed.hospiceRecords).toEqual([]);
    const history = deriveHospiceHistory(parsed.hospiceRecords, AS_OF);
    expect(history).toMatchObject({ electionOpen: false, nextPeriodNumber: 1 });
  });

  it("EB*6 MA → inactive_part_a", () => {
    expect(run("inactive_part_a").outcome).toBe("inactive_part_a");
  });

  it("2100C AAA 72 (MBI not matched) → mbi_invalid", () => {
    const parsed = run("mbi_not_found");
    expect(parsed.outcome).toBe("mbi_invalid");
    expect(parsed.rejections).toEqual([{ loop: "2100C", code: "72", followUp: "C" }]);
  });

  it("2100A AAA 42 (system unable to respond) → hets_error", () => {
    const parsed = run("system_unavailable");
    expect(parsed.outcome).toBe("hets_error");
    expect(parsed.rejections[0]).toMatchObject({ loop: "2100A", code: "42" });
  });

  it("a 999 rejection of our 270 → hets_error", () => {
    const parsed = run("rejected_999");
    expect(parsed.transaction).toBe("999");
    expect(parsed.outcome).toBe("hets_error");
  });

  it("every scenario's parse result is MBI-free", () => {
    for (const scenario of [
      "active_with_history",
      "open_election",
      "no_hospice_history",
      "inactive_part_a",
      "mbi_not_found",
      "system_unavailable",
      "rejected_999",
    ] as const) {
      expect(() => assertNoMbi(run(scenario), MBI)).not.toThrow();
    }
  });

  it("a Part A entitlement that ended before the as-of date → inactive_part_a", () => {
    const x12 = synthetic271("no_hospice_history", ctx).replace(
      "DTP*291*D8*20050401~\nMSG",
      "DTP*291*RD8*20050401-20251231~\nMSG",
    );
    expect(parse271(x12, AS_OF).outcome).toBe("inactive_part_a");
  });

  it("detects delimiters from the ISA header (non-default separators)", () => {
    const x12 = synthetic271("no_hospice_history", ctx).replaceAll("*", "!").replaceAll("~", "'");
    expect(parse271(x12, AS_OF).outcome).toBe("active_part_a");
  });
});

describe("assertNoMbi", () => {
  it("throws on the given MBI or any MBI-shaped token, without echoing it", () => {
    expect(() => assertNoMbi({ note: `x ${MBI} y` })).toThrow(MbiLeakError);
    expect(() => assertNoMbi({ a: "1AA0AA0AA00" }, "9ZZ9")).toThrow(MbiLeakError);
    try {
      assertNoMbi({ note: MBI });
    } catch (err) {
      expect((err as Error).message).not.toContain(MBI);
    }
    expect(() =>
      assertNoMbi({ npi: "1234567893", id: "0b3c8b6e-1d2f-4e5a-9b7c-1a2b3c4d5e6f" }),
    ).not.toThrow();
  });
});

describe("parse271 — bounded against a malformed / hostile answer", () => {
  it("keeps at most HETS_271_MAX_HOSPICE_RECORDS hospice records; the history then reads as truncated", () => {
    const flood: SyntheticHospicePeriod[] = Array.from({ length: 2_000 }, (_, i) => ({
      kind: "noe",
      // Distinct days from 1990-01-01, so the dedupe-by-start keeps every one.
      start: new Date(Date.UTC(1990, 0, 1 + i)).toISOString().slice(0, 10).replaceAll("-", ""),
      revocation: "1",
      npi: "1649726464",
    }));
    const t0 = performance.now();
    const parsed = parse271(synthetic271("active_with_history", ctx, flood), {
      asOfServiceDate: "2026-10-06",
    });
    expect(parsed.hospiceRecords).toHaveLength(HETS_271_MAX_HOSPICE_RECORDS);
    const history = deriveHospiceHistory(parsed.hospiceRecords, { asOfServiceDate: "2026-10-06" });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(history.truncated).toBe(true);
  });

  it("refuses a payload over the size limit with a content-free X12FormatError", () => {
    const raw = `ISA*${"x".repeat(HETS_271_MAX_CHARS)}`;
    expect(() => parse271(raw, { asOfServiceDate: "2026-10-06" })).toThrow(X12FormatError);
  });
});
