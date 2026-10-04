/**
 * GAP-002 — server-side session timeouts (HIPAA §164.312(a)(2)(iii) automatic logoff).
 *
 * SESSION_POLICY declared staff idle 15 min / work 8 h / hard 24 h and auditor idle 10 min, but no
 * server code read them: Better Auth's 7-day rolling default was the only bound. These tests pin the
 * pure decision the authenticate hook now enforces, driven by `SESSION_POLICY.byClass` alone.
 */
import { evaluateSessionTimeout } from "@wardenx/auth";
import { SESSION_POLICY } from "@wardenx/types";
import { describe, expect, it } from "vitest";

const MIN = 60_000;
const HR = 60 * MIN;
const T0 = new Date("2026-10-04T08:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const staff = (over: Partial<Parameters<typeof evaluateSessionTimeout>[0]> = {}) => ({
  sessionClass: "staff",
  createdAt: T0,
  lastActivityAt: null,
  lastStepUpAt: null,
  engagementEnd: null,
  ...over,
});

describe("GAP-002 evaluateSessionTimeout", () => {
  it("staff: active within the 15-min idle window", () => {
    expect(evaluateSessionTimeout(staff({ lastActivityAt: at(60 * MIN) }), at(74 * MIN))).toBe(
      "active",
    );
  });

  it("staff: 16 idle minutes → expired_idle (no activity recorded falls back to createdAt)", () => {
    expect(evaluateSessionTimeout(staff(), at(16 * MIN))).toBe("expired_idle");
    expect(evaluateSessionTimeout(staff({ lastActivityAt: at(2 * HR) }), at(2 * HR + 16 * MIN))).toBe(
      "expired_idle",
    );
  });

  it("staff: continuous activity past the 8-h work window → expired_absolute", () => {
    const now = at(8 * HR + MIN);
    expect(evaluateSessionTimeout(staff({ lastActivityAt: at(8 * HR) }), now)).toBe(
      "expired_absolute",
    );
  });

  it("staff: a re-authentication (step-up) renews the work window, but never past 24 h hard", () => {
    const renewed = staff({ lastActivityAt: at(10 * HR), lastStepUpAt: at(6 * HR) });
    expect(evaluateSessionTimeout(renewed, at(10 * HR + MIN))).toBe("active");
    const pastHard = staff({ lastActivityAt: at(24 * HR), lastStepUpAt: at(20 * HR) });
    expect(evaluateSessionTimeout(pastHard, at(24 * HR + MIN))).toBe("expired_absolute");
  });

  it("auditor: 10-min idle, absolute bound is engagement_end", () => {
    const auditor = { ...staff({ sessionClass: "auditor" }), engagementEnd: at(3 * HR) };
    expect(evaluateSessionTimeout({ ...auditor, lastActivityAt: at(HR) }, at(HR + 11 * MIN))).toBe(
      "expired_idle",
    );
    expect(
      evaluateSessionTimeout({ ...auditor, lastActivityAt: at(3 * HR) }, at(3 * HR + MIN)),
    ).toBe("expired_absolute");
    // No engagement window on an auditor session is not "unbounded" — fail closed.
    expect(evaluateSessionTimeout({ ...auditor, engagementEnd: null }, at(MIN))).toBe(
      "expired_absolute",
    );
  });

  it("funeral_home: 72-h absolute from creation", () => {
    const funeral = staff({ sessionClass: "funeral_home", lastActivityAt: at(72 * HR) });
    expect(evaluateSessionTimeout(funeral, at(72 * HR + MIN))).toBe("expired_absolute");
  });

  it("classes outside SESSION_POLICY.byClass are left to their own module's policy", () => {
    expect(evaluateSessionTimeout(staff({ sessionClass: "patient_portal" }), at(20 * HR))).toBe(
      "active",
    );
  });

  it("reads its numbers from SESSION_POLICY (single source, D1)", () => {
    const idle = SESSION_POLICY.byClass.staff.idleSec * 1000;
    expect(evaluateSessionTimeout(staff(), at(idle - 1))).toBe("active");
    expect(evaluateSessionTimeout(staff(), at(idle + 1))).toBe("expired_idle");
  });
});
