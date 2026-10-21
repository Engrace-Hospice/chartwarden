// apps/backend/__tests__/terminology-seam.test.ts — M38-T05 published-seam registration (§4.5).
//
// Proves M38's one boot-validated cross-module seam — `TerminologyProvider`, the read surface
// every clinical/billing module consumes — registers over the M1 deny-stub and passes
// validateSeams(). Also asserts the fail-closed baseline (unregistered ⇒ generic deny-stub
// throws on any call) and that the composition-root `wireModuleSeams` hook wires it during a
// real buildServer() boot.
import { type TerminologyProvider, createInMemoryTerminologyStore } from "@chartwarden/terminology";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import {
  getTerminologyProvider,
  registerTerminologySeams,
} from "../src/modules/38-terminology/index";

describe("M38-T05 — TerminologyProvider registers over the M1 deny-stub (§4.5)", () => {
  beforeEach(() => __resetSeamsForTest());

  it("declares the seam in REQUIRED_SEAMS owned by M38 with a deny-stub", () => {
    const entry = REQUIRED_SEAMS.find((r) => r.key === "TerminologyProvider");
    expect(entry).toBeDefined();
    expect(entry?.ownerModule).toBe(38);
    expect(entry?.denyStub).toBeDefined();
  });

  it("registers the real provider so validateSeams() passes and the typed getter resolves it", () => {
    registerTerminologySeams();
    expect(() => validateSeams()).not.toThrow();
    const provider: TerminologyProvider = getTerminologyProvider();
    expect(provider).toBeDefined();
  });

  it("the real provider answers a lookup (not the deny-stub)", async () => {
    registerTerminologySeams({
      store: createInMemoryTerminologyStore({
        concepts: [
          {
            systemId: "icd10cm",
            code: "G93.41",
            display: "Metabolic encephalopathy",
            status: "active",
            effectiveDate: "2022-10-01",
            endDate: null,
            properties: { isBillableLeaf: true, chapter: "G", parentCode: "G93.4" },
          },
        ],
      }).store,
    });
    validateSeams();
    const provider = getTerminologyProvider();
    const hit = await provider.lookup("icd10cm", "G93.41", new Date("2023-01-01"));
    expect(hit?.display).toBe("Metabolic encephalopathy");
  });

  it("without registration the seam boots FAIL-CLOSED (generic deny-stub throws on any call)", () => {
    validateSeams(); // no module registered anything → deny-stub default applied
    const provider = getTerminologyProvider();
    // The generic deny-stub proxy throws synchronously on the first method call.
    expect(() => provider.validate("icd10cm", "E11.9")).toThrow(NotImplementedError);
    expect(() => provider.lookup("loinc", "1234-5")).toThrow(NotImplementedError);
  });

  it("the composition-root wireModuleSeams hook registers M38's seam during buildServer() boot", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams });
    const provider = getTerminologyProvider();
    // Boot completed (validateSeams() did not throw) AND the seam is the real impl: a lookup
    // for an unseeded code resolves to null rather than throwing the deny-stub.
    expect(await provider.lookup("icd10cm", "unknown")).toBeNull();
    await app.close();
  });
});
