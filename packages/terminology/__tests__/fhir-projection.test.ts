// @chartwarden/terminology — M38-T09 golden FHIR-projection tests (spec §7.9, §2.5).
//
// §7.9 done-means: `asFhirCodeSystem('loinc', '2024-08-01')` produces BYTE-IDENTICAL output to a
// golden fixture for that asOf; Module 28 maps that internal projection to the FHIR R4 wire shape.
// These golden tests live in M38 (the projection); M28 owns the wire-shape golden separately.
//
// What we pin here (the M28 contract):
//   • the exact projection object for a fixed (system, asOf) and (valueSetId, asOf);
//   • determinism — two calls are byte-identical;
//   • ordering is (system, code)-stable and INDEPENDENT of store/seed insertion order, so a load
//     re-ordering rows can never perturb the projection M28 consumes.
import { describe, expect, it } from "vitest";
import {
  type ResolvedConcept,
  createInMemoryTerminologyStore,
  createTerminologyProvider,
} from "../src/index";

const loinc = (code: string, display: string, effectiveDate: string): ResolvedConcept<"loinc"> => ({
  systemId: "loinc",
  code,
  display,
  status: "active",
  effectiveDate,
  endDate: null,
  properties: {
    component: null,
    property: null,
    time: null,
    system: null,
    scale: null,
    method: null,
    shortName: null,
  },
});

const LOINC_META = { url: "http://loinc.org", version: "2.76" };
const VS_URL = "urn:chartwarden:valueset:hospice_vitals";

// Three LOINC concepts, deliberately seeded OUT of code order to prove the projection sorts.
const CONCEPTS: ResolvedConcept<"loinc">[] = [
  loinc("8867-4", "Heart rate", "2020-01-01"),
  loinc("29463-7", "Body weight", "2020-01-01"),
  loinc("8480-6", "Systolic blood pressure", "2020-01-01"),
  // Not yet effective at the 2024-08-01 asOf — must be absent from that projection.
  loinc("99999-9", "Future panel", "2025-01-01"),
];

const VALUE_SET_MEMBERS = [
  {
    valueSetId: "hospice_vitals",
    systemId: "loinc" as const,
    code: "8480-6",
    display: "Systolic blood pressure",
    annotations: {},
  },
  {
    valueSetId: "hospice_vitals",
    systemId: "loinc" as const,
    code: "8867-4",
    display: "Heart rate",
    annotations: {},
  },
];

function makeProvider(concepts = CONCEPTS) {
  const { store } = createInMemoryTerminologyStore({
    concepts,
    valueSetMembers: VALUE_SET_MEMBERS,
    codeSystemMeta: { loinc: LOINC_META },
    valueSetUrls: { hospice_vitals: VS_URL },
  });
  return createTerminologyProvider(store);
}

// The frozen golden objects M28 maps to FHIR R4. Any change here is a deliberate contract change.
const GOLDEN_CODE_SYSTEM = {
  resourceType: "CodeSystem",
  url: "http://loinc.org",
  version: "2.76",
  status: "active",
  content: "complete",
  concept: [
    { code: "29463-7", display: "Body weight" },
    { code: "8480-6", display: "Systolic blood pressure" },
    { code: "8867-4", display: "Heart rate" },
  ],
};

const GOLDEN_VALUE_SET = {
  resourceType: "ValueSet",
  url: VS_URL,
  status: "active",
  expansion: {
    timestamp: "2024-08-01T00:00:00Z",
    total: 2,
    contains: [
      { system: "loinc", code: "8480-6", display: "Systolic blood pressure" },
      { system: "loinc", code: "8867-4", display: "Heart rate" },
    ],
  },
};

describe("M38-T09 — golden FHIR projection (§7.9)", () => {
  it("asFhirCodeSystem('loinc', 2024-08-01) is byte-identical to the golden fixture", async () => {
    const cs = await makeProvider().asFhirCodeSystem("loinc", new Date("2024-08-01"));
    // Byte-identical, not just deep-equal: M28's wire mapper depends on stable serialization.
    expect(JSON.stringify(cs)).toBe(JSON.stringify(GOLDEN_CODE_SYSTEM));
    // The future-dated concept (effective 2025) is absent at this asOf.
    expect(cs.concept.map((c) => c.code)).not.toContain("99999-9");
  });

  it("asFhirValueSet('hospice_vitals', 2024-08-01) is byte-identical to the golden fixture", async () => {
    const vs = await makeProvider().asFhirValueSet("hospice_vitals", {
      asOf: new Date("2024-08-01"),
    });
    expect(JSON.stringify(vs)).toBe(JSON.stringify(GOLDEN_VALUE_SET));
  });

  it("projections are deterministic across repeated calls", async () => {
    const p = makeProvider();
    const a = JSON.stringify(await p.asFhirCodeSystem("loinc", new Date("2024-08-01")));
    const b = JSON.stringify(await p.asFhirCodeSystem("loinc", new Date("2024-08-01")));
    expect(a).toBe(b);
  });

  it("ordering is independent of seed insertion order (a reordered load can't perturb M28)", async () => {
    const forward = await makeProvider(CONCEPTS).asFhirCodeSystem("loinc", new Date("2024-08-01"));
    const reversed = await makeProvider([...CONCEPTS].reverse()).asFhirCodeSystem(
      "loinc",
      new Date("2024-08-01"),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
