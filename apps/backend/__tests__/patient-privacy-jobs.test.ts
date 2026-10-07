// apps/backend/__tests__/patient-privacy-jobs.test.ts — M5-T10 privacy-flag recompute + SUD
// enforcement (§7.6) + geocode job (§4.5) + outbox event catalog (§4.6).
import { describe, expect, it } from "vitest";
import {
  type GeocodeAddressPorts,
  M5_OUTBOX_EVENTS,
  type PrivacySnapshotPorts,
  SudConsentRequiredError,
  applyConsentChanged,
  assertSudReadAllowed,
  isSudReadAllowed,
  recomputePrivacyFlags,
  runGeocodeAddress,
} from "../src/modules/05-patient/index";

describe("§7.6 SUD flag enforcement", () => {
  it("recomputes the flag set — a category without active consent is restricted", () => {
    const flags = recomputePrivacyFlags([
      { flag: "sud", active: false }, // restricted (no Part-2 consent)
      { flag: "hiv", active: true }, // consented → not restricted
      { flag: "mental_health", active: false },
    ]);
    expect(flags).toEqual(["mental_health", "sud"]); // sorted, hiv excluded
  });

  it("a SUD-flagged read is DENIED without a Part-2 consent, ALLOWED with one", () => {
    expect(isSudReadAllowed(["sud"], false)).toBe(false);
    expect(isSudReadAllowed(["sud"], true)).toBe(true);
    expect(isSudReadAllowed(["hiv"], false)).toBe(true); // non-SUD → no gate
    expect(() => assertSudReadAllowed("p1", ["sud"], false)).toThrow(SudConsentRequiredError);
    expect(() => assertSudReadAllowed("p1", ["sud"], true)).not.toThrow();
  });

  it("the M39 consent-changed consumer recomputes the snapshot + emits privacy_flag_changed", async () => {
    const writes: Array<{ patientId: string; flags: readonly string[] }> = [];
    const emits: string[] = [];
    const ports: PrivacySnapshotPorts = {
      writeSnapshot: async (_o, patientId, flags) => void writes.push({ patientId, flags }),
      emitPrivacyFlagChanged: async (_o, patientId) => void emits.push(patientId),
    };
    const flags = await applyConsentChanged(
      { organizationId: "org_a", patientId: "p1", signals: [{ flag: "sud", active: false }] },
      ports,
    );
    expect(flags).toEqual(["sud"]);
    expect(writes).toEqual([{ patientId: "p1", flags: ["sud"] }]);
    expect(emits).toEqual(["p1"]);
  });
});

describe("§4.5 geocode job", () => {
  it("resolves coordinates and writes them back", async () => {
    const written: Array<{ addressId: string; lat: number | null }> = [];
    const ports: GeocodeAddressPorts = {
      geocode: async () => ({ lat: 45.52, lng: -122.68 }),
      writeGeocode: async (_o, addressId, r) => void written.push({ addressId, lat: r.lat }),
    };
    const result = await runGeocodeAddress(
      {
        organizationId: "org_a",
        addressId: "addr-1",
        address: { line1: "10 SW Main", city: "Portland", state: "OR", postalCode: "97201" },
      },
      ports,
    );
    expect(result.resolved).toBe(true);
    expect(written).toEqual([{ addressId: "addr-1", lat: 45.52 }]);
  });

  it("an unresolvable address writes nulls and reports resolved=false", async () => {
    const ports: GeocodeAddressPorts = {
      geocode: async () => ({ lat: null, lng: null }),
      writeGeocode: async () => undefined,
    };
    const result = await runGeocodeAddress(
      {
        organizationId: "org_a",
        addressId: "addr-2",
        address: { line1: "nowhere", city: "?", postalCode: "00000" },
      },
      ports,
    );
    expect(result.resolved).toBe(false);
  });
});

describe("§4.6 outbox event catalog", () => {
  it("declares 19 m5.patient.* / m5.patient_allergy.* events, all owned by m5", () => {
    // F-238 added `m5.patient_allergy.draft_created_from_extraction` (the DocLens allergy reply).
    // GAP-118 added `m5.patient.amendment_sla_due_soon` / `.amendment_sla_overdue` (the daily SLA scan).
    expect(M5_OUTBOX_EVENTS).toHaveLength(19);
    for (const e of M5_OUTBOX_EVENTS) {
      expect(e.moduleOwner).toBe("m5");
      expect(/^m5\.patient(_allergy)?\./.test(e.eventName)).toBe(true);
    }
  });
});
