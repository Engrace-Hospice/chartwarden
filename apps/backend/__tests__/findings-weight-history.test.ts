// WF09 — weight history (pure): the weight this visit recorded, the one on the patient's previous visit, and the last six.
import { describe, expect, it } from "vitest";
import {
  WEIGHT_HISTORY_LIMIT,
  type WeightSetRow,
  summariseWeights,
} from "../src/modules/08-encounters/findings/weight-history";

const THIS = "enc-this";
let clock = 0;
/** A vitals set: later calls are captured later. */
const set = (
  encounterId: string,
  serviceDate: string,
  weight: string | null,
  unit: string | null = "lb",
): WeightSetRow => ({
  encounterId,
  serviceDate,
  capturedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, clock++)),
  weight,
  weightUnit: unit,
});

describe("summariseWeights", () => {
  it("returns nothing for a patient with no recorded weight", () => {
    expect(summariseWeights([], THIS)).toEqual({ current: null, prior: null, history: [] });
  });

  it("reports this visit's weight as current and the previous visit's as prior", () => {
    // Arrange
    const rows = [
      set(THIS, "2026-03-10", "150.5", "lb"),
      set("enc-1", "2026-03-03", "152", "lb"),
      set("enc-0", "2026-02-24", "154", "lb"),
    ];

    // Act
    const result = summariseWeights(rows, THIS);

    // Assert
    expect(result.current).toEqual({ value: "150.5", unit: "lb", on: "2026-03-10" });
    expect(result.prior).toEqual({ value: "152", unit: "lb", on: "2026-03-03" });
    expect(result.history.map((h) => h.on)).toEqual(["2026-03-10", "2026-03-03", "2026-02-24"]);
  });

  it("has a prior but no current when this visit recorded no weight", () => {
    const result = summariseWeights([set("enc-1", "2026-03-03", "152")], THIS);
    expect(result.current).toBeNull();
    expect(result.prior).toEqual({ value: "152", unit: "lb", on: "2026-03-03" });
  });

  it("orders by service date whatever order the rows arrive in", () => {
    const rows = [set("enc-0", "2026-02-24", "154"), set("enc-1", "2026-03-03", "152")];
    expect(summariseWeights(rows, THIS).prior?.on).toBe("2026-03-03");
  });

  it("uses the latest capture within one encounter", () => {
    const rows = [set("enc-1", "2026-03-03", "151"), set("enc-1", "2026-03-03", "152")];
    const result = summariseWeights(rows, THIS);
    expect(result.prior?.value).toBe("152");
    expect(result.history).toHaveLength(1);
  });

  it("breaks a same-day tie between two encounters by the newer capture", () => {
    const rows = [set("enc-a", "2026-03-03", "151"), set("enc-b", "2026-03-03", "152")];
    expect(summariseWeights(rows, THIS).prior?.value).toBe("152");
  });

  it("skips a set with no usable weight and falls back to the previous reading in that encounter", () => {
    const rows = [
      set("enc-1", "2026-03-03", "152"),
      set("enc-1", "2026-03-03", "  "),
      set("enc-1", "2026-03-03", null),
      set("enc-1", "2026-03-03", "abc"),
      set("enc-1", "2026-03-03", "0"),
    ];
    expect(summariseWeights(rows, THIS).prior?.value).toBe("152");
  });

  it("skips a weight stored without a unit, since the note cannot state it", () => {
    const rows = [set("enc-1", "2026-03-03", "152", null), set("enc-0", "2026-02-24", "154")];
    expect(summariseWeights(rows, THIS).prior).toEqual({
      value: "154",
      unit: "lb",
      on: "2026-02-24",
    });
  });

  it("keeps the unit each weight was recorded in", () => {
    const rows = [set(THIS, "2026-03-10", "68", "kg"), set("enc-1", "2026-03-03", "150", "lb")];
    const result = summariseWeights(rows, THIS);
    expect(result.current?.unit).toBe("kg");
    expect(result.prior?.unit).toBe("lb");
  });

  it("caps the history at the six most recent weights", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      set(`enc-${i}`, `2026-02-${String(10 + i).padStart(2, "0")}`, String(150 + i)),
    );
    const result = summariseWeights(rows, THIS);
    expect(result.history).toHaveLength(WEIGHT_HISTORY_LIMIT);
    expect(result.history[0]?.on).toBe("2026-02-18");
    expect(result.history[5]?.on).toBe("2026-02-13");
  });
});
