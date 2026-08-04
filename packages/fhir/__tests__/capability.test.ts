// Module 28 — §D11 / W-FHIR-09 CapabilityStatement generation + signing (M28-T03).
//
// W-FHIR-09's promise is that a tenant can prove what the gateway advertised at any past disclosure: the
// statement must be DETERMINISTIC (same catalog ⇒ byte-identical JSON, regardless of enumeration order)
// and its HMAC signature must re-verify — and must FAIL to verify on tampering or a wrong key. These
// tests lock both: order-independence of the generated JSON, and the sign/verify round-trip + its refusals.

import { describe, expect, it } from "vitest";

import {
  type FhirCapabilityCatalog,
  buildCapabilityStatement,
  canonicalizeCapability,
  capabilityChecksum,
  signCapabilitySnapshot,
  verifyCapabilitySnapshot,
} from "../src/capability/statement";

const SIGNING_KEY = "platform-signing-key-under-test";

const catalog: FhirCapabilityCatalog = {
  fhirVersion: "4.0.1",
  releaseTag: "2026.08.0",
  publicationDate: "2026-08-01",
  baseUrl: "https://fhir.wardenx.com/fhir/r4",
  resources: [
    {
      type: "Patient",
      interactions: ["read", "search-type"],
      searchParams: ["_lastUpdated", "identifier"],
    },
    {
      type: "Observation",
      interactions: ["search-type", "read"],
      searchParams: ["patient", "code"],
    },
  ],
  operations: [
    { name: "export", definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export" },
    {
      name: "everything",
      definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything",
    },
  ],
};

describe("§D11 deterministic CapabilityStatement", () => {
  it("generates a stable, order-independent statement (resources/interactions/ops sorted)", () => {
    const a = buildCapabilityStatement(catalog);
    // Same catalog, resources + operations enumerated in a different order.
    const b = buildCapabilityStatement({
      ...catalog,
      resources: [...catalog.resources].reverse(),
      operations: [...catalog.operations].reverse(),
    });
    expect(canonicalizeCapability(a)).toBe(canonicalizeCapability(b));

    // Resources land sorted by type; the reordered interactions come out canonical.
    expect(a.rest[0].resource.map((r) => r.type)).toEqual(["Observation", "Patient"]);
    expect(a.rest[0].resource[1].interaction.map((i) => i.code)).toEqual(["read", "search-type"]);
  });

  it("embeds no wall clock — date is the injected publication date", () => {
    const statement = buildCapabilityStatement(catalog);
    expect(statement.date).toBe("2026-08-01");
    expect(statement.fhirVersion).toBe("4.0.1");
  });
});

describe("§W-FHIR-09 signature is verifiable + tamper-evident", () => {
  it("round-trips: a snapshot signed with the platform key re-verifies", () => {
    const statement = buildCapabilityStatement(catalog);
    const signature = signCapabilitySnapshot(statement, SIGNING_KEY);
    expect(verifyCapabilitySnapshot(statement, signature, SIGNING_KEY)).toBe(true);
  });

  it("the checksum is a stable sha256 hex of the canonical JSON", () => {
    const statement = buildCapabilityStatement(catalog);
    const checksum = capabilityChecksum(statement);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(capabilityChecksum(statement)).toBe(checksum);
  });

  it("refuses a tampered statement, a wrong key, and a malformed signature", () => {
    const statement = buildCapabilityStatement(catalog);
    const signature = signCapabilitySnapshot(statement, SIGNING_KEY);

    const tampered = { ...statement, status: "retired" as unknown as "active" };
    expect(verifyCapabilitySnapshot(tampered, signature, SIGNING_KEY)).toBe(false);
    expect(verifyCapabilitySnapshot(statement, signature, "wrong-key")).toBe(false);
    expect(verifyCapabilitySnapshot(statement, "deadbeef", SIGNING_KEY)).toBe(false);
  });
});
