import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("checkStediEdits: findings never carry payload content", () => {
  it("names the rule and the segment, not values", () => {
    const f = checkStediEdits(fixture("claim").replace("CL1*1*1*30", "CL1*1**30"));
    expect(JSON.stringify(f)).not.toMatch(/DOE|JANE|1EG4TE5MK73|SMITH/);
  });
});
