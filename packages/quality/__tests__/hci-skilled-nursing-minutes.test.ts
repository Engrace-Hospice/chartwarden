// packages/quality/__tests__/hci-skilled-nursing-minutes.test.ts — HCI indicators 8 and 9 on the CMS
// definitions: the pure `skilledNursingMinutesOnRhcDays` reduction and both calculators.
//
//   8 = total skilled-nursing minutes on RHC days ÷ total RHC days (a MEAN, in minutes)
//   9 = weekend skilled-nursing minutes on RHC days ÷ all skilled-nursing minutes on RHC days (a SHARE)
import { describe, expect, it } from "vitest";
import {
  HCI_MINUTES_PER_DAY,
  HCI_THRESHOLDS_v2025,
  computeHciIndicator08,
  computeHciIndicator09,
  skilledNursingMinutesOnRhcDays,
} from "../src/index";

const BASE = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  periodStart: "2026-01-01",
  periodEnd: "2026-02-01",
};

const rhc = (admissionId: string, from: string, to: string) => ({
  admissionId,
  levelOfCare: "routine_home_care",
  from,
  to,
});
const sn = (admissionId: string, serviceDate: string, minutes: number) => ({
  admissionId,
  serviceDate,
  minutes,
});

// 2026-01-01 is a Thursday: 01-03 is a Saturday, 01-04 a Sunday, 01-05 a Monday.
const JAN = { from: "2026-01-01", to: "2026-02-01" };

describe("skilledNursingMinutesOnRhcDays — the reduction", () => {
  it("clips RHC spans to the window before counting days", () => {
    const t = skilledNursingMinutesOnRhcDays(
      [
        rhc("a1", "2025-12-20", "2026-01-04"), // 3 in-window days: 01-01, 01-02, 01-03
        rhc("a2", "2026-01-30", "2026-02-10"), // 2 in-window days: 01-30, 01-31
        rhc("a3", "2025-11-01", "2025-12-01"), // entirely before the window
      ],
      [
        sn("a1", "2025-12-22", 60), // on an RHC day, but outside the window
        sn("a2", "2026-02-02", 60), // on an RHC day, but outside the window
      ],
      JAN,
    );
    expect(t).toEqual({
      totalRhcDays: 5,
      skilledNursingMinutes: 0,
      weekendSkilledNursingMinutes: 0,
    });
  });

  it("counts an admission-day once even when two RHC spans on that admission overlap it", () => {
    const t = skilledNursingMinutesOnRhcDays(
      [rhc("a1", "2026-01-01", "2026-01-06"), rhc("a1", "2026-01-04", "2026-01-08")],
      [sn("a1", "2026-01-05", 30)],
      JAN,
    );
    expect(t.totalRhcDays).toBe(7); // 01-01 .. 01-07, not 5 + 4
    expect(t.skilledNursingMinutes).toBe(30); // the minutes are not double-counted either
  });

  it("counts the same calendar day separately for two different admissions", () => {
    const t = skilledNursingMinutesOnRhcDays(
      [rhc("a1", "2026-01-01", "2026-01-03"), rhc("a2", "2026-01-01", "2026-01-03")],
      [],
      JAN,
    );
    expect(t.totalRhcDays).toBe(4);
  });

  it("an untimed visit (0 recorded minutes) adds no minutes", () => {
    const t = skilledNursingMinutesOnRhcDays(
      [rhc("a1", "2026-01-01", "2026-01-06")],
      [sn("a1", "2026-01-02", 0), sn("a1", "2026-01-03", 0)],
      JAN,
    );
    expect(t).toEqual({
      totalRhcDays: 5,
      skilledNursingMinutes: 0,
      weekendSkilledNursingMinutes: 0,
    });
  });

  it("ignores minutes on non-RHC days — another level of care, or another admission's RHC day", () => {
    const t = skilledNursingMinutesOnRhcDays(
      [
        rhc("a1", "2026-01-01", "2026-01-03"),
        {
          admissionId: "a1",
          levelOfCare: "general_inpatient_care",
          from: "2026-01-03",
          to: "2026-01-06",
        },
      ],
      [
        sn("a1", "2026-01-02", 40), // RHC day — counts
        sn("a1", "2026-01-04", 90), // GIP day — ignored
        sn("a2", "2026-01-02", 50), // a2 has no RHC span — ignored
      ],
      JAN,
    );
    expect(t).toEqual({
      totalRhcDays: 2,
      skilledNursingMinutes: 40,
      weekendSkilledNursingMinutes: 0,
    });
  });

  it("splits the minutes on Saturday and Sunday out of the total", () => {
    const t = skilledNursingMinutesOnRhcDays(
      [rhc("a1", "2026-01-01", "2026-01-12")],
      [
        sn("a1", "2026-01-02", 45), // Friday
        sn("a1", "2026-01-03", 30), // Saturday
        sn("a1", "2026-01-04", 20), // Sunday
        sn("a1", "2026-01-05", 60), // Monday
        sn("a1", "2026-01-10", 10), // Saturday
      ],
      JAN,
    );
    expect(t).toEqual({
      totalRhcDays: 11,
      skilledNursingMinutes: 165,
      weekendSkilledNursingMinutes: 60,
    });
  });
});

describe("computeHciIndicator08 — mean SN minutes per RHC day", () => {
  const threshold = HCI_THRESHOLDS_v2025.indicators.indicator_08;

  it("the cut is 15 minutes per RHC day, higher is better", () => {
    expect(threshold).toMatchObject({ value: 15, direction: "gte" });
  });

  it("keeps CMS's numerator/denominator and decides the verdict on the mean", () => {
    const r = computeHciIndicator08({
      ...BASE,
      totalRhcDays: 300,
      skilledNursingMinutesOnRhcDays: 4520,
      threshold,
    });
    expect(r.numerator).toBe(4520);
    expect(r.denominator).toBe(300);
    expect(r.computationSnapshot.meanSkilledNursingMinutesPerRhcDay).toBeCloseTo(15.0667, 4);
    expect(r.thresholdMet).toBe(true);
    expect(r.bandColor).toBe("green");
  });

  it("stores rate and thresholdValue on one [0, 1] scale — the mean as a share of the day", () => {
    const r = computeHciIndicator08({
      ...BASE,
      totalRhcDays: 300,
      skilledNursingMinutesOnRhcDays: 4520,
      threshold,
    });
    expect(r.rate).toBeCloseTo(4520 / 300 / HCI_MINUTES_PER_DAY, 10);
    expect(r.thresholdValue).toBeCloseTo(15 / HCI_MINUTES_PER_DAY, 10);
    // Same verdict on either scale.
    expect((r.rate ?? 0) >= (r.thresholdValue ?? 1)).toBe(r.thresholdMet);
  });

  it("stays in range for a mean the ratio column could not hold in minutes (≥ 100)", () => {
    const r = computeHciIndicator08({
      ...BASE,
      totalRhcDays: 1,
      skilledNursingMinutesOnRhcDays: 150,
      threshold,
    });
    expect(r.rate).toBeGreaterThan(0);
    expect(r.rate).toBeLessThanOrEqual(1);
    expect(r.computationSnapshot.meanSkilledNursingMinutesPerRhcDay).toBe(150);
  });

  it("is red below the cut", () => {
    const r = computeHciIndicator08({
      ...BASE,
      totalRhcDays: 100,
      skilledNursingMinutesOnRhcDays: 1499,
      threshold,
    });
    expect(r.thresholdMet).toBe(false);
    expect(r.bandColor).toBe("red");
  });

  it("no RHC days is insufficient_n with a null rate (small-N suppression)", () => {
    const r = computeHciIndicator08({
      ...BASE,
      totalRhcDays: 0,
      skilledNursingMinutesOnRhcDays: 0,
      threshold,
    });
    expect(r.rate).toBeNull();
    expect(r.thresholdMet).toBeNull();
    expect(r.bandColor).toBe("insufficient_n");
    expect(r.computationSnapshot.meanSkilledNursingMinutesPerRhcDay).toBeNull();
  });
});

describe("computeHciIndicator09 — weekend share of SN minutes", () => {
  const threshold = HCI_THRESHOLDS_v2025.indicators.indicator_09;

  it("the cut is a 5% weekend share, higher is better", () => {
    expect(threshold).toMatchObject({ value: 0.05, direction: "gte" });
  });

  it("rate = weekend SN minutes / all SN minutes", () => {
    const r = computeHciIndicator09({
      ...BASE,
      totalSkilledNursingMinutes: 165,
      weekendSkilledNursingMinutes: 60,
      threshold,
    });
    expect(r.numerator).toBe(60);
    expect(r.denominator).toBe(165);
    expect(r.rate).toBeCloseTo(60 / 165);
    expect(r.thresholdMet).toBe(true);
  });

  it("no weekend minutes at all misses the cut", () => {
    const r = computeHciIndicator09({
      ...BASE,
      totalSkilledNursingMinutes: 600,
      weekendSkilledNursingMinutes: 0,
      threshold,
    });
    expect(r.rate).toBe(0);
    expect(r.thresholdMet).toBe(false);
    expect(r.bandColor).toBe("red");
  });

  it("no SN minutes on RHC days is insufficient_n (small-N suppression)", () => {
    const r = computeHciIndicator09({
      ...BASE,
      totalSkilledNursingMinutes: 0,
      weekendSkilledNursingMinutes: 0,
      threshold,
    });
    expect(r.rate).toBeNull();
    expect(r.bandColor).toBe("insufficient_n");
  });
});

describe("reduction → calculators, end to end", () => {
  it("feeds indicator 8 and 9 from one reduction", () => {
    const t = skilledNursingMinutesOnRhcDays(
      [rhc("a1", "2026-01-01", "2026-01-11")],
      [sn("a1", "2026-01-03", 60), sn("a1", "2026-01-05", 90)],
      JAN,
    );
    const eight = computeHciIndicator08({
      ...BASE,
      totalRhcDays: t.totalRhcDays,
      skilledNursingMinutesOnRhcDays: t.skilledNursingMinutes,
      threshold: HCI_THRESHOLDS_v2025.indicators.indicator_08,
    });
    const nine = computeHciIndicator09({
      ...BASE,
      totalSkilledNursingMinutes: t.skilledNursingMinutes,
      weekendSkilledNursingMinutes: t.weekendSkilledNursingMinutes,
      threshold: HCI_THRESHOLDS_v2025.indicators.indicator_09,
    });
    expect(eight.computationSnapshot.meanSkilledNursingMinutesPerRhcDay).toBe(15); // 150 / 10
    expect(eight.thresholdMet).toBe(true);
    expect(nine.rate).toBeCloseTo(0.4); // 60 / 150
    expect(nine.thresholdMet).toBe(true);
  });
});
