import { describe, expect, it } from "vitest";
import {
  HopeUnsupportedOfficialRecordKindError,
  initializeNewHopeRecord,
} from "../src/modules/10-hope/hope-record-initializer";
import type { HopeSpecRegistry } from "../src/modules/10-hope/hope-spec-registry";

const registry: HopeSpecRegistry = {
  async requireVersion(versionId) {
    return { id: versionId, code: "1.00.1" } as never;
  },
  async resolveVersionForTargetDate() {
    return { id: "spec-1", code: "1.00.1" } as never;
  },
  async getItem() {
    return null;
  },
  async requireItem() {
    return { id: "item" } as never;
  },
  async getActiveItems() {
    return [];
  },
  async getActiveItemsForAssessment() {
    return [];
  },
  async getItemOptions() {
    return [];
  },
  async requireAllowedValue() {},
};

describe("HOPE record initializer", () => {
  it.each([
    ["01_admission", "HA", "1"],
    ["02_huv1", "HUV", "2"],
    ["03_huv2", "HUV", "3"],
    ["05_discharge", "HD", "9"],
  ] as const)("maps %s add records to ISC/A0250", async (rfaKind, isc, a0250) => {
    await expect(
      initializeNewHopeRecord(registry, { rfaKind, targetDate: "2025-10-01" }),
    ).resolves.toMatchObject({
      specVersionId: "spec-1",
      isc,
      recordType: "add",
      controlAnswers: [
        { itemCode: "A0050", value: "1", source: "derived" },
        { itemCode: "A0250", value: a0250, source: "derived" },
      ],
    });
  });

  it("does not assign a fake official ISC to legacy 04_sfv records", async () => {
    await expect(
      initializeNewHopeRecord(registry, { rfaKind: "04_sfv", targetDate: "2025-10-01" }),
    ).rejects.toBeInstanceOf(HopeUnsupportedOfficialRecordKindError);
  });
});
