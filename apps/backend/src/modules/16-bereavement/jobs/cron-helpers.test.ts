import { describe, expect, it } from "vitest";
import { anniversaryLookaheadRange, closeCutoffDate, noResponseStreak } from "./cron-workers";

describe("M16 cron date helpers", () => {
  it("closeCutoffDate is today minus 396 days (death_date <= cutoff means the window elapsed)", () => {
    expect(closeCutoffDate(new Date("2026-10-05T12:00:00Z"))).toBe("2025-09-04");
  });

  it("closeCutoffDate is stable across the UTC day", () => {
    expect(closeCutoffDate(new Date("2026-10-05T00:00:00Z"))).toBe(
      closeCutoffDate(new Date("2026-10-05T23:59:59Z")),
    );
  });

  it("anniversaryLookaheadRange spans today through today + 14 days inclusive", () => {
    expect(anniversaryLookaheadRange(new Date("2026-10-05T06:00:00Z"))).toEqual({
      from: "2026-10-05",
      to: "2026-10-19",
    });
  });
});

describe("noResponseStreak", () => {
  const at = (d: string) => new Date(`2026-10-${d}T00:00:00Z`);

  it("counts only the newest consecutive no_response rows", () => {
    const rows = [
      { outcome: "no_response", contactAt: at("05") },
      { outcome: "no_response", contactAt: at("04") },
      { outcome: "engaged", contactAt: at("03") },
      { outcome: "no_response", contactAt: at("02") },
    ];
    expect(noResponseStreak(rows)).toEqual({ streak: 2, newestStrikeAt: at("05") });
  });

  it("is zero with no newest strike when the newest row got a response or there are no rows", () => {
    expect(noResponseStreak([{ outcome: "engaged", contactAt: at("05") }])).toEqual({
      streak: 0,
      newestStrikeAt: null,
    });
    expect(noResponseStreak([])).toEqual({ streak: 0, newestStrikeAt: null });
  });
});
