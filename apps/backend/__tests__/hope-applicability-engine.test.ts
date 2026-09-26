import { describe, expect, it } from "vitest";
import { createHopeApplicabilityEngine } from "../src/modules/10-hope/spec/applicability-registry";

const engine = createHopeApplicabilityEngine("1.00.1");
const active = [
  "F2000A",
  "F2000B",
  "F2100A",
  "F2100B",
  "F2200A",
  "F2200B",
  "F3000A",
  "F3000B",
  "J0900A",
  "J0900B",
  "J0900C",
  "J0900D",
  "J0905",
  "J0910A",
  "J0910B",
  "J0910C1",
  "J0910C9",
  "J2030A",
  "J2030B",
  "J2030C",
  "J2040A",
  "J2040B",
  "J2050A",
  "J2050B",
  "J2051A",
  "J2051B",
  "J2051C",
  "J2051D",
  "J2051E",
  "J2051F",
  "J2051G",
  "J2051H",
  "J2052A",
  "J2052B",
  "J2052C",
  "J2053A",
  "J2053H",
  "M1190",
  "M1195A",
  "M1195Z",
  "M1200A",
  "M1200Z",
  "N0500A",
  "N0500B",
  "N0510A",
  "N0510B",
  "N0520A",
  "N0520B",
];

function answers(values: Record<string, string>) {
  return new Map(
    Object.entries(values).map(([itemCode, value]) => [
      itemCode,
      { state: "answered" as const, value },
    ]),
  );
}

function state(values: Record<string, string>, itemCode: string) {
  return engine
    .evaluate({ isc: "HA", activeItemCodes: active, answers: answers(values) })
    .items.get(itemCode);
}

describe("HOPE v1.00.1 applicability engine", () => {
  it.each([
    ["F2000A", "F2000B"],
    ["F2100A", "F2100B"],
    ["F2200A", "F2200B"],
    ["F3000A", "F3000B"],
  ] as const)("applies Section F %s/%s skip patterns", (parent, child) => {
    expect(state({}, child)?.applicability).toBe("pending");
    expect(state({ [parent]: "0" }, child)?.applicability).toBe("not_applicable");
    expect(state({ [parent]: "1" }, child)?.applicability).toBe("applicable");
    expect(state({ [parent]: "2" }, child)?.applicability).toBe("applicable");
  });

  it("applies pain screening and comprehensive pain assessment gates", () => {
    expect(state({ J0900A: "0" }, "J0900B")?.applicability).toBe("not_applicable");
    expect(state({ J0900A: "1" }, "J0900D")?.applicability).toBe("applicable");
    expect(state({ J0905: "0" }, "J0910A")?.applicability).toBe("not_applicable");
    expect(state({ J0905: "1", J0910A: "0" }, "J0910C1")?.applicability).toBe("not_applicable");
    expect(state({ J0905: "1", J0910A: "1" }, "J0910C9")?.applicability).toBe("applicable");
  });

  it("applies SOB screening and treatment date branches", () => {
    expect(state({ J2030A: "0" }, "J2040B")?.applicability).toBe("not_applicable");
    expect(state({ J2030A: "1" }, "J2030C")?.applicability).toBe("applicable");
    expect(state({ J2030A: "1", J2030C: "0" }, "J2040A")?.applicability).toBe("not_applicable");
    expect(state({ J2030A: "1", J2030C: "1", J2040A: "2" }, "J2040B")?.applicability).toBe(
      "applicable",
    );
    expect(state({ J2030A: "1", J2030C: "1", J2040A: "1" }, "J2040B")?.applicability).toBe(
      "not_applicable",
    );
  });

  it("keeps J2052 pending until J2051 trigger is definitively true or false", () => {
    expect(state({ J2050A: "1" }, "J2052A")?.applicability).toBe("pending");
    expect(state({ J2050A: "1", J2051A: "2" }, "J2052A")?.applicability).toBe("applicable");
    const falseTrigger = Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((x) => [`J2051${x}`, "9"]),
    );
    expect(state({ J2050A: "1", ...falseTrigger }, "J2052A")?.applicability).toBe("not_applicable");
  });

  it("applies J2052 completed/not-completed branches", () => {
    expect(state({ J2050A: "1", J2051A: "3", J2052A: "1" }, "J2052B")?.applicability).toBe(
      "applicable",
    );
    expect(state({ J2050A: "1", J2051A: "3", J2052A: "1" }, "J2052C")?.applicability).toBe(
      "not_applicable",
    );
    expect(state({ J2050A: "1", J2051A: "3", J2052A: "0" }, "J2053A")?.applicability).toBe(
      "not_applicable",
    );
    expect(state({ J2050A: "1", J2051A: "3", J2052A: "1" }, "J2053H")?.applicability).toBe(
      "applicable",
    );
  });

  it("applies Section M and N gates without treating none-of-above as skip logic", () => {
    expect(state({ M1190: "0" }, "M1195A")?.applicability).toBe("not_applicable");
    expect(state({ M1190: "1", M1195Z: "1" }, "M1195A")?.applicability).toBe("applicable");
    expect(state({ N0500A: "0" }, "N0500B")?.applicability).toBe("not_applicable");
    expect(state({ N0510A: "1" }, "N0510B")?.applicability).toBe("applicable");
    expect(state({ N0500A: "0", N0510A: "0" }, "N0520A")?.applicability).toBe("not_applicable");
    expect(state({ N0500A: "1", N0510A: "0", N0520A: "2" }, "N0520B")?.applicability).toBe(
      "applicable",
    );
    expect(state({ N0500A: "0" }, "N0520A")?.applicability).toBe("pending");
  });
});
