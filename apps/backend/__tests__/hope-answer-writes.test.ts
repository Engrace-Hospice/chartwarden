import { describe, expect, it } from "vitest";
import { reconcileWithApplicability } from "../src/modules/10-hope/hope-answer-writes";
import type {
  HopeAnswerMap,
  HopeApplicabilityItemResult,
} from "../src/modules/10-hope/spec/applicability";

// The pure half of a canonical answer patch: bring the proposed answers in line with the applicability verdicts.
const verdicts = (
  entries: Record<string, HopeApplicabilityItemResult["applicability"]>,
): { items: ReadonlyMap<string, HopeApplicabilityItemResult> } => ({
  items: new Map(
    Object.entries(entries).map(([code, applicability]) => [
      code,
      { active: true, applicability } as HopeApplicabilityItemResult,
    ]),
  ),
});

describe("reconcileWithApplicability", () => {
  it("marks a not-applicable item skipped and touches it", () => {
    const proposed: HopeAnswerMap = new Map([["B1", { state: "answered", value: "1" }]]);

    const { answers, touched } = reconcileWithApplicability(
      proposed,
      verdicts({ B1: "not_applicable" }),
      new Set(),
    );

    expect(answers.get("B1")).toEqual({ state: "skipped", value: null });
    expect([...touched]).toEqual(["B1"]);
  });

  it("drops a skip that no longer applies, so the item can be answered again", () => {
    const proposed: HopeAnswerMap = new Map([["B1", { state: "skipped", value: null }]]);

    const { answers, touched } = reconcileWithApplicability(
      proposed,
      verdicts({ B1: "applicable" }),
      new Set(),
    );

    expect(answers.has("B1")).toBe(false);
    expect([...touched]).toEqual(["B1"]);
  });

  it("drops the answer of a pending item", () => {
    const proposed: HopeAnswerMap = new Map([["B1", { state: "answered", value: "1" }]]);

    const { answers, touched } = reconcileWithApplicability(
      proposed,
      verdicts({ B1: "pending" }),
      new Set(["B1"]),
    );

    expect(answers.has("B1")).toBe(false);
    expect([...touched]).toEqual(["B1"]);
  });

  it("leaves an applicable answered item alone and keeps the requested codes touched", () => {
    const proposed: HopeAnswerMap = new Map([["B1", { state: "answered", value: "1" }]]);

    const { answers, touched } = reconcileWithApplicability(
      proposed,
      verdicts({ B1: "applicable" }),
      new Set(["B1"]),
    );

    expect(answers.get("B1")).toEqual({ state: "answered", value: "1" });
    expect([...touched]).toEqual(["B1"]);
  });

  it("modifies neither of its inputs", () => {
    const proposed: HopeAnswerMap = new Map([["B1", { state: "answered", value: "1" }]]);
    const requested = new Set<string>();

    reconcileWithApplicability(proposed, verdicts({ B1: "not_applicable" }), requested);

    expect(proposed.get("B1")).toEqual({ state: "answered", value: "1" });
    expect(requested.size).toBe(0);
  });
});
