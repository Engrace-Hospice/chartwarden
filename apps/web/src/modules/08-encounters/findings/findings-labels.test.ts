// The value sets here are copies of packages/hearthnote/src/assembly/types.ts (this app does not depend on @chartwarden/hearthnote), so
// this test reads that file and fails the moment either side adds, removes, renames or reorders a code. It reads the source as text
// (`?raw`) rather than importing the package: a package import from this app is outside its TypeScript project.
import { describe, expect, it } from "vitest";
import hearthnoteTypes from "../../../../../../packages/hearthnote/src/assembly/types.ts?raw";
import * as labels from "./findings-labels";
import { findingFieldLabel } from "./findings-labels";

/** The string members of `export const NAME = [ ... ] as const` in the hearthnote source. */
function hearthnoteSet(name: string): readonly string[] {
  const declaration = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(
    hearthnoteTypes,
  );
  if (!declaration) throw new Error(`${name} is no longer exported by packages/hearthnote`);
  return [...(declaration[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

const SETS = [
  ["ADL_ITEMS", labels.ADL_ITEMS, labels.ADL_ITEM_LABEL],
  ["ADL_LEVELS", labels.ADL_LEVELS, labels.ADL_LEVEL_LABEL],
  ["CONTINENCE_LEVELS", labels.CONTINENCE_LEVELS, labels.CONTINENCE_LABEL],
  ["ADL_DEVICES", labels.ADL_DEVICES, labels.ADL_DEVICE_LABEL],
  ["APPETITE_LEVELS", labels.APPETITE_LEVELS, labels.APPETITE_LABEL],
  ["FLUID_INTAKE_LEVELS", labels.FLUID_INTAKE_LEVELS, labels.FLUID_INTAKE_LABEL],
  ["SWALLOWING_LEVELS", labels.SWALLOWING_LEVELS, labels.SWALLOWING_LABEL],
  ["NUTRITION_SUPPORTS", labels.NUTRITION_SUPPORTS, labels.NUTRITION_SUPPORT_LABEL],
] as const;

describe("findings value sets", () => {
  it.each(SETS)("%s matches @chartwarden/hearthnote, code for code and in order", (name, local) => {
    expect([...local]).toEqual(hearthnoteSet(name));
  });

  it.each(SETS)(
    "%s has a plain-language label for every code and no others",
    (_name, codes, table) => {
      expect(Object.keys(table)).toEqual([...codes]);
      for (const label of Object.values(table)) {
        expect(label).toMatch(/^[A-Z][A-Za-z ]+$/);
      }
    },
  );
});

describe("select options", () => {
  it("lead with Not assessed as the empty value, then every code in order", () => {
    expect(labels.ADL_LEVEL_OPTIONS[0]).toEqual({ value: "", label: "Not assessed" });
    expect(labels.ADL_LEVEL_OPTIONS.slice(1).map((option) => option.value)).toEqual([
      ...labels.ADL_LEVELS,
    ]);
    expect(labels.SWALLOWING_OPTIONS.map((option) => option.label)).toEqual([
      "Not assessed",
      "No difficulty",
      "Difficulty with solids",
      "Difficulty with liquids",
      "Difficulty with solids and liquids",
      "Unable to swallow",
    ]);
  });

  it("codeOf names the code a value selects, and null for Not assessed or a stranger", () => {
    expect(labels.codeOf(labels.APPETITE_LEVELS, "poor")).toBe("poor");
    expect(labels.codeOf(labels.APPETITE_LEVELS, "")).toBeNull();
    expect(labels.codeOf(labels.APPETITE_LEVELS, "ravenous")).toBeNull();
  });
});

describe("findingFieldLabel", () => {
  it("names the fields the server reports in a 422", () => {
    expect(findingFieldLabel("items.bathing")).toBe("Bathing");
    expect(findingFieldLabel("items.levitation")).toBe("Activity level");
    expect(findingFieldLabel("devices.2")).toBe("Assistive devices");
    expect(findingFieldLabel("mealIntakePercent")).toBe("Share of meals eaten");
    expect(findingFieldLabel("bladder")).toBe("Bladder");
    expect(findingFieldLabel("constructor")).toBeNull();
    expect(findingFieldLabel("(root)")).toBeNull();
  });
});
