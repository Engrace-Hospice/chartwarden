// WF09 — the ADL record authoring rules (pure): validation of the PUT body, the stored column shape, and the note-fact mapping.
import { ADL_DEVICES, ADL_ITEMS, ADL_LEVELS, CONTINENCE_LEVELS } from "@chartwarden/hearthnote";
import { describe, expect, it } from "vitest";
import {
  type AdlColumns,
  planAdlRecord,
  recordedAdlFromRow,
} from "../src/modules/08-encounters/findings/adl";

const EMPTY: AdlColumns = {
  bathing: null,
  dressing: null,
  grooming: null,
  toileting: null,
  transferring: null,
  ambulation: null,
  eating: null,
  bladder: null,
  bowel: null,
  devices: [],
};

describe("planAdlRecord", () => {
  it("maps every ADL item to its column and leaves the rest null", () => {
    // Arrange
    const input = { items: { bathing: "limited_assist", eating: "independent" } } as const;

    // Act
    const columns = planAdlRecord(input);

    // Assert
    expect(columns).toEqual({ ...EMPTY, bathing: "limited_assist", eating: "independent" });
  });

  it("accepts every documented level for every item, continence level and device", () => {
    for (const item of ADL_ITEMS)
      for (const level of ADL_LEVELS)
        expect(planAdlRecord({ items: { [item]: level } })[item]).toBe(level);
    for (const level of CONTINENCE_LEVELS) {
      expect(planAdlRecord({ bladder: level }).bladder).toBe(level);
      expect(planAdlRecord({ bowel: level }).bowel).toBe(level);
    }
    expect(planAdlRecord({ devices: [...ADL_DEVICES] }).devices).toEqual([...ADL_DEVICES]);
  });

  it("treats an empty body as a cleared record", () => {
    expect(planAdlRecord({})).toEqual(EMPTY);
  });

  it("drops an item sent as null (not assessed)", () => {
    expect(planAdlRecord({ items: { bathing: null } }).bathing).toBeNull();
  });

  it("de-duplicates devices and returns them in the documented order", () => {
    const columns = planAdlRecord({ devices: ["walker", "cane", "walker"] });
    expect(columns.devices).toEqual(["cane", "walker"]);
  });

  it.each([
    ["an unknown level", { items: { bathing: "mostly" } }, "items.bathing"],
    ["an unknown item", { items: { swimming: "independent" } }, "items.swimming"],
    ["an item given a continence value", { items: { dressing: "continent" } }, "items.dressing"],
    ["an unknown bladder level", { bladder: "independent" }, "bladder"],
    ["an unknown bowel level", { bowel: "leaky" }, "bowel"],
    ["an unknown device", { devices: ["cane", "jetpack"] }, "devices.1"],
  ])("rejects %s with a 422 naming the field", (_name, input, field) => {
    // Act
    const run = () => planAdlRecord(input as never);

    // Assert
    expect(run).toThrowError(
      expect.objectContaining({ statusCode: 422, code: "VALIDATION_FAILED" }),
    );
    try {
      run();
    } catch (e) {
      expect((e as { details?: { field: string }[] }).details?.[0]?.field).toBe(field);
    }
  });
});

describe("recordedAdlFromRow", () => {
  it("omits null fields and an empty device list", () => {
    expect(recordedAdlFromRow({ ...EMPTY, bathing: "supervision", bowel: "continent" })).toEqual({
      items: { bathing: "supervision" },
      bowel: "continent",
    });
  });

  it("returns an empty object for a row that recorded nothing", () => {
    expect(recordedAdlFromRow(EMPTY)).toEqual({});
  });

  it("carries the devices through", () => {
    expect(recordedAdlFromRow({ ...EMPTY, devices: ["walker"] })).toEqual({ devices: ["walker"] });
  });
});
