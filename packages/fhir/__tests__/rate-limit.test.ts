// Module 28 — §D16 / W-FHIR-08 tier-based rate-limit ceiling (M28-T03).
//
// W-FHIR-08: a tier-2 client (ceiling 10 RPS) sending a burst of 25 in one second gets the first 10
// admitted and 11–25 throttled with `Retry-After: 1`; the budget refills at the next window. These tests
// walk exactly that burst plus the fail-closed edges (non-positive / non-integer ceiling admits nothing).

import { describe, expect, it } from "vitest";

import {
  FHIR_RATE_LIMIT_RETRY_AFTER_SECONDS,
  fhirRateLimitDecision,
  fhirTierCeilingRps,
} from "../src/rate-limit/sliding-window";

const NOW = 1_800_000_000_500; // mid-window (…500ms) so retry-after computes to the next boundary

describe("§D16 tier ceilings", () => {
  it("resolves the platform floor per tier", () => {
    expect(fhirTierCeilingRps("tier-1")).toBe(100);
    expect(fhirTierCeilingRps("tier-2")).toBe(10);
    expect(fhirTierCeilingRps("tier-3")).toBe(1);
  });
});

describe("§W-FHIR-08 sliding-window decision", () => {
  it("admits the first 10 of a tier-2 burst and throttles 11–25", () => {
    const ceilingRps = fhirTierCeilingRps("tier-2");
    for (let priorCountInWindow = 0; priorCountInWindow < 25; priorCountInWindow++) {
      const decision = fhirRateLimitDecision({ ceilingRps, priorCountInWindow, nowMs: NOW });
      if (priorCountInWindow < 10) {
        expect(decision.allowed).toBe(true); // this is the (priorCount+1)-th request: 1..10
      } else {
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
          expect(decision.retryAfterSeconds).toBe(FHIR_RATE_LIMIT_RETRY_AFTER_SECONDS);
          expect(decision.resetAtMs).toBe(1_800_000_001_000); // the next 1s boundary
        }
      }
    }
  });

  it("fails closed on a non-positive or non-integer ceiling", () => {
    expect(fhirRateLimitDecision({ ceilingRps: 0, priorCountInWindow: 0, nowMs: NOW }).allowed).toBe(false);
    expect(fhirRateLimitDecision({ ceilingRps: -5, priorCountInWindow: 0, nowMs: NOW }).allowed).toBe(false);
    expect(fhirRateLimitDecision({ ceilingRps: 1.5, priorCountInWindow: 0, nowMs: NOW }).allowed).toBe(false);
  });

  it("advertises Retry-After of at least 1 second", () => {
    const decision = fhirRateLimitDecision({ ceilingRps: 1, priorCountInWindow: 5, nowMs: NOW });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
