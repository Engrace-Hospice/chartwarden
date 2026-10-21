// packages/quality/__tests__/hope-acceptance-availability.test.ts — F-058 (#150).
//
// `hope_submission_acceptance_rate` is the §1.3 APU-penalty signal, and its denominator counts
// assessments on batches with a TERMINAL iQIES posture. Nothing in this codebase has ever transmitted a
// batch — `@chartwarden/iqies-client` ships only its deny-stub adapter, so `submitBatch` has no caller — so
// the denominator is 0 on every deployment and `ratioResult` suppressed the measure as `insufficient_n`.
//
// Suppression was the right SHAPE and the wrong LABEL. `insufficient_n` means "we counted, and there were
// too few to report"; the quality hub renders it "Suppressed (low N)", which tells a surveyor the agency
// is small when the truth is that this deployment cannot submit at all. Same distinction
// `HCI_UNAVAILABLE_INDICATORS` draws, and the assertions below are about keeping the two apart rather
// than about any arithmetic.
import { describe, expect, it } from "vitest";
import {
  computeHopeSubmissionAcceptanceRate,
  isDataUnavailable,
  unavailableReasonOf,
} from "../src/index";

const THRESHOLD = { value: 0.9, direction: "gte" } as const;

describe("F-058 — hope_submission_acceptance_rate availability", () => {
  it("scores normally once batches have actually been transmitted", () => {
    const r = computeHopeSubmissionAcceptanceRate({
      organizationId: "org",
      providerEntityId: "pe",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      submissions: 20,
      acceptedSubmissions: 19,
      queuedSubmissions: 0,
      threshold: THRESHOLD,
    });
    expect(r.rate).toBeCloseTo(0.95);
    expect(isDataUnavailable(r)).toBe(false);
  });

  it("declares UNAVAILABLE — not low-N — when batches are queued and none was ever transmitted", () => {
    const r = computeHopeSubmissionAcceptanceRate({
      organizationId: "org",
      providerEntityId: "pe",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      submissions: 0,
      acceptedSubmissions: 0,
      queuedSubmissions: 4,
      threshold: THRESHOLD,
    });
    expect(r.rate).toBeNull();
    expect(r.thresholdMet).toBeNull();
    expect(isDataUnavailable(r)).toBe(true);
    expect(unavailableReasonOf(r.computationSnapshot)).toMatch(/has ever been transmitted/i);
  });

  it("still says low-N when the agency genuinely has nothing in flight", () => {
    // The branch is on EVIDENCE, not on a build flag: with no queued batches either, there is nothing to
    // distinguish this agency from one that simply had no assessments to submit, and `insufficient_n` is
    // the honest label.
    const r = computeHopeSubmissionAcceptanceRate({
      organizationId: "org",
      providerEntityId: "pe",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      submissions: 0,
      acceptedSubmissions: 0,
      queuedSubmissions: 0,
      threshold: THRESHOLD,
    });
    expect(r.bandColor).toBe("insufficient_n");
    expect(isDataUnavailable(r)).toBe(false);
    expect(unavailableReasonOf(r.computationSnapshot)).toBeNull();
  });

  it("never scores an unavailable measure — 0/0, and the queued count rides in the snapshot", () => {
    // The failure to avoid is a measure that cannot be computed presenting as one the agency MISSED.
    const r = computeHopeSubmissionAcceptanceRate({
      organizationId: "org",
      providerEntityId: "pe",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      submissions: 0,
      acceptedSubmissions: 0,
      queuedSubmissions: 12,
      threshold: THRESHOLD,
    });
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(0);
    expect(r.bandColor).toBe("insufficient_n");
    expect(r.computationSnapshot.queuedSubmissions).toBe(12);
  });

  it("keeps the pre-F-058 behaviour for a caller that supplies no queued count", () => {
    const r = computeHopeSubmissionAcceptanceRate({
      organizationId: "org",
      providerEntityId: "pe",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      submissions: 0,
      acceptedSubmissions: 0,
      threshold: THRESHOLD,
    });
    expect(isDataUnavailable(r)).toBe(false);
  });
});
