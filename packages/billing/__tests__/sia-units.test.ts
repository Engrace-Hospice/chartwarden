// @chartwarden/billing — the shared SIA units engine (M23, D6). ONE pure function decides which visits count toward
// the Service Intensity Add-on and how many 15-minute units each is worth, so the forecast, the claim snapshot, the
// validation rule and the visit lines agree. Rules under test (CMS Pub. 100-04 ch. 11 §30.2.2/§30.3, 42 CFR 418.302):
// RHC days only, last 7 days of life [DOD-6, DOD], in-person RN (G0299) / MSW (G0155) only, per-visit rounding to
// 15 minutes (min 1 unit), 16 units per day combined, payment = units x CHC hourly / 4. Documented time is never
// fabricated: a visit with no start/stop is surfaced, never defaulted.
import {
  DEFAULT_SIA_POLICY,
  SIA_MAX_UNITS_PER_DAY,
  type SiaVisitInput,
  buildVisitLines,
  evaluateSiaUnits,
  forecastSia,
  normalizeDiscipline,
  siaAmountCents,
  siaUnitsFromLines,
  visitUnitsForMinutes,
} from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

const DOD = "2026-06-10"; // full window = [2026-06-04, 2026-06-10]
const RHC = [{ from: "2026-05-01", to: "2026-06-10" }];

function visit(over: Partial<SiaVisitInput>): SiaVisitInput {
  return {
    encounterId: "e1",
    serviceDate: DOD,
    discipline: "rn",
    encounterType: "routine_visit",
    billability: "billable",
    durationMinutes: 60,
    modality: "in_person",
    modalityConfirmed: true,
    ...over,
  };
}

function evaluate(visits: readonly SiaVisitInput[], over: Record<string, unknown> = {}) {
  return evaluateSiaUnits({ visits, deathDate: DOD, rhcPeriods: RHC, ...over });
}

function reasonOf(result: ReturnType<typeof evaluate>, id: string): string | null {
  return result.visits.find((v) => v.encounterId === id)?.excluded ?? null;
}

describe("normalizeDiscipline (the live case bug: M8 emits lowercase, the rule compared uppercase)", () => {
  it("maps any casing and the HHA alias to the M8 enum value", () => {
    expect(normalizeDiscipline("RN")).toBe("rn");
    expect(normalizeDiscipline(" rn ")).toBe("rn");
    expect(normalizeDiscipline("MSW")).toBe("msw");
    expect(normalizeDiscipline("HHA")).toBe("chha");
  });
  it("returns null for an unknown discipline instead of guessing", () => {
    expect(normalizeDiscipline("wizard")).toBeNull();
    expect(normalizeDiscipline("")).toBeNull();
  });
});

describe("visitUnitsForMinutes (the single rounding rule)", () => {
  it.each([
    [1, 1],
    [7, 1],
    [8, 1],
    [22, 1],
    [23, 2],
    [60, 4],
    [240, 16],
  ])("%i minutes -> %i unit(s)", (minutes, units) => {
    expect(visitUnitsForMinutes(minutes)).toBe(units);
  });
  it("breaks the exact half-unit tie by policy (default up)", () => {
    expect(visitUnitsForMinutes(22.5)).toBe(2);
    expect(visitUnitsForMinutes(22.5, "up")).toBe(2);
    expect(visitUnitsForMinutes(22.5, "down")).toBe(1);
  });
  it("never fabricates units from a missing duration", () => {
    expect(visitUnitsForMinutes(0)).toBeNull();
    expect(visitUnitsForMinutes(-5)).toBeNull();
    expect(visitUnitsForMinutes(Number.NaN)).toBeNull();
  });
});

describe("evaluateSiaUnits — eligibility", () => {
  it("counts a lowercase in-person RN and MSW visit (regression for the uppercase-only rule)", () => {
    const r = evaluate([
      visit({ encounterId: "rn", discipline: "rn", durationMinutes: 60 }),
      visit({ encounterId: "sw", discipline: "msw", durationMinutes: 30 }),
    ]);
    expect(r.paidUnits).toBe(6); // 4 + 2
    expect(r.visits.every((v) => v.counted)).toBe(true);
  });

  it.each([
    ["lpn", "ineligible_discipline"],
    ["chha", "ineligible_discipline"],
    ["chaplain", "ineligible_discipline"],
    ["md", "ineligible_discipline"],
    ["np", "ineligible_discipline"],
  ])("excludes %s (%s)", (discipline, reason) => {
    expect(reasonOf(evaluate([visit({ discipline })]), "e1")).toBe(reason);
  });

  it("excludes non-visit encounter types for an eligible discipline", () => {
    const r = evaluate([visit({ encounterType: "idg_followup" })]);
    expect(reasonOf(r, "e1")).toBe("non_visit_encounter");
  });

  it("excludes visits that are not billable or await a cosignature", () => {
    expect(reasonOf(evaluate([visit({ billability: "not_billable" })]), "e1")).toBe("not_billable");
    expect(reasonOf(evaluate([visit({ billability: "awaiting_cosignature" })]), "e1")).toBe(
      "awaiting_cosignature",
    );
  });

  it("excludes telephonic visits by modality or by encounter type", () => {
    expect(reasonOf(evaluate([visit({ modality: "telephonic" })]), "e1")).toBe(
      "modality_telephonic",
    );
    expect(reasonOf(evaluate([visit({ encounterType: "telephonic", modality: null })]), "e1")).toBe(
      "modality_telephonic",
    );
  });

  it("excludes video by default and includes it only when the policy allows it", () => {
    const v = visit({ modality: "video" });
    expect(reasonOf(evaluate([v]), "e1")).toBe("modality_video");
    const allowed = evaluate([v], { policy: { videoEligible: true } });
    expect(allowed.paidUnits).toBe(4);
  });

  it("treats an unknown or unconfirmed modality conservatively with a visible reason", () => {
    expect(reasonOf(evaluate([visit({ modality: null, modalityConfirmed: false })]), "e1")).toBe(
      "modality_unconfirmed",
    );
    expect(
      reasonOf(evaluate([visit({ modality: "in_person", modalityConfirmed: false })]), "e1"),
    ).toBe("modality_unconfirmed");
  });

  it.each([null, 0, -3])(
    "surfaces a missing duration (%s) instead of defaulting it",
    (durationMinutes) => {
      const r = evaluate([visit({ durationMinutes })]);
      expect(reasonOf(r, "e1")).toBe("no_documented_time");
      expect(r.paidUnits).toBe(0);
    },
  );

  it("excludes a visit on a day that is not routine home care", () => {
    const r = evaluate([visit({})], { rhcPeriods: [{ from: "2026-05-01", to: "2026-06-08" }] });
    expect(reasonOf(r, "e1")).toBe("non_rhc_day");
  });

  it("excludes post-mortem visits and PM-modifier visits", () => {
    expect(reasonOf(evaluate([visit({ postMortem: true })]), "e1")).toBe("post_mortem");
    expect(reasonOf(evaluate([visit({ modifiers: ["PM"] })]), "e1")).toBe("pm_modifier");
  });
});

describe("evaluateSiaUnits — window", () => {
  it("covers [DOD-6, DOD] inclusive: the death date is day 1 of 7", () => {
    const r = evaluate([
      visit({ encounterId: "day1", serviceDate: "2026-06-10" }),
      visit({ encounterId: "day7", serviceDate: "2026-06-04" }),
    ]);
    expect(r.window).toEqual({ from: "2026-06-04", to: "2026-06-10" });
    expect(r.visits.filter((v) => v.counted).map((v) => v.encounterId)).toEqual(["day7", "day1"]);
  });

  it("ignores a visit 8 days before death (outside the window, not even listed)", () => {
    const r = evaluate([visit({ serviceDate: "2026-06-03" })]);
    expect(r.visits).toHaveLength(0);
    expect(r.paidUnits).toBe(0);
  });

  it("yields an empty result with no date of death", () => {
    const r = evaluateSiaUnits({ visits: [visit({})], deathDate: null, rhcPeriods: RHC });
    expect(r.window).toBeNull();
    expect(r.paidUnits).toBe(0);
    expect(r.visits).toHaveLength(0);
  });

  it("clamps to the claim's own service dates: visits on other claims are not counted here", () => {
    const r = evaluate(
      [
        visit({ encounterId: "inside", serviceDate: "2026-06-05" }),
        visit({ encounterId: "prior", serviceDate: "2026-05-31" }),
      ],
      { claimWindow: { from: "2026-06-01", to: "2026-06-30" }, deathDate: "2026-06-05" },
    );
    // full window [2026-05-30, 2026-06-05]; the claim covers only June, so the May 31 visit belongs to the prior claim.
    expect(reasonOf(r, "prior")).toBe("outside_claim_window");
    expect(r.visits.find((v) => v.encounterId === "inside")?.counted).toBe(true);
    expect(r.effectiveWindow).toEqual({ from: "2026-06-01", to: "2026-06-05" });
    expect(r.paidUnits).toBe(4);
  });
});

describe("evaluateSiaUnits — 16-unit daily cap, RN + MSW combined", () => {
  it("caps a day at 16 units and reports what was truncated, filling in encounter-id order", () => {
    const r = evaluate([
      visit({ encounterId: "a-rn", discipline: "rn", durationMinutes: 240 }), // 16
      visit({ encounterId: "b-sw", discipline: "msw", durationMinutes: 60 }), // 4 -> all truncated
    ]);
    expect(SIA_MAX_UNITS_PER_DAY).toBe(16);
    expect(r.paidUnits).toBe(16);
    expect(r.eligibleUnits).toBe(20);
    expect(r.truncatedUnits).toBe(4);
    expect(reasonOf(r, "b-sw")).toBe("over_daily_cap");
    expect(r.days).toEqual([{ date: DOD, eligibleUnits: 20, paidUnits: 16, truncatedUnits: 4 }]);
  });

  it("pays a partially-fitting visit for the units that fit", () => {
    const r = evaluate([
      visit({ encounterId: "a", durationMinutes: 210 }), // 14
      visit({ encounterId: "b", discipline: "msw", durationMinutes: 60 }), // 4 -> 2 fit
    ]);
    const b = r.visits.find((v) => v.encounterId === "b");
    expect(b).toMatchObject({ units: 4, paidUnits: 2, counted: true });
    expect(r.paidUnits).toBe(16);
  });

  it("records who supplied each visit's documented minutes, and never counts differently because of it", () => {
    const typed = evaluate([
      visit({ encounterId: "t", durationMinutes: 60, timeSource: "clinician" }),
      visit({ encounterId: "e", discipline: "msw", durationMinutes: 60, timeSource: "evv" }),
      visit({
        encounterId: "u",
        discipline: "msw",
        serviceDate: "2026-06-09",
        durationMinutes: 60,
      }),
    ]);
    const sourceOf = (id: string) => typed.visits.find((v) => v.encounterId === id)?.timeSource;
    expect([sourceOf("t"), sourceOf("e"), sourceOf("u")]).toEqual(["clinician", "evv", null]);
    const untyped = evaluate([
      visit({ encounterId: "t", durationMinutes: 60 }),
      visit({ encounterId: "e", discipline: "msw", durationMinutes: 60 }),
      visit({
        encounterId: "u",
        discipline: "msw",
        serviceDate: "2026-06-09",
        durationMinutes: 60,
      }),
    ]);
    expect(typed.paidUnits).toBe(untyped.paidUnits);
  });

  it("applies the cap per day, not across the window", () => {
    const r = evaluate([
      visit({ encounterId: "d1", serviceDate: "2026-06-10", durationMinutes: 300 }),
      visit({ encounterId: "d2", serviceDate: "2026-06-09", durationMinutes: 300 }),
    ]);
    expect(r.paidUnits).toBe(32);
  });
});

describe("pricing and forecast", () => {
  it("prices units x CHC hourly / 4, rounded once on the total", () => {
    expect(siaAmountCents(5, 7192)).toBe(8990); // 5 units = 1.25 h x $71.92
    expect(siaAmountCents(0, 7192)).toBe(0);
  });

  it("forecasts the payable add-on for a hypothetical date of death", () => {
    const f = forecastSia({
      visits: [visit({ durationMinutes: 60 })],
      hypotheticalDeathDate: DOD,
      rhcPeriods: RHC,
      chcHourlyRateCents: 7192,
    });
    expect(f.paidUnits).toBe(4);
    expect(f.amountCents).toBe(7192);
  });

  it("forecasts units but no dollars when no rate is resolved", () => {
    const f = forecastSia({ visits: [visit({})], hypotheticalDeathDate: DOD, rhcPeriods: RHC });
    expect(f.paidUnits).toBe(4);
    expect(f.amountCents).toBeNull();
  });

  it("records the policy it used in the result", () => {
    expect(evaluate([visit({})]).policy).toEqual(DEFAULT_SIA_POLICY);
    expect(DEFAULT_SIA_POLICY).toMatchObject({ unitTieBreak: "up", videoEligible: false });
  });
});

describe("siaUnitsFromLines — what the MAC will actually price", () => {
  const line = (over: Record<string, unknown>) => ({
    serviceDate: DOD,
    revenueCode: "0551",
    hcpcs: "G0299",
    modifiers: [] as string[],
    unitCount: 4,
    levelOfCare: "routine_home_care" as const,
    ...over,
  });
  const window = { from: "2026-06-04", to: "2026-06-10" };

  it("sums RN G0299 and MSW G0155 units per day, capped at 16", () => {
    const r = siaUnitsFromLines(
      [line({ unitCount: 10 }), line({ revenueCode: "0561", hcpcs: "G0155", unitCount: 10 })],
      window,
    );
    expect(r.paidUnits).toBe(16);
  });

  it("ignores LPN G0300, aides, MSW phone calls (0569), PM lines, non-RHC lines and out-of-window lines", () => {
    const r = siaUnitsFromLines(
      [
        line({ hcpcs: "G0300" }),
        line({ revenueCode: "0571", hcpcs: "G0156" }),
        line({ revenueCode: "0569", hcpcs: "G0155" }),
        line({ modifiers: ["PM"] }),
        line({ levelOfCare: "general_inpatient_care" }),
        line({ serviceDate: "2026-06-03" }),
      ],
      window,
    );
    expect(r.paidUnits).toBe(0);
  });
});

describe("visit lines honour the confirmed modality (a phone visit must never be billed as G0299)", () => {
  const encounter = (modality: "in_person" | "telephonic" | "video" | null) => ({
    encounterId: "e1",
    serviceDate: DOD,
    billability: "billable" as const,
    discipline: "rn",
    encounterType: "routine_visit",
    durationMinutes: 60,
    modality,
  });
  const lineCount = (modality: "in_person" | "telephonic" | "video" | null) =>
    buildVisitLines({
      encounters: [encounter(modality)],
      levelOfCarePeriods: [
        {
          levelOfCarePeriodId: "p1",
          levelOfCare: "routine_home_care",
          from: "2026-05-01",
          to: DOD,
        },
      ],
      inpatientHospiceFacility: false,
    }).lines.length;

  it("emits no RN line for a visit confirmed telephonic, even under a routine encounter type", () => {
    expect(lineCount("telephonic")).toBe(0);
  });
  it("still emits the line for an in-person visit and for a legacy visit with no recorded modality", () => {
    expect(lineCount("in_person")).toBe(1);
    expect(lineCount(null)).toBe(1);
  });
});

describe("conformance: the SIA engine and the claim visit lines agree on units", () => {
  it("equals the 16-capped sum of the SIA-coded visit-line units for the same visits", () => {
    const visits: SiaVisitInput[] = [
      visit({ encounterId: "a", durationMinutes: 47 }), // 3
      visit({ encounterId: "b", discipline: "msw", durationMinutes: 95 }), // 6
      visit({ encounterId: "c", serviceDate: "2026-06-08", durationMinutes: 600 }), // 40 -> capped 16
    ];
    const lines = buildVisitLines({
      encounters: visits.map((v) => ({
        encounterId: v.encounterId,
        serviceDate: v.serviceDate,
        billability: v.billability,
        discipline: v.discipline,
        encounterType: v.encounterType,
        durationMinutes: v.durationMinutes,
      })),
      levelOfCarePeriods: [
        {
          levelOfCarePeriodId: "p1",
          levelOfCare: "routine_home_care",
          from: "2026-05-01",
          to: "2026-06-10",
        },
      ],
      inpatientHospiceFacility: false,
    }).lines.map((l) => ({
      serviceDate: l.serviceDate,
      revenueCode: l.revenueCode,
      hcpcs: l.hcpcsCode,
      modifiers: [] as string[],
      unitCount: l.unitCount,
      levelOfCare: l.levelOfCare,
    }));
    const engine = evaluate(visits);
    const fromLines = siaUnitsFromLines(lines, { from: "2026-06-04", to: "2026-06-10" });
    expect(engine.paidUnits).toBe(3 + 6 + 16);
    expect(fromLines.paidUnits).toBe(engine.paidUnits);
  });
});
