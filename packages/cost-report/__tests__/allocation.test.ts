import {
  type PerDiemInput,
  type StepDownAllocateInput,
  calculatePerDiem,
  stepDownAllocate,
} from "@wardenx/cost-report";
// @wardenx/cost-report — M27 allocation-chain (A → B/B-1 step-down → C per-diem) pure-domain unit tests.
//
// Hospice cost-report math is REGULATORY (Form CMS-1984-14): a cent off in a per-diem is a real
// rate/cap consequence. The cross-cutting invariants asserted here:
//   - step-down (Worksheet B): the allocated direct-center (level-of-care) totals tie EXACTLY to the
//     conserved input pool (§4320 col. 18 line 101 = col. 0 line 101);
//   - per-diem (Worksheet C): per diem = level cost ÷ days, program cost = per diem × program days (§4330).
import { describe, expect, it } from "vitest";

describe("stepDownAllocate — Worksheet B step-down conserves the pool to the cent", () => {
  // One overhead center (A&G) stepping down onto the four LOC centers by a statistical basis.
  const input: StepDownAllocateInput = {
    costCenters: [
      { code: "AG", name: "Administrative & General", directCostCents: 100_000, isOverhead: true },
      { code: "CHC", name: "Continuous Home Care", directCostCents: 50_000, isOverhead: false },
      { code: "RHC", name: "Routine Home Care", directCostCents: 300_000, isOverhead: false },
      { code: "IRC", name: "Inpatient Respite Care", directCostCents: 20_000, isOverhead: false },
      { code: "GIP", name: "General Inpatient Care", directCostCents: 30_000, isOverhead: false },
    ],
    statisticalBases: [
      {
        allocatingCenterCode: "AG",
        weights: [
          { receivingCenterCode: "CHC", statisticValue: 1 },
          { receivingCenterCode: "RHC", statisticValue: 6 },
          { receivingCenterCode: "IRC", statisticValue: 2 },
          { receivingCenterCode: "GIP", statisticValue: 1 },
        ],
      },
    ],
  };

  it("ties out: Σ(LOC allocated cost) === Σ(every center's direct cost), no drift", () => {
    const r = stepDownAllocate(input);
    const conserved = 100_000 + 50_000 + 300_000 + 20_000 + 30_000;
    expect(r.totalDirectCostCents).toBe(conserved);
    expect(r.totalAllocatedToDirectCents).toBe(conserved);
    expect(r.tiesOut).toBe(true);
  });

  it("steps the overhead center out to zero and folds it into the LOC centers", () => {
    const r = stepDownAllocate(input);
    const byCode = new Map(r.centers.map((c) => [c.code, c]));
    expect(byCode.get("AG")!.totalCostCents).toBe(0);
    // 100_000 split 1:6:2:1 → 10k / 60k / 20k / 10k onto the LOC direct costs.
    expect(byCode.get("RHC")!.totalCostCents).toBe(300_000 + 60_000);
    expect(byCode.get("CHC")!.totalCostCents).toBe(50_000 + 10_000);
  });

  it("an empty cost-center list yields a trivial tie-out", () => {
    const r = stepDownAllocate({ costCenters: [], statisticalBases: [] });
    expect(r.tiesOut).toBe(true);
    expect(r.totalAllocatedToDirectCents).toBe(0);
  });
});

describe("calculatePerDiem — Worksheet C per-diem cost (§4330)", () => {
  const input: PerDiemInput = {
    levels: [
      {
        levelOfCare: "chc",
        totalCostCents: 60_000,
        totalDays: 30,
        medicareDays: 20,
        medicaidDays: 5,
      },
      {
        levelOfCare: "rhc",
        totalCostCents: 360_000,
        totalDays: 300,
        medicareDays: 250,
        medicaidDays: 40,
      },
      { levelOfCare: "irc", totalCostCents: 0, totalDays: 0, medicareDays: 0, medicaidDays: 0 },
      {
        levelOfCare: "gip",
        totalCostCents: 40_000,
        totalDays: 10,
        medicareDays: 8,
        medicaidDays: 1,
      },
    ],
  };

  it("per diem = level cost ÷ days; program cost = per diem × program days (HALF-UP)", () => {
    const r = calculatePerDiem(input);
    const chc = r.levels.find((l) => l.levelOfCare === "chc")!;
    expect(chc.averageCostPerDiem).toBe("2000"); // 60_000 / 30
    expect(chc.medicareCostCents).toBe(40_000); // 2000 × 20
    expect(chc.medicaidCostCents).toBe(10_000); // 2000 × 5
  });

  it("a zero-day level yields a '0' per diem and zero program cost (no division)", () => {
    const irc = calculatePerDiem(input).levels.find((l) => l.levelOfCare === "irc")!;
    expect(irc.averageCostPerDiem).toBe("0");
    expect(irc.medicareCostCents).toBe(0);
  });

  it("totals: Σ level cost and blended per diem across all hospice days", () => {
    const r = calculatePerDiem(input);
    expect(r.totalCostCents).toBe(460_000);
    expect(r.totalDays).toBe(340);
    expect(Number(r.totalAverageCostPerDiem)).toBeCloseTo(460_000 / 340, 6);
  });

  it("is deterministic: identical inputs produce a deeply-equal result", () => {
    expect(calculatePerDiem(input)).toEqual(calculatePerDiem(input));
  });
});
