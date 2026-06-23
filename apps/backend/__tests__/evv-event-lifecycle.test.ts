// apps/backend/__tests__/evv-event-lifecycle.test.ts — M18-T03 (§2.2.1, §2.3, §2.4, §7.1, §7.5–§7.7).
//
// The pure EVV event-lifecycle domain: the §2.3 capture-integrity + recording guards (each raises its
// machine-readable code), the §2.4 declarative side-effect list, the §3.2 quality-band derivation, and the
// §7.7 correction-of-record. No DB, no clock, no IO — the recorder is a validated factory over resolved
// cross-module context.
import { describe, expect, it } from "vitest";
import {
  type CaptureInput,
  type CheckoutPairing,
  type DeviceContext,
  type M18ErrorCode,
  type VisitContext,
  EvvStateError,
  GEOFENCE_BREACH_REASON_MIN,
  correctEvent,
  outboxEvents,
  recordEvent,
} from "../src/modules/18-evv/domain/index";

/** Assert `fn` throws an {@link EvvStateError} carrying the exact §2.3 `code`. */
function expectCode(fn: () => unknown, code: M18ErrorCode): void {
  expect(fn).toThrow(EvvStateError);
  try {
    fn();
  } catch (e) {
    expect((e as EvvStateError).code).toBe(code);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────
const PATIENT = "patient-1";
const CLINICIAN = "membership-1";
const PATIENT_COORD = { lat: 45.5231, lng: -122.6788 }; // §7.1 worked example baseline
const POLICY = { radiusM: 100, maxAccuracyM: 50 };

const visit = (over: Partial<VisitContext> = {}): VisitContext => ({
  patientId: PATIENT,
  assignedMembershipId: CLINICIAN,
  status: "published",
  ...over,
});

const device = (over: Partial<DeviceContext> = {}): DeviceContext => ({
  registrationStatus: "approved",
  attestationStatus: "attested_clean",
  ...over,
});

const capture = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  kind: "check_in",
  postingMembershipId: CLINICIAN,
  patientId: PATIENT,
  coordinate: { lat: 45.523, lng: -122.6789 }, // ≈14m from baseline
  accuracyM: 12,
  capturedAt: "2026-03-04T10:02:00.000Z",
  recordedAt: "2026-03-04T10:02:01.000Z",
  offlineCapture: false,
  ...over,
});

const recordCheckIn = (over: Partial<CaptureInput> = {}) =>
  recordEvent({
    capture: capture(over),
    visit: visit(),
    device: device(),
    policy: POLICY,
    patientAddressCoordinate: PATIENT_COORD,
  });

// ── §7.1 happy path ─────────────────────────────────────────────────────────────────────────────
describe("recordEvent — §7.1 normal check-in", () => {
  it("records a high-quality inside-geofence check-in and emits at_patient_address", () => {
    const r = recordCheckIn();
    expect(r.gpsQuality).toBe("high");
    expect(r.geofenceEvaluation.decision).toBe("inside");
    expect(r.geofenceEvaluation.computedDistanceM).toBeLessThan(100);
    expect(outboxEvents(r.effects)).toEqual(["m18.evv.check_in_recorded", "m18.evv.at_patient_address"]);
    expect(r.effects[0]).toEqual({ kind: "audit" });
    expect(r.effects.some((e) => e.kind === "insert_geofence_evaluation")).toBe(true);
  });

  it("bands accuracy: <15m high, 15-50m acceptable", () => {
    expect(recordCheckIn({ accuracyM: 30 }).gpsQuality).toBe("acceptable");
  });
});

// ── §2.3 capture integrity ────────────────────────────────────────────────────────────────────────
describe("recordEvent — §2.3 capture integrity guards", () => {
  it("rejects accuracy > 500m as garbage", () => {
    expectCode(() => recordCheckIn({ accuracyM: 600 }), "EVV_ACCURACY_OUT_OF_RANGE");
  });

  it("rejects accuracy ≤ 0", () => {
    expectCode(() => recordCheckIn({ accuracyM: 0 }), "EVV_ACCURACY_OUT_OF_RANGE");
  });

  it("rejects captured_at after recorded_at (device clock lead)", () => {
    expectCode(
      () => recordCheckIn({ capturedAt: "2026-03-04T10:05:00.000Z", recordedAt: "2026-03-04T10:02:00.000Z" }),
      "EVV_CAPTURED_AFTER_RECORDED",
    );
  });
});

// ── §2.2.1 recording guards ───────────────────────────────────────────────────────────────────────
describe("recordEvent — §2.2.1 recording guards", () => {
  it("rejects a posting membership that is not the assigned clinician", () => {
    expectCode(
      () =>
        recordEvent({
          capture: capture({ postingMembershipId: "membership-other" }),
          visit: visit(),
          device: device(),
          policy: POLICY,
          patientAddressCoordinate: PATIENT_COORD,
        }),
      "NOT_ASSIGNED_CLINICIAN",
    );
  });

  it("rejects a patient mismatch against the visit", () => {
    expectCode(
      () =>
        recordEvent({
          capture: capture({ patientId: "patient-other" }),
          visit: visit(),
          device: device(),
          policy: POLICY,
          patientAddressCoordinate: PATIENT_COORD,
        }),
      "EVV_PATIENT_MISMATCH",
    );
  });

  it("rejects a non-attested device (D8)", () => {
    expectCode(
      () =>
        recordEvent({
          capture: capture(),
          visit: visit(),
          device: device({ attestationStatus: "attested_tampered" }),
          policy: POLICY,
          patientAddressCoordinate: PATIENT_COORD,
        }),
      "DEVICE_INTEGRITY_FAILED",
    );
  });

  it("rejects a non-approved device registration", () => {
    expectCode(
      () =>
        recordEvent({
          capture: capture(),
          visit: visit(),
          device: device({ registrationStatus: "pending_approval" }),
          policy: POLICY,
          patientAddressCoordinate: PATIENT_COORD,
        }),
      "DEVICE_NOT_APPROVED",
    );
  });

  it("rejects a check_in from a completed visit", () => {
    expectCode(
      () =>
        recordEvent({
          capture: capture({ kind: "check_in" }),
          visit: visit({ status: "completed" }),
          device: device(),
          policy: POLICY,
          patientAddressCoordinate: PATIENT_COORD,
        }),
      "ILLEGAL_CHECK_IN_VISIT_STATUS",
    );
  });

  it("rejects a check_out from a published (not-yet-started) visit", () => {
    expectCode(
      () =>
        recordEvent({
          capture: capture({ kind: "check_out" }),
          visit: visit({ status: "published" }),
          device: device(),
          policy: POLICY,
          patientAddressCoordinate: PATIENT_COORD,
          pairing: { checkInPresentInsideGeofence: false, openMissingCheckout: false },
        }),
      "ILLEGAL_CHECK_OUT_VISIT_STATUS",
    );
  });
});

// ── §7.5 advisory geofence breach ───────────────────────────────────────────────────────────────
describe("recordEvent — §7.5 geofence breach (advisory-not-block)", () => {
  const farCoord = { lat: 45.524, lng: -122.68 }; // ≈187m from baseline

  it("records an outside-geofence check-in with a breach reason; visit proceeds", () => {
    const r = recordEvent({
      capture: capture({
        coordinate: farCoord,
        geofenceBreachReason: "Patient asked to be picked up at the assisted-living lobby across the lot.",
      }),
      visit: visit(),
      device: device(),
      policy: POLICY,
      patientAddressCoordinate: PATIENT_COORD,
    });
    expect(r.geofenceEvaluation.decision).toBe("outside_geofence");
    expect(r.geofenceEvaluation.failReason).toBe("distance_exceeded");
    expect(r.gpsQuality).toBe("outside_geofence");
    expect(outboxEvents(r.effects)).toContain("m18.evv.geofence_breach_recorded");
    expect(r.effects).toContainEqual({ kind: "alert", alert: "geofence_breach_recorded" });
    expect(r.effects).toContainEqual({
      kind: "open_missing_resolution",
      resolutionKind: "outside_geofence_at_checkin",
    });
    // not inside ⇒ no at_patient_address
    expect(outboxEvents(r.effects)).not.toContain("m18.evv.at_patient_address");
  });

  it("requires a breach reason ≥ 30 chars on an outside-geofence fix", () => {
    expectCode(
      () =>
        recordEvent({
          capture: capture({ coordinate: farCoord, geofenceBreachReason: "too short" }),
          visit: visit(),
          device: device(),
          policy: POLICY,
          patientAddressCoordinate: PATIENT_COORD,
        }),
      "GEOFENCE_BREACH_REASON_TOO_SHORT",
    );
    expect("Patient asked to be picked up nearby now.".length).toBeGreaterThanOrEqual(GEOFENCE_BREACH_REASON_MIN);
  });
});

// ── §3.2 no-baseline + degraded-accuracy bands ────────────────────────────────────────────────────
describe("recordEvent — §3.2 quality bands", () => {
  it("no geocode baseline ⇒ no_geofence_baseline advisory (never blocks)", () => {
    const r = recordEvent({
      capture: capture(),
      visit: visit(),
      device: device(),
      policy: POLICY,
      patientAddressCoordinate: null,
    });
    expect(r.geofenceEvaluation.decision).toBe("no_baseline");
    expect(r.gpsQuality).toBe("no_geofence_baseline");
    expect(outboxEvents(r.effects)).not.toContain("m18.evv.at_patient_address");
  });

  it("accuracy beyond the policy max but inside ⇒ requires attestation", () => {
    expectCode(() => recordCheckIn({ accuracyM: 80 }), "EVV_DEGRADED_ACCURACY_ATTESTATION_REQUIRED");
    expect(recordCheckIn({ accuracyM: 80, degradedAttested: true }).gpsQuality).toBe("degraded_attested");
  });

  it("§7.6 suspected spoof is recorded + warned (advisory), never blocked", () => {
    const r = recordCheckIn({ spoofSuspected: true });
    expect(r.gpsQuality).toBe("suspected_spoof");
    expect(outboxEvents(r.effects)).toContain("m18.evv.gps_spoof_suspected");
    expect(r.effects).toContainEqual({ kind: "alert", alert: "gps_spoof_suspected" });
  });
});

// ── §2.4 check-out pairing ──────────────────────────────────────────────────────────────────────
describe("recordEvent — §2.4 check-out pairing", () => {
  const checkout = (pairing: CheckoutPairing) =>
    recordEvent({
      capture: capture({ kind: "check_out" }),
      visit: visit({ status: "in_visit" }),
      device: device(),
      policy: POLICY,
      patientAddressCoordinate: PATIENT_COORD,
      pairing,
    });

  it("a clean inside check-out verifies the visit", () => {
    const r = checkout({ checkInPresentInsideGeofence: true, openMissingCheckout: false });
    expect(outboxEvents(r.effects)).toEqual([
      "m18.evv.check_out_recorded",
      "m18.evv.at_patient_address",
      "m18.evv.visit_verified",
    ]);
  });

  it("an open missing-checkout is auto-closed system-driven on check-out", () => {
    const r = checkout({ checkInPresentInsideGeofence: true, openMissingCheckout: true });
    expect(r.effects).toContainEqual({
      kind: "close_missing_resolution_system",
      resolutionKind: "missing_checkout",
    });
  });

  it("no paired check-in ⇒ no visit_verified", () => {
    const r = checkout({ checkInPresentInsideGeofence: false, openMissingCheckout: false });
    expect(outboxEvents(r.effects)).not.toContain("m18.evv.visit_verified");
  });
});

// ── §7.7 correction-of-record ──────────────────────────────────────────────────────────────────
describe("correctEvent — §7.7 correction-of-record", () => {
  const base = {
    originalEventId: "event-1",
    originalKind: "check_in" as const,
    originalSupersededByEventId: null,
    newKind: "check_in" as const,
    correctionReason: "Confirmed GPS spoof on developer-mode device; the clinician was elsewhere per family.",
    stepUpVerified: true,
  };

  it("supersedes, audits, captures the reason, emits event_corrected and reopens a missing-resolution", () => {
    const r = correctEvent(base);
    expect(r.effects).toContainEqual({ kind: "supersede_event", originalEventId: "event-1" });
    expect(r.effects).toContainEqual({
      kind: "capture_reason",
      field: "correction_reason",
      value: base.correctionReason,
    });
    expect(outboxEvents(r.effects)).toEqual(["m18.evv.event_corrected"]);
    expect(r.effects).toContainEqual({ kind: "open_missing_resolution", resolutionKind: "missing_checkin" });
  });

  it("requires step-up auth", () => {
    expectCode(() => correctEvent({ ...base, stepUpVerified: false }), "EVV_CORRECTION_STEP_UP_REQUIRED");
  });

  it("requires a correction_reason ≥ 60 chars", () => {
    expectCode(() => correctEvent({ ...base, correctionReason: "too short" }), "EVV_CORRECTION_REASON_TOO_SHORT");
  });

  it("refuses to correct an already-superseded event", () => {
    expectCode(() => correctEvent({ ...base, originalSupersededByEventId: "event-2" }), "EVV_EVENT_ALREADY_SUPERSEDED");
  });

  it("refuses to change the event kind", () => {
    expectCode(() => correctEvent({ ...base, newKind: "check_out" }), "EVV_CORRECTION_KIND_MISMATCH");
  });
});
