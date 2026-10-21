import type { IpuVisitorRelationship } from "@chartwarden/types";
// GAP-062 — §2.7 the relationship → M39-consent-type mapping the IPU visitor check-in gate keys off.
// The restriction evaluator's own behavior is covered by the M37-T08 suite; this covers the consent half.
import { describe, expect, it } from "vitest";
import {
  IMMEDIATE_FAMILY_RELATIONSHIPS,
  LEGAL_REPRESENTATIVE_CONSENT_TYPES,
  VISITOR_CONSENT_TYPES,
  visitorConsentTypesFor,
} from "../src/domain/visitor/restriction-evaluator";

const ALL_RELATIONSHIPS: readonly IpuVisitorRelationship[] = [
  "spouse",
  "parent",
  "child",
  "sibling",
  "grandparent",
  "grandchild",
  "in_law",
  "aunt_uncle",
  "cousin",
  "friend",
  "clergy",
  "volunteer",
  "caregiver_paid",
  "legal_representative",
  "other",
];

describe("visitorConsentTypesFor (§2.7)", () => {
  it("needs NO consent evaluation for immediate family (W-IPU-07 step 5: a spouse visit is default-OK)", () => {
    for (const r of IMMEDIATE_FAMILY_RELATIONSHIPS) {
      expect(visitorConsentTypesFor(r)).toBeNull();
    }
  });

  it("requires consent for EVERY non-immediate-family relationship — none is silently exempt", () => {
    const nonFamily = ALL_RELATIONSHIPS.filter((r) => !IMMEDIATE_FAMILY_RELATIONSHIPS.includes(r));
    expect(nonFamily.length).toBeGreaterThan(0);
    for (const r of nonFamily) {
      const types = visitorConsentTypesFor(r);
      expect(types, `${r} must be gated`).not.toBeNull();
      expect(types?.length).toBeGreaterThan(0);
    }
  });

  it("covers the whole relationship enum (a new value defaults to GATED, not to admitted)", () => {
    for (const r of ALL_RELATIONSHIPS) {
      const types = visitorConsentTypesFor(r);
      expect(types === null || types.length > 0).toBe(true);
    }
    // The gate is `!isImmediateFamily`, so an enum value added later falls into the gated branch.
    expect(visitorConsentTypesFor("newly_added_relationship" as IpuVisitorRelationship)).toEqual(
      VISITOR_CONSENT_TYPES,
    );
  });

  it("accepts a healthcare DPOA for a legal_representative, on top of the general authorizations", () => {
    expect(visitorConsentTypesFor("legal_representative")).toEqual(
      LEGAL_REPRESENTATIVE_CONSENT_TYPES,
    );
    expect(LEGAL_REPRESENTATIVE_CONSENT_TYPES).toContain("dpoa_healthcare");
    for (const t of VISITOR_CONSENT_TYPES) {
      expect(LEGAL_REPRESENTATIVE_CONSENT_TYPES).toContain(t);
    }
  });

  it("names only M39 consent-type keys that exist in its v1 catalog", () => {
    // Mirrors @chartwarden/consent's CONSENT_TYPE_KEYS — M37 must not invent a type M39 cannot evaluate
    // (an unknown key would return `no_active_consent_on_file` forever and read as a policy denial).
    const M39_V1_KEYS = new Set([
      "portal_access",
      "dpoa_healthcare",
      "dpoa_financial",
      "family_caregiver_access",
      "42_cfr_part_2_release",
      "media_release",
      "research_participation",
      "telehealth_consent",
      "advance_directive_acknowledgment",
      "hipaa_release",
      "bereavement_outreach_consent",
      "custom",
    ]);
    for (const t of LEGAL_REPRESENTATIVE_CONSENT_TYPES) expect(M39_V1_KEYS.has(t)).toBe(true);
  });
});
