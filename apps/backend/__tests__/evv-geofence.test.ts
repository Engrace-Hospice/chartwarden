// apps/backend/__tests__/evv-geofence.test.ts — M18-T03 (§2.2.2 D3, §2.2.6, §2.3, §7.1).
//
// The pure geofence math + the three-layer policy resolver: haversine distance, the evaluation snapshot,
// the §3.2 quality-band inputs, narrowest-layer resolution, the §2.3 bounds, and the tighten-only edit
// constraint. All deterministic and IO-free.
import { describe, expect, it } from "vitest";
import {
  EvvStateError,
  type GeofencePolicyLayer,
  type M18ErrorCode,
  PLATFORM_FLOOR_MAX_ACCURACY_M,
  PLATFORM_FLOOR_RADIUS_M,
  PLATFORM_FLOOR_SETTINGS,
  assertPolicyBounds,
  assertTightenOnly,
  evaluateGeofence,
  haversineMeters,
  resolveEffectivePolicy,
  validatePolicyEdit,
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

describe("haversineMeters — §7.1 worked example", () => {
  it("computes ≈14m for the §7.1 device↔baseline pair", () => {
    const d = haversineMeters({ lat: 45.523, lng: -122.6789 }, { lat: 45.5231, lng: -122.6788 });
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(20);
  });

  it("is zero for identical coordinates", () => {
    expect(haversineMeters({ lat: 1, lng: 2 }, { lat: 1, lng: 2 })).toBeCloseTo(0, 6);
  });
});

describe("evaluateGeofence — §2.2.6 snapshot", () => {
  const policy = { radiusM: 100, maxAccuracyM: 50 };
  const baseline = { lat: 45.5231, lng: -122.6788 };

  it("inside when distance ≤ radius", () => {
    const e = evaluateGeofence({
      deviceCoordinate: { lat: 45.523, lng: -122.6789 },
      deviceAccuracyM: 12,
      patientAddressCoordinate: baseline,
      policy,
    });
    expect(e.decision).toBe("inside");
    expect(e.failReason).toBeNull();
    expect(e.accuracyExceeded).toBe(false);
  });

  it("outside_geofence (distance_exceeded) when distance > radius", () => {
    const e = evaluateGeofence({
      deviceCoordinate: { lat: 45.524, lng: -122.68 },
      deviceAccuracyM: 12,
      patientAddressCoordinate: baseline,
      policy,
    });
    expect(e.decision).toBe("outside_geofence");
    expect(e.failReason).toBe("distance_exceeded");
  });

  it("flags accuracy_exceeded but stays inside when distance is ok", () => {
    const e = evaluateGeofence({
      deviceCoordinate: { lat: 45.523, lng: -122.6789 },
      deviceAccuracyM: 80,
      patientAddressCoordinate: baseline,
      policy,
    });
    expect(e.decision).toBe("inside");
    expect(e.accuracyExceeded).toBe(true);
    expect(e.failReason).toBe("accuracy_exceeded");
  });

  it("no_baseline when the address was never geocoded", () => {
    const e = evaluateGeofence({
      deviceCoordinate: baseline,
      deviceAccuracyM: 12,
      patientAddressCoordinate: null,
      policy,
    });
    expect(e.decision).toBe("no_baseline");
    expect(e.computedDistanceM).toBeNull();
    expect(e.failReason).toBe("no_baseline_coordinate");
  });
});

describe("resolveEffectivePolicy — §2.2.2 narrowest layer", () => {
  const platform: GeofencePolicyLayer = {
    scope: "platform",
    patientAddressId: null,
    radiusM: PLATFORM_FLOOR_RADIUS_M,
    maxAccuracyM: PLATFORM_FLOOR_MAX_ACCURACY_M,
  };
  const tenant: GeofencePolicyLayer = {
    scope: "tenant",
    patientAddressId: null,
    radiusM: 100,
    maxAccuracyM: 40,
  };
  const addr: GeofencePolicyLayer = {
    scope: "patient_address",
    patientAddressId: "addr-1",
    radiusM: 60,
    maxAccuracyM: 30,
  };

  it("falls back to the platform floor when only it is present", () => {
    expect(resolveEffectivePolicy([platform], null)).toEqual({
      radiusM: PLATFORM_FLOOR_RADIUS_M,
      maxAccuracyM: PLATFORM_FLOOR_MAX_ACCURACY_M,
    });
  });

  it("prefers the tenant layer over the platform floor", () => {
    expect(resolveEffectivePolicy([platform, tenant], null).radiusM).toBe(100);
  });

  it("prefers a matching patient_address override over the tenant layer", () => {
    expect(resolveEffectivePolicy([platform, tenant, addr], "addr-1").radiusM).toBe(60);
  });

  it("ignores a patient_address override for a different address", () => {
    expect(resolveEffectivePolicy([platform, tenant, addr], "addr-2").radiusM).toBe(100);
  });

  it("throws when no layer resolves", () => {
    expectCode(() => resolveEffectivePolicy([], null), "GEOFENCE_POLICY_LAYER_UNRESOLVED");
  });
});

describe("policy bounds + tighten-only — §2.3 / §2.2.2", () => {
  it("accepts in-range bounds", () => {
    expect(() => assertPolicyBounds({ radiusM: 100, maxAccuracyM: 40 })).not.toThrow();
  });

  it("rejects radius outside [50,1000]", () => {
    expectCode(
      () => assertPolicyBounds({ radiusM: 40, maxAccuracyM: 40 }),
      "GEOFENCE_RADIUS_OUT_OF_RANGE",
    );
    expectCode(
      () => assertPolicyBounds({ radiusM: 1200, maxAccuracyM: 40 }),
      "GEOFENCE_RADIUS_OUT_OF_RANGE",
    );
  });

  it("rejects max_accuracy outside [5,100]", () => {
    expectCode(
      () => assertPolicyBounds({ radiusM: 100, maxAccuracyM: 2 }),
      "GEOFENCE_MAX_ACCURACY_OUT_OF_RANGE",
    );
  });

  it("a narrower layer may tighten but not loosen", () => {
    expect(() =>
      assertTightenOnly(PLATFORM_FLOOR_SETTINGS, { radiusM: 50, maxAccuracyM: 30 }),
    ).not.toThrow();
    expectCode(
      () => assertTightenOnly(PLATFORM_FLOOR_SETTINGS, { radiusM: 400, maxAccuracyM: 30 }),
      "GEOFENCE_POLICY_NOT_TIGHTENING",
    );
  });

  it("a patient_address override requires a ≥30-char reason", () => {
    expectCode(
      () =>
        validatePolicyEdit({
          scope: "patient_address",
          proposed: { radiusM: 60, maxAccuracyM: 30 },
          parent: { radiusM: 100, maxAccuracyM: 40 },
          overrideReason: "too short",
        }),
      "GEOFENCE_OVERRIDE_REASON_TOO_SHORT",
    );

    expect(() =>
      validatePolicyEdit({
        scope: "patient_address",
        proposed: { radiusM: 60, maxAccuracyM: 30 },
        parent: { radiusM: 100, maxAccuracyM: 40 },
        overrideReason:
          "Patient lives in a multi-building assisted-living campus; tighten to the unit.",
      }),
    ).not.toThrow();
  });

  it("EvvStateError carries the precise code + status", () => {
    try {
      assertPolicyBounds({ radiusM: 10, maxAccuracyM: 40 });
    } catch (e) {
      expect(e).toBeInstanceOf(EvvStateError);
      expect((e as EvvStateError).code).toBe("GEOFENCE_RADIUS_OUT_OF_RANGE");
      expect((e as EvvStateError).statusCode).toBe(422);
    }
  });
});
