// @chartwarden/terminology — M38-T08 seed integration test (spec §3.9, §7.8).
//
// Asserts the platform seed corpus is internally consistent and that the TerminologyProvider seam,
// driven by the in-memory store built from the seed, answers expansion/membership/FHIR against the
// real seeded reference data — the end-to-end path a Phase-1 bootstrap exercises. The §7.8 CPT
// guard is enforced at COMPILE time (the catalog is keyed by CodeSystemId), reinforced at runtime
// here: no seed row may reference 'cpt' or carry the AMA license source.
import { describe, expect, it } from "vitest";
import {
  CODE_SYSTEM_IDS,
  PLATFORM_CODE_SYSTEMS,
  PLATFORM_VALUE_SETS,
  PLATFORM_VALUE_SET_MEMBERS,
  createInMemoryTerminologyStore,
  createTerminologyProvider,
  platformValueSetUrl,
  toInMemorySeed,
} from "../src/index";

const VALID_SCOPES = new Set(["platform", "hospice", "hqrp"]);

// ── §3.9 code-system catalog ──────────────────────────────────────────────────────────
describe("PLATFORM_CODE_SYSTEMS — the Phase-1 code_system catalog (§3.9)", () => {
  it("has exactly one row per CodeSystemId — no gaps, no extras", () => {
    const seeded = PLATFORM_CODE_SYSTEMS.map((c) => c.id).sort();
    const expected = [...CODE_SYSTEM_IDS].sort();
    expect(seeded).toEqual(expected);
    // Length DERIVED from the union, not the literal 11 it used to assert. The parity check above is
    // the real invariant ("one row per CodeSystemId"); a hardcoded count restates it in a second place
    // that has to be hand-edited, so adding `cms_hope` (F-059) failed this line while the invariant it
    // stands for was never violated. Deriving keeps it a check on the CATALOG rather than on the tally.
    expect(PLATFORM_CODE_SYSTEMS).toHaveLength(CODE_SYSTEM_IDS.length);
  });

  it("ids are unique and every row carries a name + source uri", () => {
    expect(new Set(PLATFORM_CODE_SYSTEMS.map((c) => c.id)).size).toBe(CODE_SYSTEM_IDS.length);
    for (const c of PLATFORM_CODE_SYSTEMS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.sourceUri).toMatch(/^https:\/\//);
    }
  });

  it("never references CPT or the AMA license source until D4 unlocks (§7.8)", () => {
    expect(PLATFORM_CODE_SYSTEMS.some((c) => (c.id as string) === "cpt")).toBe(false);
    expect(PLATFORM_CODE_SYSTEMS.some((c) => c.licenseSource === "ama")).toBe(false);
  });
});

// ── §3.9 value-set definitions ────────────────────────────────────────────────────────
describe("PLATFORM_VALUE_SETS — Phase-1 value-set definitions (§3.9)", () => {
  it("seeds the eleven platform value sets with unique slugs and valid scopes", () => {
    expect(PLATFORM_VALUE_SETS).toHaveLength(11);
    expect(new Set(PLATFORM_VALUE_SETS.map((v) => v.id)).size).toBe(11);
    for (const v of PLATFORM_VALUE_SETS) {
      expect(VALID_SCOPES.has(v.scope)).toBe(true);
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
    }
  });
});

// ── §3.9 curated member referential integrity ─────────────────────────────────────────
describe("PLATFORM_VALUE_SET_MEMBERS — curated reference-set members (§3.9 curation file)", () => {
  const valueSetIds = new Set(PLATFORM_VALUE_SETS.map((v) => v.id));
  const codeSystemIds = new Set(PLATFORM_CODE_SYSTEMS.map((c) => c.id));

  it("every curated member references a seeded value set and a seeded code system", () => {
    for (const m of PLATFORM_VALUE_SET_MEMBERS) {
      expect(valueSetIds.has(m.valueSetId)).toBe(true);
      expect(codeSystemIds.has(m.systemId)).toBe(true);
      expect(m.display.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate (valueSetId, systemId, code) rows", () => {
    const keys = PLATFORM_VALUE_SET_MEMBERS.map((m) => `${m.valueSetId} ${m.systemId} ${m.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fully enumerates the two spec-listed reference sets", () => {
    const loc = PLATFORM_VALUE_SET_MEMBERS.filter((m) => m.valueSetId === "level_of_care");
    expect(loc.map((m) => m.code).sort()).toEqual(["0651", "0652", "0655", "0656"]);
    const q = PLATFORM_VALUE_SET_MEMBERS.filter((m) => m.valueSetId === "place_of_service_q_codes");
    expect(q).toHaveLength(10); // Q5001..Q5010
    expect(q.every((m) => m.systemId === "hcpcs" && /^Q50(0[1-9]|10)$/.test(m.code))).toBe(true);
    const modifiers = PLATFORM_VALUE_SET_MEMBERS.filter(
      (m) => m.valueSetId === "cms_hospice_modifiers",
    );
    expect(modifiers.map((m) => m.code).sort()).toEqual(["GV", "GW"]);
    expect(modifiers.every((m) => m.systemId === "hcpcs")).toBe(true);
  });
});

// ── seam integration: provider over the in-memory store built from the seed ───────────
describe("TerminologyProvider over the seed corpus (§3.9 → §4.5 end-to-end)", () => {
  const { store } = createInMemoryTerminologyStore(toInMemorySeed());
  const provider = createTerminologyProvider(store);

  it("expands a curated value set to exactly its seeded members", async () => {
    const out: string[] = [];
    for await (const m of provider.expand("level_of_care")) out.push(m.code);
    expect(out.sort()).toEqual(["0651", "0652", "0655", "0656"]);
  });

  it("resolves platform membership from the seed (hit and miss)", async () => {
    expect(await provider.isMemberOf("place_of_service_q_codes", "hcpcs", "Q5006")).toEqual({
      isMember: true,
      source: "platform",
    });
    expect(await provider.isMemberOf("place_of_service_q_codes", "hcpcs", "Q9999")).toEqual({
      isMember: false,
      source: null,
    });
  });

  it("projects a seeded value set to FHIR with its canonical url", async () => {
    const vs = await provider.asFhirValueSet("level_of_care");
    expect(vs.url).toBe(platformValueSetUrl("level_of_care"));
    expect(vs.expansion.total).toBe(4);
  });
});
