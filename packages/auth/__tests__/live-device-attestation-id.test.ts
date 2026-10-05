// GAP-055 follow-up — the session-bound attestation id rides on the verdict so M18 can bind a capture to the
// device that SENT it (evv_device.m2_device_attestation_id). It comes off the joined row, never the request.
import { describe, expect, it } from "vitest";
import { liveDeviceAttestation } from "../src/identity/db-session-store";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const live = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  verdict: "attested",
  verifiedAt: new Date("2026-10-04T11:00:00.000Z"),
  expiresAt: new Date("2026-10-04T13:00:00.000Z"),
  revokedAt: null,
};

describe("liveDeviceAttestation — attestationId", () => {
  it("carries the joined attestation row id on a live attestation", () => {
    expect(liveDeviceAttestation(live, NOW)).toMatchObject({
      valid: true,
      attestationId: live.id,
    });
  });

  it("omits the id when the row carries none (legacy shape stays valid)", () => {
    const { id: _id, ...legacy } = live;
    expect(liveDeviceAttestation(legacy, NOW)).toEqual({
      valid: true,
      verifiedAt: live.verifiedAt.toISOString(),
    });
  });

  it("still reads a revoked attestation as null (no id leaks)", () => {
    expect(liveDeviceAttestation({ ...live, revokedAt: NOW }, NOW)).toBeNull();
  });
});
