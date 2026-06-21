// @wardenx/types — M2-T04 unit tests (M2 spec §2.2.4/D1 SESSION_POLICY, §4.3.1/D9
// STEP_UP_POLICY).
//
// These constants are the platform floor that M2's step-up route/resolver, M3's
// `step_up_recent` predicate, and the UI screen-lock all read. The exact values are
// contractual (e.g. M3 defaults to the 300s freshness window), so they are locked here.
import { describe, expect, it } from "vitest";
import {
  SESSION_POLICY,
  type SessionClassName,
  STEP_UP_POLICY,
  type StepUpFactor,
} from "../src/index";

const MIN = 60;
const HR = 60 * 60;

describe("STEP_UP_POLICY (§4.3.1 / D9)", () => {
  it("declares WebAuthn + TOTP as the qualifying floor — SMS intentionally absent", () => {
    expect([...STEP_UP_POLICY.qualifyingFactors].sort()).toEqual(["totp", "webauthn"]);
    expect(STEP_UP_POLICY.qualifyingFactors).not.toContain<StepUpFactor>("sms");
  });

  it("uses the 300s default freshness window matching M3's step_up_recent", () => {
    expect(STEP_UP_POLICY.defaultMaxAgeSec).toBe(300);
  });

  it("locks out after 3 consecutive failures within 60s (§4.4.1)", () => {
    expect(STEP_UP_POLICY.lockoutThreshold).toBe(3);
    expect(STEP_UP_POLICY.lockoutWindowSec).toBe(60);
  });

  it("is frozen (a single immutable platform floor)", () => {
    expect(Object.isFrozen(STEP_UP_POLICY)).toBe(true);
  });
});

describe("SESSION_POLICY (§2.2.4 / D1)", () => {
  it("screen-locks at 5 min (soft re-auth, session stays alive)", () => {
    expect(SESSION_POLICY.screenLockSec).toBe(5 * MIN);
  });

  it("screen-lock applies to staff + auditor only (not the magic-link classes)", () => {
    expect([...SESSION_POLICY.screenLockClasses].sort()).toEqual(["auditor", "staff"]);
    expect(SESSION_POLICY.screenLockClasses).not.toContain<SessionClassName>("external_collaborator");
    expect(SESSION_POLICY.screenLockClasses).not.toContain<SessionClassName>("funeral_home");
  });

  it("staff: 15-min idle, 8-hr work / 24-hr hard absolute", () => {
    expect(SESSION_POLICY.byClass.staff.idleSec).toBe(15 * MIN);
    expect(SESSION_POLICY.byClass.staff.absoluteSec).toBe(8 * HR);
    expect(SESSION_POLICY.byClass.staff.absoluteHardSec).toBe(24 * HR);
  });

  it("auditor: 10-min idle, absolute bounded by engagement_end (null)", () => {
    expect(SESSION_POLICY.byClass.auditor.idleSec).toBe(10 * MIN);
    expect(SESSION_POLICY.byClass.auditor.absoluteSec).toBeNull();
  });

  it("external_collaborator: 15-min idle default, 8-hr absolute default", () => {
    expect(SESSION_POLICY.byClass.external_collaborator.idleSec).toBe(15 * MIN);
    expect(SESSION_POLICY.byClass.external_collaborator.absoluteSec).toBe(8 * HR);
  });

  it("funeral_home: 15-min idle, 72-hr absolute default", () => {
    expect(SESSION_POLICY.byClass.funeral_home.idleSec).toBe(15 * MIN);
    expect(SESSION_POLICY.byClass.funeral_home.absoluteSec).toBe(72 * HR);
  });

  it("covers exactly the four session classes", () => {
    const classes: SessionClassName[] = ["staff", "auditor", "external_collaborator", "funeral_home"];
    expect(Object.keys(SESSION_POLICY.byClass).sort()).toEqual([...classes].sort());
  });
});
