import type { SupplyRequestKind } from "@chartwarden/types";
import { describe, expect, it } from "vitest";

import {
  SUPPLY_REQUEST_DATA_SCHEMAS,
  missingFloorMedications,
  validateSupplyRequestData,
} from "../src/kinds";

const UUID = "00000000-0000-4000-8000-000000000001";
const UUID2 = "00000000-0000-4000-8000-000000000002";

const address = {
  line1: "12 Elm St",
  city: "Portland",
  state: "OR",
  postalCode: "97201",
  capturedAt: "2026-07-01T00:00:00Z",
};

const kitLine = (over: Record<string, unknown> = {}) => ({
  comfortKitTemplateMedicationId: UUID2,
  rxNorm: "894801",
  drugName: "Morphine sulfate",
  strength: "20 mg/mL",
  dosageForm: "oral_solution",
  routeOfAdministration: "PO",
  isControlledSubstance: true,
  controlledSubstanceSchedule: "CII",
  expectedQuantity: 30,
  expectedUnit: "mL",
  replenishmentThresholdPct: 0.25,
  ...over,
});

const codes = (r: ReturnType<typeof validateSupplyRequestData>) =>
  r.ok ? [] : r.violations.map((v) => v.code);

describe("D1 per-kind schema registry", () => {
  it("has a schema for every kind", () => {
    const kinds: readonly SupplyRequestKind[] = [
      "dme",
      "supply",
      "comfort_kit_deploy",
      "comfort_kit_replenish",
    ];
    for (const k of kinds) expect(SUPPLY_REQUEST_DATA_SCHEMAS[k]).toBeDefined();
  });
});

describe("kind='dme'", () => {
  const valid = {
    skuId: UUID,
    hcpcs: "E0260",
    hcpcsModifiers: ["NU"],
    quantity: 1,
    rentalCadence: "monthly",
    deliveryAddress: address,
    needsInstallation: true,
    needsPatientEducation: false,
  };

  it("accepts a well-formed rental request", () => {
    expect(validateSupplyRequestData("dme", valid).ok).toBe(true);
  });

  it("rejects a malformed HCPCS", () => {
    expect(validateSupplyRequestData("dme", { ...valid, hcpcs: "0260E" }).ok).toBe(false);
  });

  it("rejects an unknown property rather than silently dropping it", () => {
    expect(validateSupplyRequestData("dme", { ...valid, vendorNotes: "x" }).ok).toBe(false);
  });

  it("requires an HCPCS — every DME line is billable", () => {
    const { hcpcs: _drop, ...noHcpcs } = valid;
    expect(validateSupplyRequestData("dme", noHcpcs).ok).toBe(false);
  });

  it("rejects an inverted delivery window, which would silently disable the overdue detector", () => {
    const r = validateSupplyRequestData("dme", {
      ...valid,
      deliveryWindowEarliest: "2026-07-05T00:00:00Z",
      deliveryWindowLatest: "2026-07-02T00:00:00Z",
    });
    expect(codes(r)).toContain("delivery_window_inverted");
  });
});

describe("kind='supply'", () => {
  const valid = { skuId: UUID, quantity: 2, unit: "box", deliveryAddress: address };

  it("accepts a non-billable consumable with no HCPCS", () => {
    expect(validateSupplyRequestData("supply", valid).ok).toBe(true);
  });

  it("still validates an HCPCS when one is given", () => {
    expect(validateSupplyRequestData("supply", { ...valid, hcpcs: "A4554" }).ok).toBe(true);
    expect(validateSupplyRequestData("supply", { ...valid, hcpcs: "bad" }).ok).toBe(false);
  });
});

describe("kind='comfort_kit_deploy' cross-field rules", () => {
  const home = {
    comfortKitTemplateId: UUID,
    deploymentSite: "home",
    deliveryAddress: address,
    pharmacyDispatchMode: "supply_hub_dispatch",
    contents: [kitLine()],
  };

  it("accepts a home deployment with an address and no room", () => {
    expect(validateSupplyRequestData("comfort_kit_deploy", home).ok).toBe(true);
  });

  it("requires an ipuRoomId for an ipu_room deployment", () => {
    const { deliveryAddress: _drop, ...noAddress } = home;
    const r = validateSupplyRequestData("comfort_kit_deploy", {
      ...noAddress,
      deploymentSite: "ipu_room",
    });
    expect(codes(r)).toContain("ipu_room_id_required");
  });

  it("forbids a delivery address on an ipu_room deployment", () => {
    const r = validateSupplyRequestData("comfort_kit_deploy", {
      ...home,
      deploymentSite: "ipu_room",
      ipuRoomId: UUID2,
    });
    expect(codes(r)).toContain("delivery_address_forbidden_for_ipu_room");
  });

  it("forbids an ipuRoomId on a residential deployment and demands an address", () => {
    const { deliveryAddress: _drop, ...noAddress } = home;
    const r = validateSupplyRequestData("comfort_kit_deploy", { ...noAddress, ipuRoomId: UUID2 });
    expect(codes(r)).toContain("ipu_room_id_forbidden");
    expect(codes(r)).toContain("delivery_address_required");
  });

  it("accepts a well-formed ipu_room deployment", () => {
    const { deliveryAddress: _drop, ...noAddress } = home;
    expect(
      validateSupplyRequestData("comfort_kit_deploy", {
        ...noAddress,
        deploymentSite: "ipu_room",
        ipuRoomId: UUID2,
      }).ok,
    ).toBe(true);
  });

  it("requires a DEA schedule on a controlled line", () => {
    const r = validateSupplyRequestData("comfort_kit_deploy", {
      ...home,
      contents: [kitLine({ controlledSubstanceSchedule: undefined })],
    });
    expect(codes(r)).toContain("controlled_schedule_required");
  });

  it("forbids a DEA schedule on a non-controlled line", () => {
    const r = validateSupplyRequestData("comfort_kit_deploy", {
      ...home,
      contents: [kitLine({ isControlledSubstance: false })],
    });
    expect(codes(r)).toContain("controlled_schedule_forbidden");
  });

  it("reports the shape error and the cross-field error together, not one round-trip at a time", () => {
    const { deliveryAddress: _drop, ...noAddress } = home;
    const r = validateSupplyRequestData("comfort_kit_deploy", {
      ...noAddress,
      comfortKitTemplateId: "not-a-uuid",
    });
    expect(codes(r)).toContain("schema_violation");
    expect(codes(r)).toContain("delivery_address_required");
  });

  it("refuses an empty and an over-long content list", () => {
    expect(validateSupplyRequestData("comfort_kit_deploy", { ...home, contents: [] }).ok).toBe(
      false,
    );
    expect(
      validateSupplyRequestData("comfort_kit_deploy", {
        ...home,
        contents: Array.from({ length: 17 }, () => kitLine()),
      }).ok,
    ).toBe(false);
  });
});

describe("kind='comfort_kit_replenish'", () => {
  const valid = {
    sourceDeploymentId: UUID,
    triggeringReplenishmentEventId: UUID2,
    urgencyKind: "urgent",
    deliveryAddress: address,
    contents: [kitLine()],
  };

  it("accepts a well-formed replenish", () => {
    expect(validateSupplyRequestData("comfort_kit_replenish", valid).ok).toBe(true);
  });

  it("requires the triggering M13 event — it is the request's only provenance", () => {
    const { triggeringReplenishmentEventId: _drop, ...noEvent } = valid;
    expect(validateSupplyRequestData("comfort_kit_replenish", noEvent).ok).toBe(false);
  });
});

describe("validateSupplyRequestData on non-objects", () => {
  it("rejects null and an array without throwing", () => {
    expect(validateSupplyRequestData("dme", null).ok).toBe(false);
    expect(validateSupplyRequestData("dme", []).ok).toBe(false);
  });
});

describe("§2.10 floor-medication defense in depth", () => {
  it("names every floor medication the request left out", () => {
    expect(missingFloorMedications(["a", "c"], ["a", "b", "c", "d"])).toEqual(["b", "d"]);
  });

  it("is empty when the request covers the floor", () => {
    expect(missingFloorMedications(["a", "b", "extra"], ["a", "b"])).toEqual([]);
  });
});
