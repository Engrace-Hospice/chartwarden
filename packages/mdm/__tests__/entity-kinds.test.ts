// @wardenx/mdm — M40-T01 unit tests (spec §2.3, §2.4, §3.2).
//
// Locks the entity-kind discriminator + the §2.3 canonical-vs-overlay dividing line: the
// descriptor table covers every kind exactly once, the Phase-1 flags track the manifest's 11
// owned tables (physician/facility/payer canonical + the physician overlay only), and the
// §2.3 placement table sorts each field class to canonical or overlay as written.
import { describe, expect, it } from "vitest";
import {
  FIELD_PLACEMENT_RULES,
  MDM_ENTITY_KINDS,
  MDM_ENTITY_KIND_DESCRIPTORS,
  PHASE_1_CANONICAL_KINDS,
} from "../src/index";

describe("entity kind discriminator (§2.3, §2.4)", () => {
  it("has a descriptor for every kind, keyed by its own kind", () => {
    for (const kind of MDM_ENTITY_KINDS) {
      const d = MDM_ENTITY_KIND_DESCRIPTORS[kind];
      expect(d).toBeDefined();
      expect(d.kind).toBe(kind);
    }
    expect(Object.keys(MDM_ENTITY_KIND_DESCRIPTORS).sort()).toEqual([...MDM_ENTITY_KINDS].sort());
  });

  it("Phase-1 canonical kinds are exactly physician/facility/payer (manifest §3.3)", () => {
    expect([...PHASE_1_CANONICAL_KINDS].sort()).toEqual(["facility", "payer", "physician"]);
  });

  it("only physician ships a Phase-1 overlay table (manifest §3.4)", () => {
    const overlay = MDM_ENTITY_KINDS.filter((k) => MDM_ENTITY_KIND_DESCRIPTORS[k].phase1Overlay);
    expect(overlay).toEqual(["physician"]);
    // an overlay only exists where a canonical row exists
    for (const k of MDM_ENTITY_KINDS) {
      const d = MDM_ENTITY_KIND_DESCRIPTORS[k];
      if (d.phase1Overlay) expect(d.phase1Canonical).toBe(true);
    }
  });
});

describe("the §2.3 canonical-vs-overlay dividing line", () => {
  it("identity / registry-sourced / status / hierarchy classes are canonical", () => {
    const canonical = (
      Object.keys(FIELD_PLACEMENT_RULES) as (keyof typeof FIELD_PLACEMENT_RULES)[]
    ).filter((c) => FIELD_PLACEMENT_RULES[c].placement === "canonical");
    expect(canonical.sort()).toEqual(
      [
        "demographic_registry_attribute",
        "hierarchy_parent",
        "operational_status",
        "public_identifier",
      ].sort(),
    );
  });

  it("this-tenant's-opinion classes (incl. BAA state) are overlay", () => {
    expect(FIELD_PLACEMENT_RULES.baa_execution_state.placement).toBe("overlay");
    expect(FIELD_PLACEMENT_RULES.contract_terms.placement).toBe("overlay");
    expect(FIELD_PLACEMENT_RULES.do_not_refer.placement).toBe("overlay");
    expect(FIELD_PLACEMENT_RULES.preferred_contact.placement).toBe("overlay");
  });
});
