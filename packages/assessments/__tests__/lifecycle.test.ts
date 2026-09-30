// @wardenx/assessments — entity lifecycle machines (§2.2, D9) — M9-T03.
import { describe, expect, it } from "vitest";
import {
  type CorrectionTarget,
  LICENSE_RENEWAL_WINDOW_DAYS,
  assertLicenseAllowsRecording,
  canRecordUnderLicense,
  computeScaleLicenseStatus,
  planCorrection,
  transitionSignificantChange,
} from "../src/lifecycle";

const target: CorrectionTarget = {
  id: "11111111-1111-1111-1111-111111111111",
  scaleType: "esas_r",
  patientId: "p1",
  admissionId: "a1",
  status: "active",
  version: 1,
};

describe("§2.2.1 correction-of-record (planCorrection)", () => {
  it("supersedes the active target and advances the version", () => {
    const plan = planCorrection(target, {
      scaleType: "esas_r",
      patientId: "p1",
      admissionId: "a1",
      expectedTargetVersion: 1,
    });
    expect(plan).toEqual({ supersedeTargetId: target.id, newVersion: 2 });
  });

  it("refuses to correct an already-superseded row (409 CORRECTION_TARGET_NOT_ACTIVE)", () => {
    expect(() =>
      planCorrection(
        { ...target, status: "superseded" },
        { scaleType: "esas_r", patientId: "p1", admissionId: "a1", expectedTargetVersion: 1 },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CORRECTION_TARGET_NOT_ACTIVE", statusCode: 409 }),
    );
  });

  it("rejects a scale/patient/admission mismatch (422 CORRECTION_MISMATCH)", () => {
    expect(() =>
      planCorrection(target, {
        scaleType: "pps",
        patientId: "p1",
        admissionId: "a1",
        expectedTargetVersion: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "CORRECTION_MISMATCH", statusCode: 422 }));
  });

  it("rejects a stale parent version (412 STALE_VERSION)", () => {
    expect(() =>
      planCorrection(target, {
        scaleType: "esas_r",
        patientId: "p1",
        admissionId: "a1",
        expectedTargetVersion: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_VERSION", statusCode: 412 }));
  });
});

describe("§2.2.2 significant-change ack/escalate (transitionSignificantChange)", () => {
  it("acks open → acknowledged", () => {
    expect(transitionSignificantChange("open", { type: "acknowledge" })).toBe("acknowledged");
  });

  it("escalates open → escalated for a CRITICAL rule", () => {
    expect(
      transitionSignificantChange("open", { type: "escalate", ruleId: "pps_drop_20_in_14d" }),
    ).toBe("escalated");
  });

  it("acks escalated → acknowledged", () => {
    expect(transitionSignificantChange("escalated", { type: "acknowledge" })).toBe("acknowledged");
  });

  it("refuses to escalate a non-CRITICAL rule (422 CHANGE_NOT_ESCALATABLE)", () => {
    expect(() =>
      transitionSignificantChange("open", { type: "escalate", ruleId: "esas_symptom_ge_7" }),
    ).toThrowError(expect.objectContaining({ code: "CHANGE_NOT_ESCALATABLE", statusCode: 422 }));
  });

  it("refuses an off-graph transition (409 ILLEGAL_CHANGE_TRANSITION)", () => {
    expect(() => transitionSignificantChange("acknowledged", { type: "acknowledge" })).toThrowError(
      expect.objectContaining({ code: "ILLEGAL_CHANGE_TRANSITION", statusCode: 409 }),
    );
    expect(() =>
      transitionSignificantChange("escalated", { type: "escalate", ruleId: "pps_drop_20_in_14d" }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_CHANGE_TRANSITION" }));
  });
});

describe("§2.2.3 scale-license status (computeScaleLicenseStatus)", () => {
  const lic = { effectiveDate: "2026-01-01", expiresAt: "2026-12-31" };

  it("is active well inside the term", () => {
    expect(computeScaleLicenseStatus(lic, "2026-06-01")).toBe("active");
  });

  it("flips to pending_renewal inside the 30-day window", () => {
    expect(computeScaleLicenseStatus(lic, "2026-12-10")).toBe("pending_renewal");
    expect(LICENSE_RENEWAL_WINDOW_DAYS).toBe(30);
  });

  it("is expired on/after the expiry date", () => {
    expect(computeScaleLicenseStatus(lic, "2026-12-31")).toBe("expired");
    expect(computeScaleLicenseStatus(lic, "2027-01-05")).toBe("expired");
  });

  it("treats a not-yet-effective license as pending_renewal (not in force for recording)", () => {
    expect(computeScaleLicenseStatus(lic, "2025-12-15")).toBe("pending_renewal");
  });

  it("allows recording while active or pending renewal", () => {
    expect(canRecordUnderLicense("active")).toBe(true);
    expect(canRecordUnderLicense("pending_renewal")).toBe(true);
    expect(canRecordUnderLicense("expired")).toBe(false);
    expect(() => assertLicenseAllowsRecording("pps", "expired")).toThrowError(
      expect.objectContaining({ code: "SCALE_LICENSE_MISSING", statusCode: 403 }),
    );
    expect(() => assertLicenseAllowsRecording("pps", "active")).not.toThrow();
  });
});
