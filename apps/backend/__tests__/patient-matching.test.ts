import { describe, expect, it } from "vitest";
// apps/backend/__tests__/patient-matching.test.ts — M5-T06 patient-matching pipeline
// (§2.3, §7.2 hard block, §7.3 soft review, W-M5-17 SSN ignore; D2).
import {
  DEFAULT_THRESHOLDS,
  type MatchCandidate,
  type MatchSubject,
  clampThresholds,
  jaroWinkler,
  levenshtein,
  normalizeSubject,
  probabilisticScore,
  runMatch,
  stripForbiddenProposalFields,
} from "../src/modules/05-patient/matching/index";

const ada: MatchCandidate = {
  id: "p-ada",
  lastName: "LOVELACE",
  firstName: "ADA",
  dob: "1990-01-01",
  mbi: "1EG4TE5MK73",
  ssn: "123456789",
  primaryAddress: { line1: "10 ANALYTICAL WAY", city: "LONDON", postalCode: "97201" },
  phoneLast7: "5550100",
  email: "ada@example.com",
};

describe("similarity primitives (§2.3)", () => {
  it("jaroWinkler is 1 for equal, boosts shared prefixes, 0 for disjoint", () => {
    expect(jaroWinkler("SMITH", "SMITH")).toBe(1);
    expect(jaroWinkler("MARY", "MARIA")).toBeGreaterThan(0.8);
    expect(jaroWinkler("SMITH", "SMYTH")).toBeGreaterThan(0.8);
    expect(jaroWinkler("AAAA", "BBBB")).toBe(0);
  });
  it("levenshtein counts edits", () => {
    expect(levenshtein("1990-01-01", "1990-01-01")).toBe(0);
    expect(levenshtein("1990-01-01", "1990-01-02")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("§7.2 hard duplicate block (deterministic)", () => {
  it("exact MBI → hard_block matchedOn mbi (no row created)", () => {
    const incoming = normalizeSubject({
      lastName: "Smith",
      firstName: "Ada",
      dob: "1991-02-02",
      mbi: "1EG4-TE5-MK73",
    });
    const r = runMatch(incoming, [ada]);
    expect(r.outcome).toBe("hard_block");
    if (r.outcome === "hard_block") {
      expect(r.matchedOn).toBe("mbi");
      expect(r.existingPatientId).toBe("p-ada");
    }
  });
  it("exact SSN + exact DOB → hard_block matchedOn ssn_dob", () => {
    const incoming = normalizeSubject({
      lastName: "Different",
      firstName: "Name",
      dob: "1990-01-01",
      ssn: "123-45-6789",
    });
    const r = runMatch(incoming, [ada]);
    expect(r.outcome).toBe("hard_block");
    if (r.outcome === "hard_block") expect(r.matchedOn).toBe("ssn_dob");
  });
  it("exact DOB + name + primary address → hard_block matchedOn dob_name_address", () => {
    const incoming = normalizeSubject({
      lastName: "lovelace",
      firstName: "ada",
      dob: "1990-01-01",
      primaryAddress: { line1: "10 Analytical Way", city: "London", postalCode: "97201" },
    });
    const r = runMatch(incoming, [ada]);
    expect(r.outcome).toBe("hard_block");
    if (r.outcome === "hard_block") expect(r.matchedOn).toBe("dob_name_address");
  });
  it("a probabilistic score ≥ 0.92 also hard-blocks (no deterministic rule fired)", () => {
    // firstName 'Adah' ≠ 'Ada' breaks the dob_name_address deterministic rule, but exact last name +
    // exact address + exact DOB + phone + email still push the probabilistic score over 0.92.
    const incoming = normalizeSubject({
      lastName: "Lovelace",
      firstName: "Adah",
      dob: "1990-01-01",
      primaryAddress: { line1: "10 Analytical Way", city: "London", postalCode: "97201" },
      phone: "555-0100",
      email: "ada@example.com",
    });
    const r = runMatch(incoming, [{ ...ada, mbi: null, ssn: null }]);
    expect(r.outcome).toBe("hard_block");
    if (r.outcome === "hard_block") {
      expect(r.matchedOn).toBe("probabilistic");
      expect(r.score).toBeGreaterThanOrEqual(0.92);
    }
  });
});

describe("§7.3 soft duplicate review", () => {
  it("a 0.83-ish fuzzy match (Mary Smith vs Maria Smyth) opens a review, does not block", () => {
    const existing: MatchCandidate = {
      id: "p-smyth",
      lastName: "SMYTH",
      firstName: "MARIA",
      dob: "1980-03-03",
      mbi: null,
      ssn: null,
      primaryAddress: { line1: "5 OAK ST", city: "PORTLAND", postalCode: "97201" },
      phoneLast7: null,
      email: null,
    };
    const incoming = normalizeSubject({
      lastName: "Smith",
      firstName: "Mary",
      dob: "1980-03-03",
      primaryAddress: { line1: "5 Oak St", city: "Portland", postalCode: "97201" },
    });
    const r = runMatch(incoming, [existing]);
    expect(r.outcome).toBe("soft_review");
    if (r.outcome === "soft_review") {
      expect(r.reviewCandidates.map((c) => c.id)).toContain("p-smyth");
      expect(r.reviewCandidates[0].score).toBeGreaterThanOrEqual(0.75);
      expect(r.reviewCandidates[0].score).toBeLessThan(0.92);
    }
  });
  it("a low score quietly creates (no review)", () => {
    const incoming = normalizeSubject({ lastName: "Zzz", firstName: "Qqq", dob: "1971-07-07" });
    const r = runMatch(incoming, [ada]);
    expect(r.outcome).toBe("quiet_create");
  });
  it("no candidates → quiet create", () => {
    const incoming = normalizeSubject({
      lastName: "Anyone",
      firstName: "Nobody",
      dob: "2000-01-01",
    });
    expect(runMatch(incoming, []).outcome).toBe("quiet_create");
  });
});

describe("W-M5-17 SSN ignored even if present (defense in depth)", () => {
  it("SSN is never a probabilistic feature — two people sharing SSN but nothing else don't fuzzy-match", () => {
    // Same SSN, different DOB (so the deterministic ssn_dob rule does NOT fire), nothing else alike.
    const incoming = normalizeSubject({
      lastName: "Nomatch",
      firstName: "Xyz",
      dob: "1999-09-09",
      ssn: "123-45-6789",
    });
    const score = probabilisticScore(incoming, ada);
    expect(score).toBeLessThan(0.5); // SSN contributes nothing to the score
    expect(runMatch(incoming, [ada]).outcome).toBe("quiet_create");
  });
  it("the proposal policy strips ssn (and other forbidden identifiers) from an M29 patch", () => {
    const { applied, stripped } = stripForbiddenProposalFields({
      legalLastName: "Smith",
      ssn: "123456789",
      mrn: "SHOULD-NOT",
      preferredLanguageCode: "es",
    });
    expect(stripped).toContain("ssn");
    expect(stripped).toContain("mrn");
    expect(applied).toEqual({ legalLastName: "Smith", preferredLanguageCode: "es" });
    expect("ssn" in applied).toBe(false);
  });
});

describe("D2 threshold bounds", () => {
  it("clamps hard ≥ 0.85, soft ≤ 0.80, keeps hard > soft", () => {
    const t = clampThresholds({ hard: 0.7, soft: 0.95 });
    expect(t.hard).toBe(0.85);
    expect(t.soft).toBeLessThanOrEqual(0.8);
    expect(t.hard).toBeGreaterThan(t.soft);
  });
  it("default thresholds are 0.92 / 0.75", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ hard: 0.92, soft: 0.75 });
  });
});
