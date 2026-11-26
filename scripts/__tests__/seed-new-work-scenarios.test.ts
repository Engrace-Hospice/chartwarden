// The two scenario seeds for the visit-note composer prompts and the V3.2 review states are data-driven. These pin the
// properties the data exists to show, so an edit that quietly turns the alert profile into a quiet one fails here.
import { esasrScorer } from "@chartwarden/assessments";
import { describe, expect, it } from "vitest";
import { COP27_NAMES } from "../db/cop27/names";
import { PATIENTS } from "../db/seed-patients";
import { PROFILES, captureTimes } from "../db/seed-scenario-composer-esas";
import { SCENARIOS } from "../db/seed-scenario-doclens-review-states";

const SEVERE_MIN = 7;
const PROMPT_MIN = 4;
const GROWTH_FLOOR = 1.2; // esas_total_increase_20_in_7d

const itemsOf = (c: object): number[] => Object.values(c) as number[];
const total = (c: object): number => itemsOf(c).reduce((a, b) => a + b, 0);
const profile = (lastName: string) => {
  const p = PROFILES.find((x) => x.lastName === lastName);
  if (!p) throw new Error(`no profile for ${lastName}`);
  return p;
};

describe("composer ESAS-r profiles", () => {
  it("keeps every item an integer from 0 to 10", () => {
    for (const p of PROFILES)
      for (const c of p.captures)
        for (const v of itemsOf(c)) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(10);
        }
  });

  it("gives Whitfield a rising series that reaches a severe item and grows by more than 20%", () => {
    const { captures } = profile("Whitfield");
    const first = captures[0];
    const last = captures[captures.length - 1];
    if (!first || !last) throw new Error("Whitfield needs captures");
    expect(captures.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...itemsOf(last))).toBeGreaterThanOrEqual(SEVERE_MIN);
    expect(total(last) / total(first)).toBeGreaterThan(GROWTH_FLOOR);
  });

  it("scores through the real ESAS-r scorer and names exactly the severe items the profile intends", () => {
    for (const p of PROFILES)
      for (const c of p.captures) {
        const data = { ...c, reportedBy: "patient" as const };
        expect(esasrScorer.score(data)).toBe(total(c));
      }
    const last = (name: string): (typeof PROFILES)[number]["captures"][number] => {
      const capture = profile(name).captures.at(-1);
      if (!capture) throw new Error(`${name} has no captures`);
      return capture;
    };
    expect(esasrScorer.interpret({ ...last("Whitfield"), reportedBy: "patient" })).toMatch(
      /severe \(≥7\): pain, tiredness/,
    );
    expect(esasrScorer.interpret({ ...last("Delgado"), reportedBy: "patient" })).not.toMatch(
      /severe/,
    );
    expect(esasrScorer.interpret({ ...last("Yarbrough"), reportedBy: "patient" })).not.toMatch(
      /severe/,
    );
  });

  it("gives Okonkwo several severe items on one capture", () => {
    const [capture] = profile("Okonkwo").captures;
    expect(itemsOf(capture ?? {}).filter((v) => v >= SEVERE_MIN).length).toBeGreaterThanOrEqual(3);
  });

  it("gives Delgado the prompt benchmark without an alert", () => {
    const [capture] = profile("Delgado").captures;
    const max = Math.max(...itemsOf(capture ?? {}));
    expect(max).toBeGreaterThanOrEqual(PROMPT_MIN);
    expect(max).toBeLessThan(SEVERE_MIN);
  });

  it("gives Yarbrough no prompt and no alert", () => {
    const [capture] = profile("Yarbrough").captures;
    expect(Math.max(...itemsOf(capture ?? {}))).toBeLessThan(PROMPT_MIN);
  });
});

describe("captureTimes", () => {
  const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
  const DAY = 86_400_000;
  const MINUTE = 60_000;

  it("spreads captures over past days, oldest first, none in the future", () => {
    const times = captureTimes(3, NOW, NOW - 30 * DAY);
    expect(times).toHaveLength(3);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[2]).toBeLessThan(NOW);
    expect((times[2] ?? 0) - (times[0] ?? 0)).toBe(4 * DAY);
  });

  it("never places a capture before the admission activation and keeps them strictly increasing", () => {
    const activated = NOW - 30 * MINUTE;
    const times = captureTimes(3, NOW, activated);
    expect(times[0]).toBeGreaterThan(activated);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1] ?? 0);
  });
});

describe("DocLens review-state scenarios", () => {
  const surnames = SCENARIOS.map((s) => s.last.toLowerCase());
  const takenSurnames = [
    ...PATIENTS.map((p) => p.lastName.toLowerCase()),
    ...Object.values(COP27_NAMES).map(([, last]) => last.toLowerCase()),
    "doclens",
  ];

  it("uses unique MRNs that leave the original demo patient alone", () => {
    const mrns = SCENARIOS.map((s) => s.mrn);
    expect(new Set(mrns).size).toBe(mrns.length);
    expect(mrns).not.toContain("DOCLENS-DEMO-0001");
  });

  it("uses surnames no other seeded patient has, so a last-name lookup stays unambiguous", () => {
    expect(new Set(surnames).size).toBe(surnames.length);
    for (const name of surnames) expect(takenSurnames).not.toContain(name);
  });

  it("covers a conflict: two pages that disagree on one field", () => {
    const s = SCENARIOS.find((x) => x.state === "conflicting sources");
    const phones = s?.pages.flatMap((p) =>
      p.candidates.filter((c) => c.fieldPath === "patient.phoneHome").map((c) => c.value),
    );
    expect(new Set(phones).size).toBeGreaterThan(1);
  });

  it("covers a wrong-patient page resolved as another patient, and an unresolved identity mismatch", () => {
    expect(
      SCENARIOS.some((s) => s.pages.some((p) => p.otherPatient && p.identity === "mismatch")),
    ).toBe(true);
    expect(
      SCENARIOS.some(
        (s) => s.batchIdentity === "mismatch" && s.pages.every((p) => !p.otherPatient),
      ),
    ).toBe(true);
  });

  it("covers Part 2: a detected batch whose flagged values are marked", () => {
    const s = SCENARIOS.find((x) => x.sudDetected);
    expect(s?.pages.some((p) => p.candidates.some((c) => c.sud))).toBe(true);
  });

  it("covers a vision disagreement and a low-confidence value", () => {
    const all = SCENARIOS.flatMap((s) => s.pages.flatMap((p) => p.candidates));
    expect(all.some((c) => c.visionNote)).toBe(true);
    expect(all.some((c) => (c.confidence ?? 1) < 0.6)).toBe(true);
  });
});
