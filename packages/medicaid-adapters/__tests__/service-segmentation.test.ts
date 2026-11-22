import { describe, expect, it } from "vitest";
import { segmentHospiceServiceWindow } from "../src/service-segmentation";

const fact = (
  dimension: "loc" | "coverage" | "program" | "rate" | "policy",
  from: string,
  to: string,
  identity = `${dimension}-1`,
) => ({ dimension, from, to, identity, status: "verified" as const, sourceRecordId: identity });

const allFacts = (from: string, to: string) => [
  fact("loc", from, to),
  fact("coverage", from, to),
  fact("program", from, to),
  fact("rate", from, to),
  fact("policy", from, to),
];
const dailyQuantities = (from: string, to: string) => {
  const result = new Map();
  for (
    let day = Date.parse(`${from}T00:00:00.000Z`);
    day <= Date.parse(`${to}T00:00:00.000Z`);
    day += 86_400_000
  ) {
    const date = new Date(day).toISOString().slice(0, 10);
    result.set(date, {
      kind: "daily" as const,
      units: 1,
      sourceRecordId: `q-${date}`,
      verified: true,
    });
  }
  return result;
};

describe("segmentHospiceServiceWindow", () => {
  it.each([
    ["single day", "2026-02-01", "2026-02-01", []],
    ["contiguous month", "2026-02-01", "2026-02-28", []],
    [
      "September fiscal boundary",
      "2026-09-30",
      "2026-10-01",
      [
        fact("rate", "2026-09-30", "2026-09-30", "fy26"),
        fact("rate", "2026-10-01", "2026-10-01", "fy27"),
      ],
    ],
    [
      "RHC day 60 bucket",
      "2026-11-29",
      "2026-11-30",
      [
        fact("rate", "2026-11-29", "2026-11-29", "rhc-1-60"),
        fact("rate", "2026-11-30", "2026-11-30", "rhc-61-plus"),
      ],
    ],
  ] as const)("splits %s at evidence boundaries", (_label, from, to, rateFacts) => {
    const facts = allFacts(from, to)
      .filter((entry) => entry.dimension !== "rate")
      .concat(rateFacts.length ? rateFacts : [fact("rate", from, to)]);
    const segments = segmentHospiceServiceWindow({
      from,
      to,
      facts,
      quantityByDate: dailyQuantities(from, to),
    });
    expect(segments.map(({ from: start, to: end }) => [start, end])).toHaveLength(
      rateFacts.length ? 2 : 1,
    );
    expect(segments.flatMap((segment) => segment.reasonCodes)).toEqual([]);
  });

  it("splits at LOC, payer and rate changes without losing or duplicating days", () => {
    const from = "2026-03-01";
    const to = "2026-03-05";
    const segments = segmentHospiceServiceWindow({
      from,
      to,
      facts: [
        fact("loc", from, "2026-03-02", "RHC"),
        fact("loc", "2026-03-03", to, "GIP"),
        fact("coverage", from, "2026-03-02", "coverage-a"),
        fact("coverage", "2026-03-03", to, "coverage-b"),
        fact("program", from, "2026-03-02", "ffs"),
        fact("program", "2026-03-03", to, "eocco"),
        fact("rate", from, "2026-03-01", "rate-a"),
        fact("rate", "2026-03-02", to, "rate-b"),
        fact("policy", from, to),
      ],
      quantityByDate: new Map(
        Array.from({ length: 5 }, (_, index) => {
          const date = `2026-03-0${index + 1}`;
          return [
            date,
            { kind: "daily" as const, units: 1, sourceRecordId: `q-${date}`, verified: true },
          ] as const;
        }),
      ),
    });
    expect(segments.map(({ from: start, to: end }) => [start, end])).toEqual([
      ["2026-03-01", "2026-03-01"],
      ["2026-03-02", "2026-03-02"],
      ["2026-03-03", "2026-03-05"],
    ]);
    expect(
      segments.reduce(
        (sum, segment) => sum + (segment.quantity?.kind === "daily" ? segment.quantity.units : 0),
        0,
      ),
    ).toBe(5);
    expect(segments.every((segment) => segment.priceable)).toBe(true);
  });

  it("keeps exact clinical minutes and requires evidence for every covered day", () => {
    const from = "2026-04-01";
    const to = "2026-04-02";
    const base = allFacts(from, to);
    const complete = segmentHospiceServiceWindow({
      from,
      to,
      facts: base,
      quantityByDate: new Map([
        [from, { kind: "hourly", minutes: 90, sourceRecordId: "hours-1", verified: true }],
        [to, { kind: "hourly", minutes: 75, sourceRecordId: "hours-2", verified: true }],
      ]),
    });
    expect(complete).toEqual([
      expect.objectContaining({
        quantity: expect.objectContaining({ kind: "hourly", minutes: 165, verified: true }),
        priceable: true,
      }),
    ]);
    const missing = segmentHospiceServiceWindow({
      from,
      to,
      facts: base,
      quantityByDate: new Map([
        [from, { kind: "hourly", minutes: 90, sourceRecordId: "hours-1", verified: true }],
      ]),
    });
    expect(missing[0]?.reasonCodes).toContain("CLINICAL_QUANTITY_UNRESOLVED");
    expect(missing[0]?.priceable).toBe(false);
  });

  it("fails closed on missing payer-policy boundaries, missing facts and conflicting overlap", () => {
    const from = "2026-05-01";
    const to = "2026-05-02";
    const facts = [...allFacts(from, to), fact("program", from, to, "conflicting-program")];
    const segments = segmentHospiceServiceWindow({
      from,
      to,
      facts: facts.filter((entry) => entry.dimension !== "rate"),
      quantityByDate: new Map([
        [from, { kind: "daily", units: 1, sourceRecordId: "q", verified: false }],
      ]),
      unknownPolicyBoundaries: true,
    });
    expect(segments[0]?.reasonCodes).toEqual(
      expect.arrayContaining([
        "AMBIGUOUS_PROGRAM_FACT",
        "MISSING_RATE_FACT",
        "POLICY_BOUNDARIES_UNQUALIFIED",
        "CLINICAL_QUANTITY_UNVERIFIED",
      ]),
    );
    expect(segments[0]?.priceable).toBe(false);
  });
});
