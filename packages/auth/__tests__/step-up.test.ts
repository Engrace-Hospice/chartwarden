/**
 * M3-T07 — the `step_up_recent` freshness/factor decision (`isStepUpRecent`, M3 spec §4.2.1).
 *
 * The pure core the boot-registered `step_up_recent` predicate delegates to. Every branch must
 * FAIL CLOSED: no step-up, a non-qualifying factor, a future-dated stamp, or an expired window
 * all deny. The platform floor `STEP_UP_POLICY` (webauthn/totp, 300s) is the baseline.
 */
import { STEP_UP_POLICY, type SessionStepUpFields } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { isStepUpRecent } from "../src/index";

const NOW = 1_700_000_000_000; // fixed epoch ms
const at = (ageSec: number): Date => new Date(NOW - ageSec * 1000);

function state(over: Partial<SessionStepUpFields> = {}): SessionStepUpFields {
  return { lastStepUpAt: at(10), lastStepUpFactor: "totp", ...over };
}

describe("isStepUpRecent", () => {
  it("allows a recent step-up with a qualifying factor", () => {
    expect(
      isStepUpRecent(
        state({ lastStepUpAt: at(100), lastStepUpFactor: "webauthn" }),
        STEP_UP_POLICY,
        NOW,
      ),
    ).toBe(true);
    expect(
      isStepUpRecent(
        state({ lastStepUpAt: at(100), lastStepUpFactor: "totp" }),
        STEP_UP_POLICY,
        NOW,
      ),
    ).toBe(true);
  });

  it("denies a null state, a never-stepped-up session, or a missing factor", () => {
    expect(isStepUpRecent(null, STEP_UP_POLICY, NOW)).toBe(false);
    expect(isStepUpRecent(state({ lastStepUpAt: null }), STEP_UP_POLICY, NOW)).toBe(false);
    expect(isStepUpRecent(state({ lastStepUpFactor: null }), STEP_UP_POLICY, NOW)).toBe(false);
  });

  it("denies a non-qualifying factor (SMS is below the floor)", () => {
    expect(isStepUpRecent(state({ lastStepUpFactor: "sms" }), STEP_UP_POLICY, NOW)).toBe(false);
  });

  it("denies once the freshness window has elapsed (boundary-inclusive)", () => {
    const maxSec = STEP_UP_POLICY.defaultMaxAgeSec;
    expect(isStepUpRecent(state({ lastStepUpAt: at(maxSec) }), STEP_UP_POLICY, NOW)).toBe(true); // exactly at edge
    expect(isStepUpRecent(state({ lastStepUpAt: at(maxSec + 1) }), STEP_UP_POLICY, NOW)).toBe(
      false,
    );
  });

  it("denies a future-dated stamp (clock skew → fail closed)", () => {
    expect(isStepUpRecent(state({ lastStepUpAt: new Date(NOW + 5000) }), STEP_UP_POLICY, NOW)).toBe(
      false,
    );
  });
});
