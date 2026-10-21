// @chartwarden/dosespot — §2.4 EPCS architecture (M12-T05). Pure-domain unit tests.
//
// Covers the deny-stub (`dosespot.epcs` OFF in Phase 1), the per-tenant cert gate (D18 / §1311.300), the
// IAL2 status tracker + expiry alerts (§1311.115), the DEA schedule-authorization check (§1311.120), and the
// 60-second 2FA signing-session submachine (§1311.116).
import { describe, expect, it } from "vitest";
import {
  // cert gate + flag
  DEFAULT_DOSESPOT_EPCS_FLAGS,
  type DoseSpotEpcsFlags,
  // signing session
  EPCS_2FA_WINDOW_SECONDS,
  type EpcsSigningGateFacts,
  IAL2_EXPIRY_CRITICAL_DAYS,
  // ial2
  IAL2_EXPIRY_WARN_DAYS,
  assertDeaScheduleAuthorized,
  assertEpcsCertified,
  assertEpcsFeatureEnabled,
  assertIal2Verified,
  classifyIal2ExpiryStage,
  computeDaysUntilIal2Expiry,
  evaluateEpcsCertGate,
  evaluateEpcsSigningGate,
  // dea
  isDeaScheduleAuthorized,
  isIal2Verified,
  planEpcsSigningSession,
  planIal2ExpiryAlert,
  validateSecondFactor,
} from "../src/epcs";

const ON: DoseSpotEpcsFlags = { epcs: true };
const OFF: DoseSpotEpcsFlags = { epcs: false };

const passingFacts: EpcsSigningGateFacts = {
  certStatus: "certified",
  ial2Status: "verified",
  authorizedSchedules: ["II", "III", "IV", "V"],
  schedule: "II",
};

// ── §2.4 D18 — the Phase-1 deny-stub: the `dosespot.epcs` flag is OFF ───────────────────────────────────
describe("§2.4 D18 EPCS feature flag (Phase-1 deny-stub)", () => {
  it("defaults the platform flag to OFF", () => {
    expect(DEFAULT_DOSESPOT_EPCS_FLAGS.epcs).toBe(false);
  });

  it("assertEpcsFeatureEnabled throws EPCS_FEATURE_DISABLED when OFF", () => {
    expect(() => assertEpcsFeatureEnabled(OFF)).toThrowError(
      expect.objectContaining({ code: "EPCS_FEATURE_DISABLED", statusCode: 403 }),
    );
  });

  it("assertEpcsFeatureEnabled passes when ON", () => {
    expect(() => assertEpcsFeatureEnabled(ON)).not.toThrow();
  });

  it("planEpcsSigningSession is a deny-stub under the default (OFF) flag even when every other gate passes", () => {
    expect(() =>
      planEpcsSigningSession({
        flags: DEFAULT_DOSESPOT_EPCS_FLAGS,
        facts: passingFacts,
        nonceDigest: "deadbeef",
        startedAtIso: "2026-06-22T12:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_FEATURE_DISABLED" }));
  });
});

// ── §2.4 D18 / §1311.300 — the per-tenant certification gate ────────────────────────────────────────────
describe("§1311.300 cert gate", () => {
  it("permits a certified tenant", () => {
    expect(evaluateEpcsCertGate("certified")).toEqual({ permitted: true });
    expect(() => assertEpcsCertified("certified")).not.toThrow();
  });

  it("blocks not_certified and audit_in_progress with EPCS_NOT_CERTIFIED", () => {
    for (const status of ["not_certified", "audit_in_progress"] as const) {
      expect(evaluateEpcsCertGate(status)).toEqual({
        permitted: false,
        code: "EPCS_NOT_CERTIFIED",
        revoked: false,
      });
      expect(() => assertEpcsCertified(status)).toThrowError(
        expect.objectContaining({ code: "EPCS_NOT_CERTIFIED", statusCode: 403 }),
      );
    }
  });

  it("blocks revoked with EPCS_CERTIFICATION_REVOKED and the revoked flag", () => {
    expect(evaluateEpcsCertGate("revoked")).toEqual({
      permitted: false,
      code: "EPCS_CERTIFICATION_REVOKED",
      revoked: true,
    });
    expect(() => assertEpcsCertified("revoked")).toThrowError(
      expect.objectContaining({ code: "EPCS_CERTIFICATION_REVOKED" }),
    );
  });
});

// ── §2.4 §1311.115 — IAL2 status tracker + expiry alerts ────────────────────────────────────────────────
describe("§1311.115 IAL2 tracker", () => {
  it("only 'verified' is verified", () => {
    expect(isIal2Verified("verified")).toBe(true);
    for (const s of ["not_started", "in_progress", "expired", "revoked"] as const) {
      expect(isIal2Verified(s)).toBe(false);
    }
  });

  it("assertIal2Verified throws EPCS_PRESCRIBER_NOT_VERIFIED for a non-verified status", () => {
    expect(() => assertIal2Verified("expired")).toThrowError(
      expect.objectContaining({ code: "EPCS_PRESCRIBER_NOT_VERIFIED", statusCode: 403 }),
    );
    expect(() => assertIal2Verified("verified")).not.toThrow();
  });

  it("computes whole days until expiry (floor; negative once past)", () => {
    expect(computeDaysUntilIal2Expiry("2026-07-22T00:00:00.000Z", "2026-06-22T00:00:00.000Z")).toBe(
      30,
    );
    expect(computeDaysUntilIal2Expiry("2026-06-21T00:00:00.000Z", "2026-06-22T00:00:00.000Z")).toBe(
      -1,
    );
  });

  it("classifies the expiry stage at the 30/7 day boundaries", () => {
    expect(classifyIal2ExpiryStage(IAL2_EXPIRY_WARN_DAYS + 1)).toBe("none");
    expect(classifyIal2ExpiryStage(IAL2_EXPIRY_WARN_DAYS)).toBe("warn");
    expect(classifyIal2ExpiryStage(IAL2_EXPIRY_CRITICAL_DAYS + 1)).toBe("warn");
    expect(classifyIal2ExpiryStage(IAL2_EXPIRY_CRITICAL_DAYS)).toBe("critical");
    expect(classifyIal2ExpiryStage(-3)).toBe("critical");
  });

  it("plans the staged outbox + M36 alert effects", () => {
    expect(planIal2ExpiryAlert("none")).toEqual([]);
    expect(planIal2ExpiryAlert("warn")).toEqual([
      { kind: "outbox", event: "m12.ial2_expiring_warn" },
      { kind: "alert", alert: "ial2.expiring_warn" },
    ]);
    expect(planIal2ExpiryAlert("critical")).toEqual([
      { kind: "outbox", event: "m12.ial2_expiring_warn" },
      { kind: "alert", alert: "ial2.expiring_critical" },
    ]);
  });
});

// ── §2.4 §1311.120 — DEA schedule authorization ─────────────────────────────────────────────────────────
describe("§1311.120 DEA schedule authorization", () => {
  it("checks membership in the prescriber's authorized schedules", () => {
    expect(isDeaScheduleAuthorized(["II", "III"], "II")).toBe(true);
    expect(isDeaScheduleAuthorized(["II", "III"], "IV")).toBe(false);
  });

  it("assertDeaScheduleAuthorized throws DEA_SCHEDULE_NOT_AUTHORIZED for a missing schedule", () => {
    expect(() => assertDeaScheduleAuthorized(["II", "III"], "IV")).toThrowError(
      expect.objectContaining({ code: "DEA_SCHEDULE_NOT_AUTHORIZED", statusCode: 403 }),
    );
    expect(() => assertDeaScheduleAuthorized(["II", "III"], "III")).not.toThrow();
  });
});

// ── §2.4 §1311.116 — the gate ladder ────────────────────────────────────────────────────────────────────
describe("§1311.116 evaluateEpcsSigningGate (ladder ordering)", () => {
  it("flag is the outermost gate", () => {
    expect(evaluateEpcsSigningGate(OFF, passingFacts)).toEqual({
      ok: false,
      code: "EPCS_FEATURE_DISABLED",
    });
  });

  it("cert gate is checked before IAL2 and DEA", () => {
    expect(
      evaluateEpcsSigningGate(ON, {
        ...passingFacts,
        certStatus: "not_certified",
        ial2Status: "expired",
      }),
    ).toEqual({ ok: false, code: "EPCS_NOT_CERTIFIED" });
  });

  it("IAL2 is checked before DEA", () => {
    expect(
      evaluateEpcsSigningGate(ON, {
        ...passingFacts,
        ial2Status: "expired",
        authorizedSchedules: [],
      }),
    ).toEqual({ ok: false, code: "EPCS_PRESCRIBER_NOT_VERIFIED" });
  });

  it("DEA schedule is the innermost gate", () => {
    expect(
      evaluateEpcsSigningGate(ON, { ...passingFacts, schedule: "IV", authorizedSchedules: ["II"] }),
    ).toEqual({ ok: false, code: "DEA_SCHEDULE_NOT_AUTHORIZED" });
  });

  it("passes when every gate is satisfied", () => {
    expect(evaluateEpcsSigningGate(ON, passingFacts)).toEqual({ ok: true });
  });
});

// ── §2.4 §1311.116 — open the 60s signing session (flag forced ON) ──────────────────────────────────────
describe("§1311.116 planEpcsSigningSession", () => {
  it("mints the epcs_signing_attempt write with expires_at = started_at + 60s", () => {
    const plan = planEpcsSigningSession({
      flags: ON,
      facts: passingFacts,
      nonceDigest: "abc123",
      startedAtIso: "2026-06-22T12:00:00.000Z",
    });
    expect(plan.expiresAt).toBe("2026-06-22T12:01:00.000Z");
    expect(plan.effects).toEqual([
      {
        kind: "write_signing_attempt",
        nonceDigest: "abc123",
        startedAt: "2026-06-22T12:00:00.000Z",
        expiresAt: "2026-06-22T12:01:00.000Z",
      },
      { kind: "audit" },
    ]);
  });

  it("uses the canonical 60-second window", () => {
    expect(EPCS_2FA_WINDOW_SECONDS).toBe(60);
  });

  it("rethrows the first failing gate code (cert) even with the flag ON", () => {
    expect(() =>
      planEpcsSigningSession({
        flags: ON,
        facts: { ...passingFacts, certStatus: "revoked" },
        nonceDigest: "abc123",
        startedAtIso: "2026-06-22T12:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_CERTIFICATION_REVOKED" }));
  });
});

// ── §2.4 §1311.116 — complete the second factor (steps 6–7) ─────────────────────────────────────────────
describe("§1311.116 validateSecondFactor", () => {
  const base = {
    currentOutcome: "pending" as const,
    startedAtIso: "2026-06-22T12:00:00.000Z",
    expiresAtIso: "2026-06-22T12:01:00.000Z",
    providedNonceDigest: "n1",
    expectedNonceDigest: "n1",
    secondFactorType: "totp" as const,
    proofValid: true,
  };

  it("succeeds with a valid proof inside the window and records the second-factor type", () => {
    const r = validateSecondFactor({ ...base, nowIso: "2026-06-22T12:00:30.000Z" });
    expect(r.outcome).toBe("succeeded");
    expect(r.effects).toEqual([
      { kind: "update_signing_attempt", outcome: "succeeded", secondFactorType: "totp" },
      { kind: "audit" },
    ]);
  });

  it("records failed_timeout past the 60s window and drives the 2FA-failed outbox event", () => {
    const r = validateSecondFactor({ ...base, nowIso: "2026-06-22T12:01:00.001Z" });
    expect(r.outcome).toBe("failed_timeout");
    expect(r.effects).toContainEqual({ kind: "update_signing_attempt", outcome: "failed_timeout" });
    expect(r.effects).toContainEqual({
      kind: "outbox",
      event: "m12.medication_order.epcs_2fa_failed",
    });
  });

  it("records failed_validation for a present-but-invalid proof inside the window", () => {
    const r = validateSecondFactor({
      ...base,
      nowIso: "2026-06-22T12:00:30.000Z",
      proofValid: false,
    });
    expect(r.outcome).toBe("failed_validation");
    expect(r.effects).toContainEqual({
      kind: "update_signing_attempt",
      outcome: "failed_validation",
    });
  });

  it("throws EPCS_SIGNING_ATTEMPT_NOT_PENDING when the attempt is already resolved", () => {
    expect(() =>
      validateSecondFactor({
        ...base,
        currentOutcome: "succeeded",
        nowIso: "2026-06-22T12:00:30.000Z",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "EPCS_SIGNING_ATTEMPT_NOT_PENDING", statusCode: 409 }),
    );
  });

  it("throws EPCS_2FA_NONCE_MISMATCH when the returned nonce does not match", () => {
    expect(() =>
      validateSecondFactor({
        ...base,
        providedNonceDigest: "wrong",
        nowIso: "2026-06-22T12:00:30.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "EPCS_2FA_NONCE_MISMATCH", statusCode: 422 }));
  });
});
