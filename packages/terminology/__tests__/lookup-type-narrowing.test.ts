// @wardenx/terminology — M38-T11 test plan §9.1 "Lookup type narrowing".
//
// The seam is per-system, not one polymorphic concept table (M38-T01 rationale): `lookup<S>`
// narrows `properties` to the system's bespoke shape. `lookup('loinc', …)` yields the six LOINC
// axes; `lookup('rxnorm', …)` yields RxNorm's `tty`; a system without a Phase-1 table falls back
// to the empty `GenericConceptProperties`. The narrowing is a COMPILE-time contract enforced in
// `src` (the `ConceptPropertiesBySystem` map keys `ResolvedConcept<S>`); `expectTypeOf` pins it
// here as documentation, and the runtime fixtures below prove the resolved shape carries the
// per-system columns end-to-end.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ConceptProperties,
  type GenericConceptProperties,
  type LoincProperties,
  type ResolvedConcept,
  type RxnormProperties,
  resolveAsOf,
} from "../src/index";

describe("ConceptProperties<S> narrows per system (§9.1 compile-time)", () => {
  it("loinc properties are the six-axis model; rxnorm carries TTY; revenue falls back to generic", () => {
    expectTypeOf<ConceptProperties<"loinc">>().toEqualTypeOf<LoincProperties>();
    expectTypeOf<ConceptProperties<"rxnorm">>().toEqualTypeOf<RxnormProperties>();
    expectTypeOf<ConceptProperties<"revenue">>().toEqualTypeOf<GenericConceptProperties>();
    // The axes/TTY are present on the narrowed type, and NOT cross-assignable between systems.
    expectTypeOf<ConceptProperties<"loinc">>().toHaveProperty("component");
    expectTypeOf<ConceptProperties<"rxnorm">>().toHaveProperty("tty");
    expectTypeOf<ConceptProperties<"loinc">>().not.toMatchTypeOf<RxnormProperties>();
  });
});

describe("resolveAsOf<S> threads the narrowed properties through to the resolved row (§9.1)", () => {
  const loinc: ResolvedConcept<"loinc"> = {
    systemId: "loinc",
    code: "718-7",
    display: "Hemoglobin [Mass/volume] in Blood",
    status: "active",
    effectiveDate: "2020-01-01",
    endDate: null,
    properties: {
      component: "Hemoglobin",
      property: "MCnc",
      time: "Pt",
      system: "Bld",
      scale: "Qn",
      method: null,
      shortName: "Hgb Bld-mCnc",
    },
  };

  const rxnorm: ResolvedConcept<"rxnorm"> = {
    systemId: "rxnorm",
    code: "1049502",
    display: "acetaminophen 325 MG Oral Tablet",
    status: "active",
    effectiveDate: "2019-01-01",
    endDate: null,
    properties: { tty: "SCD", ingredientRxcui: "161", ndcs: ["00000-0000-01"] },
  };

  it("a resolved LOINC concept exposes its axes at runtime", () => {
    const r = resolveAsOf([loinc], new Date("2024-06-15T00:00:00Z"));
    expect(r).not.toBeNull();
    // The compiler knows `r.properties` is LoincProperties; the runtime row carries the axes.
    expectTypeOf(r!.properties).toEqualTypeOf<LoincProperties>();
    expect(r!.properties.component).toBe("Hemoglobin");
    expect(r!.properties.scale).toBe("Qn");
  });

  it("a resolved RxNorm concept exposes TTY at runtime", () => {
    const r = resolveAsOf([rxnorm], new Date("2024-06-15T00:00:00Z"));
    expect(r).not.toBeNull();
    expectTypeOf(r!.properties).toEqualTypeOf<RxnormProperties>();
    expect(r!.properties.tty).toBe("SCD");
    expect(r!.properties.ndcs).toContain("00000-0000-01");
  });
});
