import { describe, expect, it } from "vitest";
import { type CoverageInput, checkCoverage, currentInput } from "../check-pdf-template-coverage";

const base: CoverageInput = {
  rendererKeys: ["a", "b", "c"],
  builderKeys: ["a"],
  formsKeys: ["a", "b", "c_letter", "only_form"],
  requestKeys: ["a", "b"],
  genericAllowlist: { b: "wave 2", c: "wave 3" },
  aliases: { c_letter: "c" },
  formsOnly: { only_form: "no render path" },
};

describe("arch:pdf-templates", () => {
  it("passes a consistent registry", () => {
    expect(checkCoverage(base)).toEqual([]);
  });

  it("fails a renderer key with neither a builder nor an allow-list reason (no silent generic default)", () => {
    const v = checkCoverage({ ...base, rendererKeys: [...base.rendererKeys, "d"] });
    expect(v.join("\n")).toContain("renderer key 'd' has no bespoke builder");
  });

  it("ratchet: an allow-listed key that gained a builder must be deleted", () => {
    const v = checkCoverage({ ...base, builderKeys: ["a", "b"] });
    expect(v.join("\n")).toContain("GENERIC_ALLOWLIST 'b' now has a bespoke builder");
  });

  it("fails an allow-list entry that names no renderer key, or has no reason", () => {
    expect(
      checkCoverage({ ...base, genericAllowlist: { ...base.genericAllowlist, z: "x" } }).join(),
    ).toContain("'z' is not a renderer key");
    expect(checkCoverage({ ...base, genericAllowlist: { b: " ", c: "ok" } }).join()).toContain(
      "no reason",
    );
  });

  it("fails a forms key that resolves nowhere (registry drift)", () => {
    const v = checkCoverage({ ...base, formsKeys: [...base.formsKeys, "drifted"] });
    expect(v.join("\n")).toContain("forms-registry key 'drifted' resolves to no renderer key");
  });

  it("fails dead aliases and a forms-only key that gained a render path", () => {
    expect(checkCoverage({ ...base, aliases: { c_letter: "nope" } }).join()).toContain(
      "target is not a renderer key",
    );
    expect(checkCoverage({ ...base, formsOnly: { only_form: "r", a: "r" } }).join()).toContain(
      "FORMS_ONLY 'a' now has a renderer key",
    );
  });

  it("fails a render request that names a template the renderer refuses (M13 reconciliation worksheet class)", () => {
    const v = checkCoverage({ ...base, requestKeys: ["a", "ghost"] });
    expect(v.join("\n")).toContain("names template 'ghost'");
  });

  it("the live registries are consistent", () => {
    expect(checkCoverage(currentInput())).toEqual([]);
  });

  it("every template the request table names statically is published (guards the M13 worksheet)", () => {
    const input = currentInput();
    expect(input.requestKeys).toContain("medication_reconciliation_worksheet");
    expect(input.rendererKeys).toContain("medication_reconciliation_worksheet");
  });
});
