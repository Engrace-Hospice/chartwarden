import { describe, expect, it } from "vitest";
import {
  canonicalOfflineCapture,
  fingerprintOfflineCapture,
} from "../src/modules/18-evv/offline-idempotency";

const capture = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  postingMembershipId: "22222222-2222-4222-8222-222222222222",
  evvDeviceId: "33333333-3333-4333-8333-333333333333",
  localId: "44444444-4444-4444-8444-444444444444",
  kind: "check_in" as const,
  visitId: "55555555-5555-4555-8555-555555555555",
  capturedAt: "2026-01-31T23:59:59-05:00",
  coords: { lat: 40, lng: -75 },
  accuracyM: 10,
  serviceTypeCode: "routine_visit",
};

describe("M18 offline capture canonical fingerprint", () => {
  it("normalizes equivalent timestamps and JSON number spellings", () => {
    const equivalent = {
      ...capture,
      capturedAt: "2026-02-01T04:59:59.000Z",
      coords: { lat: 40.0, lng: -75.0 },
      accuracyM: 10.0,
    };
    expect(canonicalOfflineCapture(equivalent)).toBe(canonicalOfflineCapture(capture));
    expect(fingerprintOfflineCapture(equivalent, "k".repeat(32))).toBe(
      fingerprintOfflineCapture(capture, "k".repeat(32)),
    );
  });

  it("changes when a semantic capture field changes and never contains raw coordinates", () => {
    const fingerprint = fingerprintOfflineCapture(capture, "k".repeat(32));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain("40");
    expect(fingerprintOfflineCapture({ ...capture, accuracyM: 11 }, "k".repeat(32))).not.toBe(
      fingerprint,
    );
  });

  it("pins the receipt's global uniqueness, forced RLS, narrow grants, append-only guard and scrubbed audit", () => {
    const migration = readFileSync(
      join(__dirname, "../../../packages/db/migrations/1121_m18_evv_offline_capture_receipt.sql"),
      "utf8",
    );
    expect(migration).toContain(
      'ON "evv_offline_capture_receipt" ("organization_id", "evv_device_id", "local_id")',
    );
    expect(migration).toContain(
      'ALTER TABLE "evv_offline_capture_receipt" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON "evv_offline_capture_receipt" TO wardenx_app',
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON "evv_offline_capture_receipt" TO wardenx_app',
    );
    expect(migration).toContain("EVV_OFFLINE_CAPTURE_RECEIPT_APPEND_ONLY");
    expect(migration).toContain("audit_scrub(to_jsonb(NEW), ARRAY['payload_fingerprint']::text[])");
    expect(migration).not.toContain("coords_cipher");
    expect(migration).not.toContain("patient_id");
  });
});
import { readFileSync } from "node:fs";
import { join } from "node:path";
