import {
  SIA_MAX_MINUTES_PER_DAY,
  SIA_QUALIFYING_DISCIPLINES,
  type SiaCalculationInput,
  type SiaEncounterInput,
  calculateSia,
  lineChargeCents,
} from "@wardenx/billing";
// @wardenx/billing — M23 SIA (Service Intensity Add-on) calculator (D6, spec §1.1 / §3.3
// `sia_calculation`) pure-domain tests.
//
// SIA fires ONLY when the patient is deceased AND ≥1 qualifying SIGNED RN/MSW in-person visit landed in the
// last-7-days-of-life window `[deceased − 6, deceased]` (inclusive). Qualifying visit time is paid at the
// (wage-index-adjusted) CHC HOURLY rate, capped at 4 hours (240 min) PER DAY. The exact CHC hourly amount
// is a published CMS fixture and is INJECTED (TODO(CMS-fixture)); the ARITHMETIC + the qualifying/boundary
// gating are asserted exactly. Pure: no DB/Fastify/BullMQ; everything injected.
import { describe, expect, it } from "vitest";

const DECEASED = "2026-06-10"; // window = [2026-06-04, 2026-06-10]
// TODO(CMS-fixture): replace with the published FY CHC hourly amount (wage-index-adjusted at the service layer).
const CHC_HOURLY = 6_000; // $60.00/hr ⇒ $1.00/min.

function enc(over: Partial<SiaEncounterInput>): SiaEncounterInput {
  return {
    encounterId: "enc-1",
    serviceDate: DECEASED,
    discipline: "RN",
    durationMinutes: 60,
    signed: true,
    ...over,
  };
}

function input(over: Partial<SiaCalculationInput>): SiaCalculationInput {
  return {
    deceasedDate: DECEASED,
    signedEncounters: [enc({})],
    chcHourlyRateCents: CHC_HOURLY,
    ...over,
  };
}

describe("SIA constants", () => {
  it("the per-day cap is 240 minutes (4 hours)", () => {
    expect(SIA_MAX_MINUTES_PER_DAY).toBe(240);
  });

  it("the default qualifying disciplines are RN + MSW", () => {
    expect([...SIA_QUALIFYING_DISCIPLINES]).toEqual(["RN", "MSW"]);
  });
});

describe("calculateSia — gating: deceased + qualifying-visit preconditions", () => {
  it("returns the empty result (no window) when the patient is not deceased", () => {
    const r = calculateSia(input({ deceasedDate: null }));
    expect(r.present).toBe(false);
    expect(r.patientDeceasedDate).toBeNull();
    expect(r.windowStart).toBeNull();
    expect(r.windowEnd).toBeNull();
    expect(r.qualifyingVisits).toHaveLength(0);
    expect(r.siaAddOnCents).toBe(0);
  });

  it("does not fire (but reports the window) when deceased with NO encounters", () => {
    const r = calculateSia(input({ signedEncounters: [] }));
    expect(r.present).toBe(false);
    expect(r.patientDeceasedDate).toBe(DECEASED);
    expect(r.windowStart).toBe("2026-06-04");
    expect(r.windowEnd).toBe(DECEASED);
    expect(r.siaAddOnCents).toBe(0);
  });

  it("fires for a single qualifying signed RN visit in-window", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ durationMinutes: 60 })] }));
    expect(r.present).toBe(true);
    expect(r.paidMinutes).toBe(60);
    expect(r.siaAddOnCents).toBe(lineChargeCents(1, CHC_HOURLY)); // 1 hour
    expect(r.siaAddOnCents).toBe(6_000);
  });

  it("fires for a qualifying MSW visit", () => {
    const r = calculateSia(
      input({ signedEncounters: [enc({ discipline: "MSW", durationMinutes: 30 })] }),
    );
    expect(r.present).toBe(true);
    expect(r.paidMinutes).toBe(30);
    expect(r.siaAddOnCents).toBe(lineChargeCents(0.5, CHC_HOURLY)); // half hour
    expect(r.siaAddOnCents).toBe(3_000);
  });

  it("does NOT fire for a non-qualifying discipline (HHA) in-window", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ discipline: "HHA" })] }));
    expect(r.present).toBe(false);
    expect(r.siaAddOnCents).toBe(0);
  });

  it("does NOT fire for a chaplain visit in-window", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ discipline: "chaplain" })] }));
    expect(r.present).toBe(false);
  });

  it("excludes an UNSIGNED RN visit even if in-window and qualifying", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ signed: false })] }));
    expect(r.present).toBe(false);
  });

  it("excludes a zero-duration visit", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ durationMinutes: 0 })] }));
    expect(r.present).toBe(false);
  });

  it("matches the discipline case-insensitively (rn / Rn / msw)", () => {
    for (const d of ["rn", "Rn", "msw", "MsW"]) {
      const r = calculateSia(input({ signedEncounters: [enc({ discipline: d })] }));
      expect(r.present).toBe(true);
    }
  });
});

describe("calculateSia — last-7-days-of-life window boundary (day 7 vs day 8)", () => {
  it("includes a visit on the window-start day (deceased − 6)", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ serviceDate: "2026-06-04" })] }));
    expect(r.present).toBe(true);
  });

  it("EXCLUDES a visit one day before the window (deceased − 7)", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ serviceDate: "2026-06-03" })] }));
    expect(r.present).toBe(false);
  });

  it("includes a visit on the deceased date itself (window end)", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ serviceDate: DECEASED })] }));
    expect(r.present).toBe(true);
  });

  it("EXCLUDES a visit after the deceased date", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ serviceDate: "2026-06-11" })] }));
    expect(r.present).toBe(false);
  });

  it("computes the window as exactly [deceased − 6, deceased]", () => {
    const r = calculateSia(input({}));
    expect(r.windowStart).toBe("2026-06-04");
    expect(r.windowEnd).toBe("2026-06-10");
  });
});

describe("calculateSia — per-day 4-hour cap", () => {
  it("caps a single 300-minute day at 240 paid minutes while reporting the raw total", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ durationMinutes: 300 })] }));
    expect(r.totalQualifyingMinutes).toBe(300);
    expect(r.paidMinutes).toBe(240);
    expect(r.siaAddOnCents).toBe(lineChargeCents(4, CHC_HOURLY)); // 4 hours
    expect(r.siaAddOnCents).toBe(24_000);
  });

  it("aggregates multiple same-day visits before applying the cap", () => {
    const r = calculateSia(
      input({
        signedEncounters: [
          enc({ encounterId: "a", serviceDate: DECEASED, durationMinutes: 150 }),
          enc({ encounterId: "b", serviceDate: DECEASED, durationMinutes: 150 }),
        ],
      }),
    );
    expect(r.totalQualifyingMinutes).toBe(300);
    expect(r.paidMinutes).toBe(240); // 300 → capped to 240
  });

  it("a visit exactly at the cap (240) is fully paid", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ durationMinutes: 240 })] }));
    expect(r.paidMinutes).toBe(240);
    expect(r.siaAddOnCents).toBe(24_000);
  });

  it("applies the cap PER DAY independently across two days", () => {
    const r = calculateSia(
      input({
        signedEncounters: [
          enc({ encounterId: "a", serviceDate: "2026-06-09", durationMinutes: 300 }), // → 240
          enc({ encounterId: "b", serviceDate: "2026-06-10", durationMinutes: 120 }), // → 120
        ],
      }),
    );
    expect(r.paidMinutes).toBe(240 + 120);
    expect(r.siaAddOnCents).toBe(lineChargeCents(4, CHC_HOURLY) + lineChargeCents(2, CHC_HOURLY));
  });

  it("honors a custom maxMinutesPerDay override", () => {
    const r = calculateSia(
      input({ signedEncounters: [enc({ durationMinutes: 200 })], maxMinutesPerDay: 120 }),
    );
    expect(r.paidMinutes).toBe(120);
  });
});

describe("calculateSia — custom qualifying disciplines override", () => {
  it("includes a discipline only when listed in the override set", () => {
    const r = calculateSia(
      input({ signedEncounters: [enc({ discipline: "HHA" })], qualifyingDisciplines: ["HHA"] }),
    );
    expect(r.present).toBe(true);
  });

  it("excludes RN when the override set omits it", () => {
    const r = calculateSia(
      input({ signedEncounters: [enc({ discipline: "RN" })], qualifyingDisciplines: ["MSW"] }),
    );
    expect(r.present).toBe(false);
  });
});

describe("calculateSia — result projection + mixed populations", () => {
  it("captures each qualifying visit's id / date / discipline / minutes", () => {
    const r = calculateSia(
      input({
        signedEncounters: [
          enc({
            encounterId: "rn-7",
            serviceDate: "2026-06-07",
            discipline: "RN",
            durationMinutes: 45,
          }),
        ],
      }),
    );
    expect(r.qualifyingVisits).toEqual([
      { encounterId: "rn-7", visitDate: "2026-06-07", discipline: "RN", durationMinutes: 45 },
    ]);
  });

  it("counts ONLY qualifying visits amid a mixed population", () => {
    const r = calculateSia(
      input({
        signedEncounters: [
          enc({ encounterId: "ok", discipline: "RN", durationMinutes: 60 }),
          enc({ encounterId: "hha", discipline: "HHA", durationMinutes: 999 }),
          enc({ encounterId: "unsigned", discipline: "MSW", durationMinutes: 999, signed: false }),
          enc({
            encounterId: "old",
            discipline: "RN",
            durationMinutes: 999,
            serviceDate: "2026-06-03",
          }),
        ],
      }),
    );
    expect(r.qualifyingVisits).toHaveLength(1);
    expect(r.qualifyingVisits[0]!.encounterId).toBe("ok");
    expect(r.totalQualifyingMinutes).toBe(60);
    expect(r.paidMinutes).toBe(60);
  });

  it("reports totalQualifyingMinutes as the raw (pre-cap) clinical minutes", () => {
    const r = calculateSia(
      input({
        signedEncounters: [
          enc({ encounterId: "a", serviceDate: DECEASED, durationMinutes: 200 }),
          enc({ encounterId: "b", serviceDate: DECEASED, durationMinutes: 200 }),
        ],
      }),
    );
    expect(r.totalQualifyingMinutes).toBe(400);
    expect(r.paidMinutes).toBe(240);
  });
});

describe("calculateSia — money rounding (CHC hourly, fractional hours)", () => {
  it("rounds a half-cent charge HALF-UP via the line-charge primitive", () => {
    // 90 min = 1.5 hr; rate 6017 ⇒ 9025.5 cents → 9026 (half away from zero).
    const r = calculateSia(
      input({ signedEncounters: [enc({ durationMinutes: 90 })], chcHourlyRateCents: 6_017 }),
    );
    expect(r.siaAddOnCents).toBe(lineChargeCents(1.5, 6_017));
    expect(r.siaAddOnCents).toBe(9_026);
  });

  it("prices a quarter-hour visit exactly", () => {
    // 15 min = 0.25 hr; rate 6000 ⇒ 1500 cents.
    const r = calculateSia(input({ signedEncounters: [enc({ durationMinutes: 15 })] }));
    expect(r.siaAddOnCents).toBe(1_500);
  });
});

describe("calculateSia — multi-day windows + RN/MSW mix", () => {
  it("sums qualifying RN and MSW visits across distinct days in the window", () => {
    const r = calculateSia(
      input({
        signedEncounters: [
          enc({
            encounterId: "rn",
            serviceDate: "2026-06-05",
            discipline: "RN",
            durationMinutes: 60,
          }),
          enc({
            encounterId: "msw",
            serviceDate: "2026-06-08",
            discipline: "MSW",
            durationMinutes: 120,
          }),
        ],
      }),
    );
    expect(r.present).toBe(true);
    expect(r.qualifyingVisits).toHaveLength(2);
    expect(r.paidMinutes).toBe(180);
    expect(r.siaAddOnCents).toBe(lineChargeCents(1, CHC_HOURLY) + lineChargeCents(2, CHC_HOURLY));
  });

  it("counts a qualifying visit on every one of the 7 window days", () => {
    const days = [
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
    ];
    const r = calculateSia(
      input({
        signedEncounters: days.map((d, i) =>
          enc({ encounterId: `v${i}`, serviceDate: d, durationMinutes: 60 }),
        ),
      }),
    );
    expect(r.qualifyingVisits).toHaveLength(7);
    expect(r.paidMinutes).toBe(7 * 60);
  });

  it("a non-firing (no-qualifying) deceased result carries an empty visit list and zero add-on", () => {
    const r = calculateSia(input({ signedEncounters: [enc({ discipline: "HHA" })] }));
    expect(r.present).toBe(false);
    expect(r.qualifyingVisits).toEqual([]);
    expect(r.paidMinutes).toBe(0);
    expect(r.siaAddOnCents).toBe(0);
    expect(r.windowStart).toBe("2026-06-04"); // window still reported for the deceased patient
  });
});
