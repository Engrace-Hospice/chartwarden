import { describe, expect, it } from "vitest";
import {
  buildClaimSnapshot,
  claimDiagnosisSnapshot,
  claimPhysicianNames,
} from "../src/claim-lines/claim-snapshot";
import type { Icd10Pointer, MdmResolution, PhysicianResolution } from "../src/rules/types";

const physician = (npi: string, firstName?: string, lastName?: string): PhysicianResolution => ({
  npi,
  ...(firstName !== undefined ? { firstName } : {}),
  ...(lastName !== undefined ? { lastName } : {}),
  status: "active",
  licenseUnexpiredOnServiceDates: true,
});
const mdm = (a: PhysicianResolution | null, h: PhysicianResolution | null): MdmResolution => ({
  attending: a,
  hospicePhysician: h,
  placeOfService: null,
});

describe("claimPhysicianNames", () => {
  it("keeps both physicians' names when their NPIs differ", () => {
    expect(
      claimPhysicianNames(
        mdm(physician("1234567893", "Ada", "Lovelace"), physician("1982736455", "Grace", "Hopper")),
      ),
    ).toEqual({
      attendingPhysicianFirstName: "Ada",
      attendingPhysicianLastName: "Lovelace",
      certifyingPhysicianFirstName: "Grace",
      certifyingPhysicianLastName: "Hopper",
    });
  });

  it("leaves the certifying name null when the certifying NPI equals the attending", () => {
    const r = claimPhysicianNames(
      mdm(physician("1234567893", "Ada", "Lovelace"), physician("1234567893", "Ada", "Lovelace")),
    );
    expect(r.attendingPhysicianLastName).toBe("Lovelace");
    expect(r.certifyingPhysicianFirstName).toBeNull();
    expect(r.certifyingPhysicianLastName).toBeNull();
  });

  it("stores no name for a physician whose NPI is malformed (no NPI on the claim)", () => {
    const r = claimPhysicianNames(mdm(physician("123", "Ada", "Lovelace"), null));
    expect(r.attendingPhysicianFirstName).toBeNull();
    expect(r.attendingPhysicianLastName).toBeNull();
  });

  it("never stores half a name, and trims whitespace", () => {
    const r = claimPhysicianNames(
      mdm(physician("1234567893", "  Ada ", "  "), physician("1982736455", " Grace", "Hopper ")),
    );
    expect(r.attendingPhysicianFirstName).toBeNull();
    expect(r.attendingPhysicianLastName).toBeNull();
    expect(r.certifyingPhysicianFirstName).toBe("Grace");
    expect(r.certifyingPhysicianLastName).toBe("Hopper");
  });

  it("is all-null when M40 supplied no names", () => {
    expect(
      Object.values(claimPhysicianNames(mdm(physician("1234567893"), null))).every(
        (v) => v === null,
      ),
    ).toBe(true);
  });
});

describe("claimDiagnosisSnapshot", () => {
  const seq: Icd10Pointer[] = [
    { position: 3, code: "I10", relationship: "unrelated" },
    { position: 1, code: "C3490", relationship: "terminal" },
    { position: 2, code: "J449", relationship: "related" },
  ];

  it("orders by position with the terminal diagnosis as principal (ABK) and the rest ABF", () => {
    expect(claimDiagnosisSnapshot(seq)).toEqual([
      { icd10Code: "C3490", sequence: 1, qualifier: "ABK" },
      { icd10Code: "J449", sequence: 2, qualifier: "ABF" },
      { icd10Code: "I10", sequence: 3, qualifier: "ABF" },
    ]);
  });

  it("marks only the first terminal diagnosis ABK", () => {
    const r = claimDiagnosisSnapshot([
      { position: 1, code: "C3490", relationship: "terminal" },
      { position: 2, code: "C787", relationship: "terminal" },
    ]);
    expect(r.map((d) => d.qualifier)).toEqual(["ABK", "ABF"]);
  });

  it("records no principal when there is no terminal diagnosis", () => {
    expect(
      claimDiagnosisSnapshot([{ position: 1, code: "I10", relationship: "related" }])[0]?.qualifier,
    ).toBe("ABF");
  });

  it("keeps the input order of entries that share a position (stable sort) and picks the first terminal as ABK", () => {
    const out = claimDiagnosisSnapshot([
      { position: 2, code: "J449", relationship: "related" },
      { position: 1, code: "C787", relationship: "terminal" },
      { position: 1, code: "C3490", relationship: "terminal" },
      { position: 2, code: "I10", relationship: "unrelated" },
    ]);
    expect(out.map((d) => d.icd10Code)).toEqual(["C787", "C3490", "J449", "I10"]);
    expect(out.map((d) => d.qualifier)).toEqual(["ABK", "ABF", "ABF", "ABF"]);
  });

  it("does not mutate its input and is empty for an empty sequence", () => {
    const copy = JSON.stringify(seq);
    claimDiagnosisSnapshot(seq);
    expect(JSON.stringify(seq)).toBe(copy);
    expect(claimDiagnosisSnapshot([])).toEqual([]);
  });
});

describe("buildClaimSnapshot", () => {
  it("combines the names and the diagnosis snapshot", () => {
    const s = buildClaimSnapshot(mdm(physician("1234567893", "Ada", "Lovelace"), null), [
      { position: 1, code: "C3490", relationship: "terminal" },
    ]);
    expect(s.attendingPhysicianLastName).toBe("Lovelace");
    expect(s.diagnosisSnapshot).toHaveLength(1);
  });

  it("moves the name with the NPI: a changed M40 resolution yields the new physician's name, certifying null with its NPI", () => {
    const before = buildClaimSnapshot(
      mdm(physician("1234567893", "Ada", "Lovelace"), physician("1982736455", "Grace", "Hopper")),
      [],
    );
    const after = buildClaimSnapshot(
      mdm(physician("1245319599", "Alan", "Turing"), physician("1245319599", "Alan", "Turing")),
      [],
    );
    expect(before.certifyingPhysicianLastName).toBe("Hopper");
    expect(after.attendingPhysicianLastName).toBe("Turing");
    expect(after.certifyingPhysicianFirstName).toBeNull();
    expect(after.certifyingPhysicianLastName).toBeNull();
  });
});
