/**
 * GAP-002 — server-side session timeouts (HIPAA §164.312(a)(2)(iii) automatic logoff).
 *
 * SESSION_POLICY declared staff idle 15 min / work 8 h / hard 24 h and auditor idle 10 min, but no
 * server code read them: Better Auth's 7-day rolling default was the only bound. These tests pin the
 * pure decision the authenticate hook now enforces, driven by `SESSION_POLICY.byClass` alone.
 */
import { SESSION_CLASSES, SESSION_MAX_ABSOLUTE_SEC, evaluateSessionTimeout } from "@wardenx/auth";
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
    expect(
      evaluateSessionTimeout(staff({ lastActivityAt: at(2 * HR) }), at(2 * HR + 16 * MIN)),
    ).toBe("expired_idle");
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

  it("M31 portal classes: 30-min idle / 8-h hard (M31 §6.4 / D3), not left unbounded", () => {
    for (const sessionClass of ["patient_portal", "caregiver_portal", "bereaved_portal"]) {
      const portal = staff({ sessionClass });
      expect(evaluateSessionTimeout({ ...portal, lastActivityAt: at(HR) }, at(HR + 29 * MIN))).toBe(
        "active",
      );
      expect(evaluateSessionTimeout({ ...portal, lastActivityAt: at(HR) }, at(HR + 31 * MIN))).toBe(
        "expired_idle",
      );
      expect(
        evaluateSessionTimeout({ ...portal, lastActivityAt: at(8 * HR) }, at(8 * HR + MIN)),
      ).toBe("expired_absolute");
      // A step-up does not extend a portal session: the hard cap runs from creation.
      expect(
        evaluateSessionTimeout(
          { ...portal, lastActivityAt: at(8 * HR), lastStepUpAt: at(7 * HR) },
          at(8 * HR + MIN),
        ),
      ).toBe("expired_absolute");
    }
  });

  it("M19 triage classes: 15-min idle / 8-h absolute (spec silent — the clinical-session floor)", () => {
    for (const sessionClass of ["external_triage_vendor", "external_triage_operator"]) {
      const vendor = staff({ sessionClass });
      expect(evaluateSessionTimeout(vendor, at(16 * MIN))).toBe("expired_idle");
      expect(
        evaluateSessionTimeout(
          { ...vendor, lastActivityAt: at(8 * HR), lastStepUpAt: at(7 * HR) },
          at(8 * HR + MIN),
        ),
      ).toBe("expired_absolute");
    }
  });

  it("every session_class has a timeout policy; an unknown class fails closed", () => {
    for (const sessionClass of SESSION_CLASSES) {
      // (auditor needs its engagement window — without one it fails closed by design, tested above)
      expect(
        evaluateSessionTimeout({ ...staff({ sessionClass }), engagementEnd: at(HR) }, at(MIN)),
      ).toBe("active");
    }
    expect(evaluateSessionTimeout(staff({ sessionClass: "mystery" }), at(MIN))).toBe(
      "expired_absolute",
    );
  });

  it("SESSION_POLICY.byClass covers exactly the session_class enum (no class without a policy, no stray entry)", () => {
    expect(Object.keys(SESSION_POLICY.byClass).sort()).toEqual([...SESSION_CLASSES].sort());
  });

  it("only staff renews its work window by step-up (the only class with a separate hard cap)", () => {
    const renewing = Object.entries(SESSION_POLICY.byClass)
      .filter(([, p]) => p.absoluteHardSec !== undefined)
      .map(([c]) => c);
    expect(renewing).toEqual(["staff"]);
  });

  it("a pre-deploy row (old 7-day expires_at, last_activity_at backfilled to now) is bounded from created_at", () => {
    // Migration 0319 backfilled last_activity_at = now(); the enforcer never reads expires_at, so a
    // session minted 9 h before deploy is past the 8-h work window however far Better Auth's expiry is.
    const preDeploy = staff({ lastActivityAt: at(9 * HR) });
    expect(evaluateSessionTimeout(preDeploy, at(9 * HR + MIN))).toBe("expired_absolute");
  });

  it("SESSION_MAX_ABSOLUTE_SEC stays 72 h: the portal/triage entries do not raise Better Auth's outer cap", () => {
    expect(SESSION_MAX_ABSOLUTE_SEC).toBe(72 * 3600);
  });

  it("SESSION_MAX_ABSOLUTE_SEC (Better Auth's fixed expiry) covers every fixed absolute", () => {
    const fixed = [8 * 3600, 24 * 3600, 72 * 3600]; // portal/triage/collab 8 h, staff hard 24 h, funeral 72 h
    for (const sec of fixed) expect(SESSION_MAX_ABSOLUTE_SEC).toBeGreaterThanOrEqual(sec);
  });

  it("reads its numbers from SESSION_POLICY (single source, D1)", () => {
    const idle = SESSION_POLICY.byClass.staff.idleSec * 1000;
    expect(evaluateSessionTimeout(staff(), at(idle - 1))).toBe("active");
    expect(evaluateSessionTimeout(staff(), at(idle + 1))).toBe("expired_idle");
  });
});
