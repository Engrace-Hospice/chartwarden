import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { X12FormatError } from "../eligibility/x12-envelope";
import { checkStediEdits } from "./stedi-edit-rules";

// Synthetic payloads the Stedi sandbox accepted past its edit engine (2026-10-09). "Passed edits" only.
const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", `stedi-${name}.x12`), "utf8");

const rules = (raw: string): string[] => checkStediEdits(raw).map((f) => f.rule);

describe("checkStediEdits: payloads the sandbox accepted", () => {
  it.each(["claim", "NOE_81A", "NOTR_81B", "adjust_817", "cancel_818"])(
    "%s has no findings",
    (n) => {
      expect(checkStediEdits(fixture(n))).toEqual([]);
    },
  );
});

describe("checkStediEdits: each sandbox rejection is reproduced", () => {
  const claim = fixture("claim");
  const swap = (raw: string, from: string, to: string): string => {
    if (!raw.includes(from)) throw new Error(`fixture lacks ${from}`);
    return raw.replace(from, to);
  };

  it("frequency 1 with patient status 30", () => {
    expect(rules(swap(claim, "81:A:3", "81:A:1"))).toEqual(["frequency-status-conflict"]);
  });

  it("CLM02 that is not the sum of the lines", () => {
    expect(rules(swap(claim, "CLM*WXHOSP0001*1500.00", "CLM*WXHOSP0001*1400.00"))).toEqual([
      "total-matches-lines",
    ]);
  });

  it("sums cents exactly, not floats", () => {
    const raw = swap(swap(claim, "*200.00*UN*1", "*0.10*UN*1"), "*800.00*UN*32", "*0.20*UN*32")
      .replace("*500.00*UN*1", "*0.30*UN*1")
      .replace("CLM*WXHOSP0001*1500.00", "CLM*WXHOSP0001*0.60");
    expect(checkStediEdits(raw)).toEqual([]);
  });

  it("a blank admission source", () => {
    expect(rules(swap(claim, "CL1*1*1*30", "CL1*1**30"))).toEqual(["admission-source-required"]);
  });

  it("a chargeable notice with no charge", () => {
    const noe = fixture("NOE_81A");
    expect(rules(swap(noe, "*RP~", "*CH~"))).toEqual(["chargeable-needs-charge"]);
  });

  it("a discharge hour sent as a date", () => {
    const notr = fixture("NOTR_81B");
    expect(rules(swap(notr, "DTP*472", "DTP*096*D8*20260131~\nDTP*472"))).toEqual([
      "discharge-hour-format",
    ]);
  });

  it("accepts the discharge hour in time form", () => {
    const notr = fixture("NOTR_81B");
    expect(checkStediEdits(swap(notr, "DTP*472", "DTP*096*TM*1430~\nDTP*472"))).toEqual([]);
  });

  it("frequency 7 without REF*F8", () => {
    expect(rules(swap(fixture("adjust_817"), "REF*F8*12345678901234~\n", ""))).toEqual([
      "payer-claim-number-required",
    ]);
  });

  it("REF*F8 after the attending provider instead of right after CL1", () => {
    const raw = swap(
      swap(fixture("adjust_817"), "REF*F8*12345678901234~\n", ""),
      "NM1*71*1*SMITH*ALAN****XX*1245319599~",
      "NM1*71*1*SMITH*ALAN****XX*1245319599~\nREF*F8*12345678901234~",
    );
    expect(rules(raw)).toEqual(["payer-claim-number-required"]);
  });

  it("a wrong implementation guide version", () => {
    expect(rules(claim.replace("ST*837*0101*005010X223A2", "ST*837*0101*005010X223A1"))).toEqual([
      "implementation-guide-version",
    ]);
  });
});

describe("checkStediEdits: fails closed", () => {
  const claim = fixture("claim");

  it.each([
    ["a thousands separator", "CLM*WXHOSP0001*1500.00", "CLM*WXHOSP0001*1,500.00"],
    ["a negative total", "CLM*WXHOSP0001*1500.00", "CLM*WXHOSP0001*-5.00"],
    ["an empty total", "CLM*WXHOSP0001*1500.00", "CLM*WXHOSP0001*"],
    ["three decimals", "CLM*WXHOSP0001*1500.00", "CLM*WXHOSP0001*1500.005"],
    ["a line with no charge", "SV2*0651*HC:Q5001*200.00", "SV2*0651*HC:Q5001*"],
  ])("flags %s instead of passing", (_n, from, to) => {
    expect(rules(claim.replace(from, to))).toEqual(["amount-unreadable"]);
  });

  it("refuses an interchange with no claim", () => {
    const noClaim = claim
      .split("\n")
      .filter((l) => !/^(CLM|SV2|LX|DTP\*472)/.test(l))
      .join("\n");
    expect(() => checkStediEdits(noClaim)).toThrow(X12FormatError);
  });

  it("checks each claim against its own lines", () => {
    const one = (id: string, amount: string): string =>
      `CLM*${id}*${amount}***81:A:3**A*Y*Y~\nCL1*1*1*30~\nSV2*0651*HC:Q5001*${amount}*UN*1~`;
    const two = (a: string, b: string): string =>
      claim
        .replace(/CLM\*[\s\S]*?(?=SE\*)/, `${one("A1", a)}\n${one("B2", b)}\n`)
        .replace("SE*35*", "SE*10*");
    expect(checkStediEdits(two("100.00", "50.00"))).toEqual([]);
    const bad = checkStediEdits(two("100.00", "50.00").replace("*50.00***", "*60.00***"));
    expect(bad.map((f) => f.rule)).toEqual(["total-matches-lines"]);
  });

  it("refuses an interchange with two transaction sets", () => {
    const body = claim.split("\n").slice(2, -3).join("\n");
    const doubled = `${claim.split("\n").slice(0, -3).join("\n")}\n${body}\nGE*1*101~\nIEA*1*000000101~`;
    expect(() => checkStediEdits(doubled)).toThrow(X12FormatError);
  });

  it("frequency 8 without REF*F8", () => {
    const noF8 = fixture("cancel_818").replace(/REF\*F8\*[^~]*~\n/, "");
    expect(rules(noF8)).toEqual(["payer-claim-number-required"]);
  });
});

describe("checkStediEdits: findings never carry payload content", () => {
  it("does not echo a distinctive value placed in a failing field", () => {
    const raw = fixture("claim")
      .replace("CLM*WXHOSP0001*1500.00", "CLM*WXHOSP0001*ZQ-UNIQUE-PHI")
      .replace("CL1*1*1*30", "CL1*1**30");
    const f = checkStediEdits(raw);
    expect(f.length).toBeGreaterThan(0);
    expect(JSON.stringify(f)).not.toMatch(/ZQ-UNIQUE-PHI|WXHOSP0001|DOE|JANE|SMITH/);
  });
});
