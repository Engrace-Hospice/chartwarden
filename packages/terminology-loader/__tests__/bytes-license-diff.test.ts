// M38 loader — checksum/zip helpers, the licensing gate and the ICD-10-CM deprecation diff (GAP-108).
import { describe, expect, it } from "vitest";
import { MAX_ENTRY_BYTES, bundleFromBytes, iterLines, sha256Hex } from "../src/bytes";
import { buildDeprecationHints } from "../src/diff";
import {
  type LicenseAttestation,
  attributionFor,
  evaluateLicenseGate,
  requiresAttestation,
  validateAttestationInput,
} from "../src/license";
import { parseSource } from "../src/parsers/index";
import { ICD10CM_ORDER_2026, ICD10CM_ORDER_2027, bytes, zip } from "./_fixtures";

describe("bytes", () => {
  it("sha256 matches the known vector", () => {
    expect(sha256Hex(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("reads deflated and stored zip members lazily, and a raw upload as one entry", () => {
    const z = zip({ "a.txt": "alpha", "dir/b.txt": "beta" }, ["a.txt"]);
    const bundle = bundleFromBytes(z);
    expect(bundle.names).toEqual(["a.txt", "dir/b.txt"]);
    expect(new TextDecoder().decode(bundle.read("a.txt"))).toBe("alpha");
    expect(new TextDecoder().decode(bundle.read("dir/b.txt"))).toBe("beta");
    expect(() => bundle.read("nope")).toThrow(/no member/);
    expect(bundleFromBytes(bytes("raw")).names).toEqual(["upload"]);
  });

  it("rejects a corrupt archive instead of misreading it", () => {
    const z = zip({ "a.txt": "alpha" });
    const broken = z.slice(0, z.length - 8); // chop the end-of-central-directory record
    expect(() => bundleFromBytes(broken)).toThrow(/ZIP_INVALID/);
    expect(MAX_ENTRY_BYTES).toBeGreaterThan(1_000_000);
  });

  it("splits lines on LF and CRLF without a trailing empty line", () => {
    expect([...iterLines(bytes("a\r\nb\nc"))]).toEqual(["a", "b", "c"]);
  });
});

const attest = (over: Partial<LicenseAttestation> = {}): LicenseAttestation => ({
  id: "att-1",
  system: "snomed",
  licensee: "WardenX Platform Inc.",
  licenseReference: "SNOMED-AFFILIATE-1234",
  attestedBy: "op-1",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2027-01-01",
  attributionText: "SNOMED CT is used under licence from SNOMED International.",
  revokedAt: null,
  ...over,
});

describe("licence gate", () => {
  it("passes tier-1 public systems with no attestation", () => {
    expect(evaluateLicenseGate("icd10cm", "public", [], "2026-10-06")).toEqual({
      allowed: true,
      attestation: null,
    });
    expect(requiresAttestation("hcpcs", "public")).toBe(false);
  });

  it.each(["snomed", "loinc", "rxnorm"] as const)(
    "refuses %s without an attestation, even if the catalog says public",
    (system) => {
      expect(evaluateLicenseGate(system, "public", [], "2026-10-06")).toEqual({
        allowed: false,
        reason: "ATTESTATION_REQUIRED",
      });
    },
  );

  it("allows a non-public system with an active attestation and exposes its attribution", () => {
    const a = attest();
    const v = evaluateLicenseGate("snomed", "umls", [a], "2026-10-06");
    expect(v).toEqual({ allowed: true, attestation: a });
    expect(attributionFor([a], "snomed", "2026-10-06")).toBe(a.attributionText);
    expect(attributionFor([a], "loinc", "2026-10-06")).toBeNull();
  });

  it("distinguishes expired, not-yet-effective and revoked attestations", () => {
    expect(
      evaluateLicenseGate("snomed", "umls", [attest({ effectiveTo: "2026-06-30" })], "2026-10-06"),
    ).toMatchObject({ reason: "ATTESTATION_EXPIRED" });
    expect(
      evaluateLicenseGate(
        "snomed",
        "umls",
        [attest({ effectiveFrom: "2027-01-01", effectiveTo: null })],
        "2026-10-06",
      ),
    ).toMatchObject({ reason: "ATTESTATION_NOT_YET_EFFECTIVE" });
    expect(
      evaluateLicenseGate(
        "snomed",
        "umls",
        [attest({ revokedAt: "2026-05-01T00:00:00Z" })],
        "2026-10-06",
      ),
    ).toMatchObject({ reason: "ATTESTATION_REVOKED" });
    expect(
      attributionFor([attest({ revokedAt: "2026-05-01T00:00:00Z" })], "snomed", "2026-10-06"),
    ).toBeNull();
  });

  it("never attests a system for another system's attestation", () => {
    expect(evaluateLicenseGate("loinc", "regenstrief", [attest()], "2026-10-06")).toMatchObject({
      allowed: false,
    });
  });

  it("treats an older loader's free-text catalog label as PUBLIC, not as a licence to attest", () => {
    expect(requiresAttestation("icd10cm", "CDC/NCHS (public domain)")).toBe(false);
    expect(evaluateLicenseGate("icd10cm", "CDC/NCHS (public domain)", [], "2026-10-06")).toEqual({
      allowed: true,
      attestation: null,
    });
    expect(requiresAttestation("hcpcs", "umls")).toBe(true);
  });

  it("refuses an AMA (CPT) source outright", () => {
    expect(evaluateLicenseGate("hcpcs", "ama", [], "2026-10-06")).toEqual({
      allowed: false,
      reason: "LICENSE_UNSUPPORTED",
    });
  });

  it("validates attestation input", () => {
    const base = {
      system: "snomed" as const,
      licensee: "x",
      licenseReference: "y",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      attributionText: "z",
    };
    expect(validateAttestationInput(base)).toEqual([]);
    expect(
      validateAttestationInput({
        ...base,
        licensee: " ",
        attributionText: "",
        effectiveTo: "2025-12-31",
      }),
    ).toHaveLength(3);
  });
});

describe("icd10cm deprecation hints", () => {
  it("maps a code that became a header to its new billable subcodes (narrower) and a deleted code to none", () => {
    const prior = parseSource("icd10cm", bytes(ICD10CM_ORDER_2026)).concepts.map((c) => ({
      code: c.code,
      display: c.display,
      isBillableLeaf: c.properties.isBillableLeaf === true,
    }));
    const next = parseSource("icd10cm", bytes(ICD10CM_ORDER_2027)).concepts;
    const hints = buildDeprecationHints("icd10cm", prior, next);
    expect(hints.map((h) => h.code).sort()).toEqual(["I42.0", "Z51.5"]);
    expect(hints.find((h) => h.code === "I42.0")).toMatchObject({
      mappingKind: "narrower",
      successors: ["I42.00", "I42.01"],
    });
    expect(hints.find((h) => h.code === "Z51.5")).toMatchObject({
      mappingKind: "none",
      successors: [],
    });
  });

  it("yields no hints for systems without successor knowledge", () => {
    expect(
      buildDeprecationHints("hcpcs", [{ code: "A1", display: "x", isBillableLeaf: false }], []),
    ).toEqual([]);
  });
});
