// apps/backend/__tests__/step-up-policy.test.ts — M2-T05 unit tests (M2 spec §4.3.2, §4.4.2;
// W-M2-08, W-M2-10).
//
// Covers the tighten-only resolver, the `stepUpSatisfies` evaluation primitive M3's
// `step_up_recent` predicate consumes (§7.8 login-MFA freshness, §7.10 tenant WebAuthn-only
// tightening), and the login-MFA step-up initializer (§7.8 setup + the SMS-doesn't-init rule).
import { describe, expect, it } from "vitest";
import {
  type LoginMfaCompletedContext,
  createInMemoryAuditExecutor,
  createInMemorySessionStepUpWriter,
  createInMemoryStepUpOverrideReader,
  onLoginMfaCompleted,
  resolveStepUpPolicy,
  stepUpSatisfies,
  tightenStepUpPolicy,
} from "../src/modules/02-identity/index";

describe("M2-T05 step-up policy resolution (tighten-only, §4.3.2 / D9)", () => {
  it("no override → the platform floor stands (webauthn+totp, 300s)", () => {
    expect(tightenStepUpPolicy(null)).toEqual({
      qualifyingFactors: ["webauthn", "totp"],
      maxAgeSec: 300,
    });
  });

  it("W-M2-10: WebAuthn-only/60s override tightens to intersect + min", () => {
    const resolved = tightenStepUpPolicy({ qualifyingFactors: ["webauthn"], maxAgeSec: 60 });
    expect(resolved).toEqual({ qualifyingFactors: ["webauthn"], maxAgeSec: 60 });
  });

  it("an override may never LOOSEN the floor (sms dropped, maxAge clamped to 300)", () => {
    const resolved = tightenStepUpPolicy({
      // A tenant attempting to add sms + extend the window past the floor.
      qualifyingFactors: ["webauthn", "totp", "sms"],
      maxAgeSec: 9999,
    });
    expect(resolved.qualifyingFactors).toEqual(["webauthn", "totp"]); // sms intersected out
    expect(resolved.maxAgeSec).toBe(300); // min(9999, 300)
  });

  it("resolveStepUpPolicy reads the per-(org,operation) override via the reader port", async () => {
    const reader = createInMemoryStepUpOverrideReader({
      "org_a::external_interfaces.sud_unredact.exercise": {
        qualifyingFactors: ["webauthn"],
        maxAgeSec: 60,
      },
    });
    expect(
      await resolveStepUpPolicy(reader, {
        organizationId: "org_a",
        operationKey: "external_interfaces.sud_unredact.exercise",
      }),
    ).toEqual({ qualifyingFactors: ["webauthn"], maxAgeSec: 60 });
    // A different operation falls back to the platform floor.
    expect(
      await resolveStepUpPolicy(reader, { organizationId: "org_a", operationKey: "other" }),
    ).toEqual({ qualifyingFactors: ["webauthn", "totp"], maxAgeSec: 300 });
  });
});

describe("M2-T05 stepUpSatisfies (M3 step_up_recent primitive)", () => {
  const floor = { qualifyingFactors: ["webauthn", "totp"] as const, maxAgeSec: 300 };

  it("W-M2-08: a TOTP login-MFA step-up 5s ago satisfies the floor", () => {
    const decision = stepUpSatisfies(
      floor,
      { lastStepUpAt: new Date("2026-06-10T14:30:00Z"), lastStepUpFactor: "totp" },
      new Date("2026-06-10T14:30:05Z"),
    );
    expect(decision).toEqual({ allow: true });
  });

  it("never-stepped-up → deny step_up_required", () => {
    expect(
      stepUpSatisfies(floor, { lastStepUpAt: null, lastStepUpFactor: null }, new Date()),
    ).toEqual({ allow: false, reason: "step_up_required" });
  });

  it("W-M2-10: TOTP step-up under a WebAuthn-only policy → deny step_up_factor_not_qualifying", () => {
    const tightened = { qualifyingFactors: ["webauthn"] as const, maxAgeSec: 60 };
    const now = new Date("2026-06-10T14:31:00Z");
    expect(
      stepUpSatisfies(
        tightened,
        { lastStepUpAt: new Date("2026-06-10T14:30:00Z"), lastStepUpFactor: "totp" },
        now,
      ),
    ).toEqual({ allow: false, reason: "step_up_factor_not_qualifying" });
    // The same user re-stepping with WebAuthn within 60s now passes.
    expect(
      stepUpSatisfies(
        tightened,
        { lastStepUpAt: new Date("2026-06-10T14:30:30Z"), lastStepUpFactor: "webauthn" },
        now,
      ),
    ).toEqual({ allow: true });
  });

  it("a step-up older than maxAgeSec → deny step_up_stale", () => {
    expect(
      stepUpSatisfies(
        floor,
        { lastStepUpAt: new Date("2026-06-10T14:00:00Z"), lastStepUpFactor: "webauthn" },
        new Date("2026-06-10T14:30:00Z"),
      ),
    ).toEqual({ allow: false, reason: "step_up_stale" });
  });
});

describe("M2-T05 onLoginMfaCompleted (§4.4.2 / W-M2-08)", () => {
  const base: Omit<LoginMfaCompletedContext, "mfaFactor"> = {
    sessionId: "sess_1",
    userId: "user_1",
    organizationId: "org_a",
    completedAt: new Date("2026-06-10T14:30:00Z"),
    correlationId: "corr-login",
  };

  it("initializes step-up state + audits source=login_mfa at compliance retention (TOTP)", async () => {
    const writer = createInMemorySessionStepUpWriter();
    const auditSink = createInMemoryAuditExecutor();
    await onLoginMfaCompleted(
      { writer: writer.writer, audit: auditSink.executor },
      { ...base, mfaFactor: "totp" },
    );

    expect(writer.stateOf("sess_1")).toEqual({
      lastStepUpAt: new Date("2026-06-10T14:30:00Z"),
      lastStepUpFactor: "totp",
    });
    expect(auditSink.rows).toHaveLength(1);
    const row = auditSink.rows[0];
    expect(row?.eventType).toBe("m2.session.step_up.completed");
    expect(row?.retentionClass).toBe("compliance");
    expect(row?.outcome).toBe("success");
    expect(row?.context).toMatchObject({ factor: "totp", source: "login_mfa" });
  });

  it("SMS login MFA does NOT initialize step-up (D9) — no write, no audit", async () => {
    const writer = createInMemorySessionStepUpWriter();
    const auditSink = createInMemoryAuditExecutor();
    await onLoginMfaCompleted(
      { writer: writer.writer, audit: auditSink.executor },
      { ...base, mfaFactor: "sms" },
    );
    expect(writer.stateOf("sess_1")).toBeUndefined();
    expect(auditSink.rows).toHaveLength(0);
  });

  it("a login without MFA is a no-op", async () => {
    const writer = createInMemorySessionStepUpWriter();
    const auditSink = createInMemoryAuditExecutor();
    await onLoginMfaCompleted(
      { writer: writer.writer, audit: auditSink.executor },
      { ...base, mfaFactor: null },
    );
    expect(writer.stateOf("sess_1")).toBeUndefined();
    expect(auditSink.rows).toHaveLength(0);
  });
});
