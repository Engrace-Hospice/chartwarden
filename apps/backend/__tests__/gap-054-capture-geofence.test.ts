// apps/backend/__tests__/gap-054-capture-geofence.test.ts — GAP-054 (M18): the capture geofence decision is
// computed from the haversine distance to the patient-address baseline; a client `degraded_attested` flag is an
// advisory breach (never a pass); no baseline is advisory `no_geofence_baseline`; no distance is ever invented.
import { describe, expect, it } from "vitest";
import { decideCaptureGeofence } from "../src/modules/18-evv/capture-geofence";

const POLICY = { radiusM: 150, maxAccuracyM: 50 };
const ADDRESS = { lat: 45.523, lng: -122.6789 };
/** ~5 km north of the address (0.045 degrees of latitude). */
const FIVE_KM_AWAY = { lat: 45.568, lng: -122.6789 };
const AT_ADDRESS = { lat: 45.5231, lng: -122.6788 };

const decide = (over: Partial<Parameters<typeof decideCaptureGeofence>[0]> = {}) =>
  decideCaptureGeofence({
    deviceCoordinate: AT_ADDRESS,
    accuracyM: 5,
    attestedDegraded: false,
    baseline: ADDRESS,
    policy: POLICY,
    ...over,
  });

describe("decideCaptureGeofence", () => {
  it("passes a good-accuracy fix inside the radius with the real distance", () => {
    const out = decide();
    expect(out.decision).toBe("pass");
    expect(out.gpsQuality).toBe("high");
    expect(out.computedDistanceM).toBeGreaterThan(0);
    expect(out.computedDistanceM).toBeLessThan(POLICY.radiusM);
  });

  it("is acceptable (still a pass) when accuracy is between the high band and the policy max", () => {
    const out = decide({ accuracyM: 40 });
    expect(out.decision).toBe("pass");
    expect(out.gpsQuality).toBe("acceptable");
  });

  it("breaches a good-accuracy capture 5 km from the address and reports the real distance", () => {
    const out = decide({ deviceCoordinate: FIVE_KM_AWAY });
    expect(out.decision).toBe("fail_distance");
    expect(out.gpsQuality).toBe("outside_geofence");
    expect(out.computedDistanceM).toBeGreaterThan(4_500);
    expect(out.computedDistanceM).toBeLessThan(5_500);
  });

  it("does not let the degraded_attested flag turn a far capture into a pass", () => {
    const out = decide({ deviceCoordinate: FIVE_KM_AWAY, accuracyM: 80, attestedDegraded: true });
    expect(out.decision).toBe("fail_distance");
    expect(out.gpsQuality).toBe("outside_geofence");
  });

  it("treats an un-attested over-accuracy fix at the address as a breach", () => {
    const out = decide({ accuracyM: 80 });
    expect(out.decision).toBe("fail_accuracy");
    expect(out.gpsQuality).toBe("outside_geofence");
    expect(out.computedDistanceM).not.toBeNull();
  });

  it("records an attested over-accuracy fix at the address as an advisory breach, not a pass", () => {
    const out = decide({ accuracyM: 80, attestedDegraded: true });
    expect(out.decision).toBe("fail_accuracy");
    expect(out.gpsQuality).toBe("degraded_attested");
    expect(out.computedDistanceM).not.toBeNull();
  });

  it("ignores the attested flag when the accuracy is already within the policy", () => {
    const out = decide({ accuracyM: 5, attestedDegraded: true });
    expect(out.decision).toBe("pass");
    expect(out.gpsQuality).toBe("high");
  });

  it("is advisory no_geofence_baseline with a NULL distance when the address has no coordinate", () => {
    const out = decide({ baseline: null, accuracyM: 80, attestedDegraded: true });
    expect(out.decision).toBe("fail_no_baseline");
    expect(out.gpsQuality).toBe("no_geofence_baseline");
    expect(out.computedDistanceM).toBeNull();
  });
});
