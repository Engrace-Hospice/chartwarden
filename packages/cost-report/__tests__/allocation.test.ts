// @wardenx/cost-report — M27 allocation-chain (A → B → C → D → E-1) pure-domain unit tests.
//
// Cost-report allocation is REGULATORY math: a cent off in a settlement line is a real cap-settlement
// consequence and an audit trigger. The cross-cutting invariants asserted here are:
//   - step-down (Worksheet B): allocated direct-center totals tie EXACTLY to the conserved input pool;
//   - ancillary RCC (Worksheet C): per-program apportioned cost ties to RCC × Σ(program charges);
//   - program apportionment (Worksheet D): per-cell cost ties to the level-of-care allowable cost;
//   - settlement (Worksheet E-1): cap lines appear ONLY when their M26 input is present (never
//     fabricated), and SIA / sequestration are driven by the PROVIDED input rates, not hard-coded.
import { describe, expect, it } from "vitest";
import {
  type AncillaryApportionInput,
  type ProgramApportionInput,
  type SettlementInput,
  type StepDownAllocateInput,
  apportionAncillary,
  apportionToPrograms,
  computeSettlement,
  stepDownAllocate,
} from "@wardenx/cost-report";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Worksheet A → B step-down
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("stepDownAllocate — Worksheet B step-down conserves the pool to the cent", () => {
  // Two overhead centers stepping down onto two direct centers, in allocation order. Statistical bases
  // are deliberately uneven so the largest-remainder split exercises residual-cent distribution.
  const input: StepDownAllocateInput = {
    costCenters: [
      { code: "OH1", name: "Administrative & General", directCostCents: 100_001, isOverhead: true },
      { code: "OH2", name: "Plant Operations", directCostCents: 50_003, isOverhead: true },
      { code: "D1", name: "Nursing (RHC)", directCostCents: 200_000, isOverhead: false },
      { code: "D2", name: "Pharmacy", directCostCents: 300_000, isOverhead: false },
    ],
    statisticalBases: [
      {
        allocatingCenterCode: "OH1",
        weights: [
          { receivingCenterCode: "OH2", statisticValue: 3 },
          { receivingCenterCode: "D1", statisticValue: 5 },
          { receivingCenterCode: "D2", statisticValue: 7 },
        ],
      },
      {
        allocatingCenterCode: "OH2",
        weights: [
          { receivingCenterCode: "D1", statisticValue: 1 },
          { receivingCenterCode: "D2", statisticValue: 2 },
        ],
      },
    ],
  };

  it("ties out: Σ(direct-center allocated cost) === Σ(every center's direct cost), no drift", () => {
    const result = stepDownAllocate(input);
    const conserved = 100_001 + 50_003 + 200_000 + 300_000;
    expect(result.totalDirectCostCents).toBe(conserved);
    expect(result.totalAllocatedToDirectCents).toBe(conserved);
    expect(result.tiesOut).toBe(true);
  });

  it("steps every overhead center out to zero and accumulates only into direct centers", () => {
    const result = stepDownAllocate(input);
    const byCode = new Map(result.centers.map((c) => [c.code, c]));
    expect(byCode.get("OH1")!.totalCostCents).toBe(0);
    expect(byCode.get("OH2")!.totalCostCents).toBe(0);
    // Each direct center keeps direct + everything stepped into it.
    for (const code of ["D1", "D2"]) {
      const c = byCode.get(code)!;
      expect(c.totalCostCents).toBe(c.directCostCents + c.allocatedInCents);
      expect(c.totalCostCents).toBeGreaterThan(c.directCostCents);
    }
  });

  it("each step's amountAllocated equals the sum of where its cents landed (per-step tie-out)", () => {
    const result = stepDownAllocate(input);
    for (const step of result.steps) {
      const landed = step.allocations.reduce((a, x) => a + x.amountCents, 0);
      expect(landed).toBe(step.amountAllocatedCents);
    }
    // OH2 allocates its ACCUMULATED cost (its own direct + whatever OH1 stepped into it), not just direct.
    const oh2Step = result.steps.find((s) => s.allocatingCenterCode === "OH2")!;
    expect(oh2Step.amountAllocatedCents).toBeGreaterThan(50_003);
  });

  it("is deterministic: identical inputs produce a deeply-equal result", () => {
    expect(stepDownAllocate(input)).toEqual(stepDownAllocate(input));
  });

  it("an all-zero pool yields all-zero centers and still ties out", () => {
    const zero: StepDownAllocateInput = {
      costCenters: [
        { code: "OH1", name: "A&G", directCostCents: 0, isOverhead: true },
        { code: "D1", name: "Nursing", directCostCents: 0, isOverhead: false },
        { code: "D2", name: "Pharmacy", directCostCents: 0, isOverhead: false },
      ],
      statisticalBases: [
        {
          allocatingCenterCode: "OH1",
          weights: [
            { receivingCenterCode: "D1", statisticValue: 1 },
            { receivingCenterCode: "D2", statisticValue: 1 },
          ],
        },
      ],
    };
    const result = stepDownAllocate(zero);
    expect(result.totalDirectCostCents).toBe(0);
    expect(result.totalAllocatedToDirectCents).toBe(0);
    expect(result.tiesOut).toBe(true);
    for (const c of result.centers) expect(c.totalCostCents).toBe(0);
  });

  it("an empty cost-center list yields empty centers and a trivial tie-out", () => {
    const result = stepDownAllocate({ costCenters: [], statisticalBases: [] });
    expect(result.centers).toEqual([]);
    expect(result.steps).toEqual([]);
    expect(result.totalDirectCostCents).toBe(0);
    expect(result.totalAllocatedToDirectCents).toBe(0);
    expect(result.tiesOut).toBe(true);
  });

  it("conserves the pool even when an overhead center has NO statistical basis (equal-split fallback)", () => {
    // OH1 has no basis entry → weights all 0 → money kernel falls back to an equal split; the pool is
    // still distributed exactly rather than discarded.
    const noBasis: StepDownAllocateInput = {
      costCenters: [
        { code: "OH1", name: "A&G", directCostCents: 99_999, isOverhead: true },
        { code: "D1", name: "Nursing", directCostCents: 1, isOverhead: false },
        { code: "D2", name: "Pharmacy", directCostCents: 2, isOverhead: false },
      ],
      statisticalBases: [],
    };
    const result = stepDownAllocate(noBasis);
    expect(result.tiesOut).toBe(true);
    expect(result.totalAllocatedToDirectCents).toBe(99_999 + 1 + 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Worksheet C ancillary apportionment (ratio-of-cost-to-charges)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("apportionAncillary — Worksheet C RCC apportionment ties to the cent", () => {
  const input: AncillaryApportionInput = {
    costCenters: [
      {
        code: "ANC-LAB",
        name: "Laboratory",
        totalCostCents: 84_230,
        totalChargesCents: 100_000,
        programCharges: [
          { program: "medicare", chargesCents: 60_000 },
          { program: "medicaid", chargesCents: 30_000 },
          { program: "other", chargesCents: 10_000 },
        ],
      },
      {
        // Program charges sum to LESS than total charges (non-program charges exist): only the
        // program-charge portion of cost is apportioned.
        code: "ANC-DME",
        name: "Durable Medical Equipment",
        totalCostCents: 50_000,
        totalChargesCents: 80_000,
        programCharges: [
          { program: "medicare", chargesCents: 30_001 },
          { program: "medicaid", chargesCents: 19_999 },
        ],
      },
    ],
  };

  it("computes the cost-to-charge ratio as an exact decimal string", () => {
    const lab = apportionAncillary(input).centers.find((c) => c.code === "ANC-LAB")!;
    // 84230 / 100000 = 0.8423 exactly.
    expect(lab.costToChargeRatio).toBe("0.8423");
  });

  it("program lines sum EXACTLY to the apportioned subtotal (largest-remainder, no drift)", () => {
    for (const center of apportionAncillary(input).centers) {
      const lineSum = center.programLines.reduce((a, l) => a + l.apportionedCostCents, 0);
      expect(lineSum).toBe(center.apportionedSubtotalCents);
    }
  });

  it("the apportioned subtotal equals RCC × Σ(program charges) rounded to cents", () => {
    const lab = apportionAncillary(input).centers.find((c) => c.code === "ANC-LAB")!;
    // RCC 0.8423 × 100000 program charges = 84230.
    expect(lab.apportionedSubtotalCents).toBe(84_230);
    // Exact per-program shares: 60% / 30% / 10% of 84230.
    const byProgram = new Map(lab.programLines.map((l) => [l.program, l.apportionedCostCents]));
    expect(byProgram.get("medicare")).toBe(50_538);
    expect(byProgram.get("medicaid")).toBe(25_269);
    expect(byProgram.get("other")).toBe(8_423);
  });

  it("emits the three program lines in canonical medicare → medicaid → other order", () => {
    const dme = apportionAncillary(input).centers.find((c) => c.code === "ANC-DME")!;
    expect(dme.programLines.map((l) => l.program)).toEqual(["medicare", "medicaid", "other"]);
  });

  it("a zero-charges center yields RCC '0' and all-zero program lines (no division attempted)", () => {
    const result = apportionAncillary({
      costCenters: [
        {
          code: "ANC-ZERO",
          name: "Idle Center",
          totalCostCents: 12_345,
          totalChargesCents: 0,
          programCharges: [{ program: "medicare", chargesCents: 0 }],
        },
      ],
    });
    const c = result.centers[0]!;
    expect(c.costToChargeRatio).toBe("0");
    expect(c.apportionedSubtotalCents).toBe(0);
    expect(c.programLines.every((l) => l.apportionedCostCents === 0)).toBe(true);
  });

  it("is deterministic across re-runs", () => {
    expect(apportionAncillary(input)).toEqual(apportionAncillary(input));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Worksheet D program apportionment (by patient days)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("apportionToPrograms — Worksheet D apportions allowable cost by patient days, to the cent", () => {
  const input: ProgramApportionInput = {
    levelOfCareCosts: [
      { levelOfCare: "rhc", allowableCostCents: 1_000_000 },
      { levelOfCare: "gip", allowableCostCents: 333_337 },
    ],
    patientDays: [
      { levelOfCare: "rhc", program: "medicare", month: "2026-01", patientDays: 100 },
      { levelOfCare: "rhc", program: "medicaid", month: "2026-01", patientDays: 60 },
      { levelOfCare: "rhc", program: "other", month: "2026-01", patientDays: 40 },
      { levelOfCare: "rhc", program: "medicare", month: "2026-02", patientDays: 50 },
      { levelOfCare: "gip", program: "medicare", month: "2026-01", patientDays: 7 },
      { levelOfCare: "gip", program: "medicaid", month: "2026-01", patientDays: 4 },
    ],
  };

  it("per-level: Σ(cell apportioned cost) ties EXACTLY to the level allowable cost", () => {
    const result = apportionToPrograms(input);
    for (const level of result.levels) {
      if (level.totalPatientDays === 0) continue; // no days ⇒ nothing to apportion (documented behavior)
      const cellSum = result.cells
        .filter((c) => c.levelOfCare === level.levelOfCare)
        .reduce((a, c) => a + c.apportionedCostCents, 0);
      expect(cellSum).toBe(level.allowableCostCents);
    }
  });

  it("program totals sum to the total apportioned cost across all levels", () => {
    const result = apportionToPrograms(input);
    const programSum = result.programTotals.reduce((a, p) => a + p.apportionedCostCents, 0);
    const cellSum = result.cells.reduce((a, c) => a + c.apportionedCostCents, 0);
    expect(programSum).toBe(cellSum);
    // Both rhc (full days) and gip (full days) are fully apportioned here.
    expect(cellSum).toBe(1_000_000 + 333_337);
  });

  it("computes the per-diem as an exact decimal string for a level with days", () => {
    const rhc = apportionToPrograms(input).levels.find((l) => l.levelOfCare === "rhc")!;
    // 100 + 60 + 40 + 50 = 250 days; 1,000,000 cents / 250 days = 4000 cents/day exactly.
    expect(rhc.totalPatientDays).toBe(250);
    expect(rhc.perDiemCostCents).toBe("4000");
  });

  it("a level with cost but ZERO patient days reports '0' per-diem and emits no cells", () => {
    const result = apportionToPrograms({
      levelOfCareCosts: [{ levelOfCare: "chc", allowableCostCents: 500_000 }],
      patientDays: [],
    });
    const chc = result.levels.find((l) => l.levelOfCare === "chc")!;
    expect(chc.totalPatientDays).toBe(0);
    expect(chc.perDiemCostCents).toBe("0");
    expect(result.cells.length).toBe(0);
  });

  it("emits one rollup per level of care in canonical order even when absent from inputs", () => {
    const result = apportionToPrograms(input);
    expect(result.levels.map((l) => l.levelOfCare)).toEqual(["rhc", "chc", "irc", "gip"]);
  });

  it("is deterministic across re-runs", () => {
    expect(apportionToPrograms(input)).toEqual(apportionToPrograms(input));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Worksheet E-1 settlement
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("computeSettlement — Worksheet E-1 cap handling and provided-rate application", () => {
  const lineCodes = (r: ReturnType<typeof computeSettlement>) => r.lines.map((l) => l.code);

  it("with BOTH cap inputs ABSENT: capPositionPending=true and NO cap lines are emitted", () => {
    const input: SettlementInput = {
      medicareAllowableCostCents: 1_000_000,
      interimPaymentsCents: 900_000,
    };
    const r = computeSettlement(input);
    expect(r.capPositionPending).toBe(true);
    expect(r.aggregateCap).toBeNull();
    expect(r.inpatientCap).toBeNull();
    // Cap lines (E1.04 aggregate, E1.05 inpatient) are OMITTED — never fabricated.
    expect(lineCodes(r)).not.toContain("E1.04");
    expect(lineCodes(r)).not.toContain("E1.05");
    expect(lineCodes(r)).toEqual(["E1.01", "E1.02", "E1.03", "E1.06", "E1.07", "E1.08"]);
  });

  it("with only ONE cap input present, capPositionPending stays true and only that cap line appears", () => {
    const input: SettlementInput = {
      medicareAllowableCostCents: 1_000_000,
      interimPaymentsCents: 0,
      aggregateCap: {
        capYear: 2026,
        medicareBeneficiaryCount: 10,
        aggregateCapAmountCents: 1_000_000,
        totalMedicarePaymentsCents: 1_200_000,
      },
    };
    const r = computeSettlement(input);
    expect(r.capPositionPending).toBe(true); // inpatientCap still absent
    expect(r.aggregateCap).not.toBeNull();
    expect(r.inpatientCap).toBeNull();
    expect(lineCodes(r)).toContain("E1.04");
    expect(lineCodes(r)).not.toContain("E1.05");
  });

  it("with BOTH cap inputs PRESENT: cap/inpatient lines appear and the positions are resolved", () => {
    const input: SettlementInput = {
      medicareAllowableCostCents: 1_000_000,
      interimPaymentsCents: 500_000,
      aggregateCap: {
        capYear: 2026,
        medicareBeneficiaryCount: 8,
        aggregateCapAmountCents: 1_000_000,
        totalMedicarePaymentsCents: 1_200_000, // overage 200,000
      },
      inpatientCap: {
        capYear: 2026,
        totalMedicareDays: 1_000,
        inpatientDays: 250, // cap days = floor(1000 * 20 / 100) = 200 ⇒ excess 50
        inpatientCapPercent: 20,
        inpatientPaymentsCents: 100_000,
        inpatientLimitCents: 80_000, // reduction 20,000
      },
    };
    const r = computeSettlement(input);
    expect(r.capPositionPending).toBe(false);
    expect(lineCodes(r)).toContain("E1.04");
    expect(lineCodes(r)).toContain("E1.05");

    expect(r.aggregateCap).toEqual({ capYear: 2026, overageCents: 200_000 });
    expect(r.inpatientCap).toEqual({
      capYear: 2026,
      capDays: 200,
      excessDays: 50,
      exceeded: true,
      reductionCents: 20_000,
    });
    // Cap lines carry the negative (liability) amounts.
    const byCode = new Map(r.lines.map((l) => [l.code, l.amountCents]));
    expect(byCode.get("E1.04")).toBe(-200_000);
    expect(byCode.get("E1.05")).toBe(-20_000);
  });

  it("inpatient-cap reduction is NOT fabricated when M26 supplies no payment ceiling", () => {
    const input: SettlementInput = {
      medicareAllowableCostCents: 1_000_000,
      interimPaymentsCents: 0,
      aggregateCap: {
        capYear: 2026,
        medicareBeneficiaryCount: 8,
        aggregateCapAmountCents: 2_000_000,
        totalMedicarePaymentsCents: 1_000_000, // no overage
      },
      inpatientCap: {
        capYear: 2026,
        totalMedicareDays: 1_000,
        inpatientDays: 300, // exceeds the day cap (200) ...
        inpatientCapPercent: 20,
        inpatientPaymentsCents: 100_000,
        // ... but no inpatientLimitCents ⇒ reduction must be 0, not fabricated.
      },
    };
    const r = computeSettlement(input);
    expect(r.inpatientCap).not.toBeNull();
    expect(r.inpatientCap!.exceeded).toBe(true);
    expect(r.inpatientCap!.reductionCents).toBe(0);
    // Math.abs normalizes JS negative zero (-reductionCents of 0 ⇒ -0); the reduction is zero either way.
    expect(Math.abs(new Map(r.lines.map((l) => [l.code, l.amountCents])).get("E1.05")!)).toBe(0);
  });

  it("SIA and sequestration come from the PROVIDED input rates, not hard-coded constants", () => {
    const base: SettlementInput = {
      medicareAllowableCostCents: 1_000_000,
      interimPaymentsCents: 0,
    };

    // No rates supplied ⇒ both zero.
    const none = computeSettlement(base);
    expect(none.siaAddOnCents).toBe(0);
    expect(none.sequestrationReductionCents).toBe(0);

    // SIA credit is taken verbatim from the input.
    const withSia = computeSettlement({ ...base, siaAddOnCents: 50_000 });
    expect(withSia.siaAddOnCents).toBe(50_000);

    // Sequestration = rate(micros) × post-SIA Medicare payment, rounded half-up. 2.0000% of 1,050,000.
    const at2pct = computeSettlement({
      ...base,
      siaAddOnCents: 50_000,
      sequestrationRateMicros: 20_000,
    });
    expect(at2pct.sequestrationReductionCents).toBe(21_000); // 1,050,000 × 0.02

    // A DIFFERENT supplied rate yields a proportionally different reduction — proof it is data-driven.
    const at1pct = computeSettlement({ ...base, sequestrationRateMicros: 10_000 });
    expect(at1pct.sequestrationReductionCents).toBe(10_000); // 1,000,000 × 0.01
    const at0 = computeSettlement({ ...base, sequestrationRateMicros: 0 });
    expect(at0.sequestrationReductionCents).toBe(0);
  });

  it("settlement lines tie out internally: components → net reimbursable → balance due", () => {
    const input: SettlementInput = {
      medicareAllowableCostCents: 1_000_000,
      interimPaymentsCents: 750_000,
      siaAddOnCents: 40_000,
      sequestrationRateMicros: 20_000,
      aggregateCap: {
        capYear: 2026,
        medicareBeneficiaryCount: 8,
        aggregateCapAmountCents: 1_000_000,
        totalMedicarePaymentsCents: 1_050_000, // overage 50,000
      },
      inpatientCap: {
        capYear: 2026,
        totalMedicareDays: 1_000,
        inpatientDays: 250,
        inpatientCapPercent: 20,
        inpatientPaymentsCents: 90_000,
        inpatientLimitCents: 80_000, // reduction 10,000
      },
    };
    const r = computeSettlement(input);
    const byCode = new Map(r.lines.map((l) => [l.code, l.amountCents]));

    // E1.01..E1.05 sum to the net reimbursable cost (E1.06).
    const componentSum =
      byCode.get("E1.01")! +
      byCode.get("E1.02")! +
      byCode.get("E1.03")! +
      byCode.get("E1.04")! +
      byCode.get("E1.05")!;
    expect(componentSum).toBe(r.netReimbursableCostCents);
    expect(byCode.get("E1.06")).toBe(r.netReimbursableCostCents);

    // Net reimbursable − interim = balance due to provider (E1.08).
    expect(byCode.get("E1.07")).toBe(-750_000);
    expect(byCode.get("E1.08")).toBe(r.balanceDueToProviderCents);
    expect(r.balanceDueToProviderCents).toBe(r.netReimbursableCostCents - 750_000);
  });

  it("aggregate-cap overage floors at zero when payments are within the cap", () => {
    const r = computeSettlement({
      medicareAllowableCostCents: 1_000_000,
      interimPaymentsCents: 0,
      aggregateCap: {
        capYear: 2026,
        medicareBeneficiaryCount: 8,
        aggregateCapAmountCents: 2_000_000,
        totalMedicarePaymentsCents: 1_000_000, // under cap ⇒ no overage
      },
      inpatientCap: {
        capYear: 2026,
        totalMedicareDays: 1_000,
        inpatientDays: 100,
        inpatientCapPercent: 20,
        inpatientPaymentsCents: 50_000,
        inpatientLimitCents: 60_000,
      },
    });
    expect(r.aggregateCap!.overageCents).toBe(0);
    expect(r.inpatientCap!.exceeded).toBe(false);
    expect(r.inpatientCap!.reductionCents).toBe(0);
  });

  it("is deterministic across re-runs", () => {
    const input: SettlementInput = {
      medicareAllowableCostCents: 1_234_567,
      interimPaymentsCents: 1_000_000,
      siaAddOnCents: 11_111,
      sequestrationRateMicros: 20_000,
    };
    expect(computeSettlement(input)).toEqual(computeSettlement(input));
  });
});
