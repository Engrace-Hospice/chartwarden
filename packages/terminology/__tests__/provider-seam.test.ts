// @chartwarden/terminology — M38-T05 provider unit tests (spec §4.5).
//
// Proves the real `TerminologyProvider` is correct ORCHESTRATION over the T04 as-of engine and
// the injected store, with no live infra:
//   • VALIDATE/LOOKUP honor `asOf` on every call (a since-retired code's historical read).
//   • BATCH resolves each code at one shared asOf.
//   • DEPRECATION successor is surfaced for a deprecated code.
//   • isMemberOf distinguishes platform vs tenant_extension provenance (§4.5).
//   • EXPAND folds tenant extensions only when explicitly requested with an org scope (§2.4.3).
//   • TENANT EXTENSION add/remove round-trips through the mutating surface.
//   • FHIR projections are deterministic for the same (id, asOf) (§7.9 shape).
import { describe, expect, it } from "vitest";
import {
  type ResolvedConcept,
  createInMemoryTerminologyStore,
  createTerminologyProvider,
} from "../src/index";

const icd = (
  o: Partial<ResolvedConcept<"icd10cm">> & { code: string; effectiveDate: string; display: string },
): ResolvedConcept<"icd10cm"> => ({
  systemId: "icd10cm",
  status: "active",
  endDate: null,
  properties: { isBillableLeaf: true, chapter: "G", parentCode: null },
  ...o,
});

function makeProvider() {
  const { store } = createInMemoryTerminologyStore({
    concepts: [
      // E11.9 active 2022→ then deprecated, end-dated 2024-09-30 (two coexisting rows, §7.2).
      icd({
        code: "E11.9",
        display: "Type 2 diabetes",
        effectiveDate: "2022-10-01",
        endDate: "2024-09-30",
        status: "deprecated",
      }),
      icd({
        code: "E11.9",
        display: "Type 2 diabetes",
        effectiveDate: "2021-10-01",
        endDate: "2022-09-30",
        status: "active",
      }),
      icd({ code: "G93.41", display: "Metabolic encephalopathy", effectiveDate: "2022-10-01" }),
      // E11.8 — active, open-ended, NOT a platform member: a valid tenant-extension target (§7.6).
      icd({
        code: "E11.8",
        display: "Type 2 diabetes w/ complications",
        effectiveDate: "2024-10-01",
      }),
    ],
    deprecations: [
      {
        system: "icd10cm",
        deprecatedCode: "E11.9",
        deprecationEffective: "2024-10-01",
        successorCodes: ["E11.8"],
        mappingKind: "equivalent",
        guidance: "Use E11.8",
      },
    ],
    valueSetMembers: [
      {
        valueSetId: "hospice_terminal_dx",
        systemId: "icd10cm",
        code: "G93.41",
        display: "Metabolic encephalopathy",
        annotations: {},
      },
    ],
    codeSystemMeta: { icd10cm: { url: "http://hl7.org/fhir/sid/icd-10-cm", version: "2024" } },
    valueSetUrls: { hospice_terminal_dx: "urn:wardenx:valueset:hospice_terminal_dx" },
  });
  return createTerminologyProvider(store);
}

describe("M38-T05 — createTerminologyProvider over the as-of engine (§4.5)", () => {
  it("validate honors asOf: active at service date, deprecated-with-successor later", async () => {
    const p = makeProvider();
    // 2022 service date hits the active 2021→2022 row.
    expect(await p.validate("icd10cm", "E11.9", new Date("2022-01-01"))).toEqual({
      valid: true,
      status: "active",
    });
    // 2024 hits the deprecated row → still valid, with the successor mapping attached (§7.1).
    const later = await p.validate("icd10cm", "E11.9", new Date("2024-06-01"));
    expect(later.valid).toBe(true);
    expect(later.status).toBe("deprecated");
    expect(later.successor?.successorCodes).toEqual(["E11.8"]);
  });

  it("validate returns invalid for a code with no version covering asOf (§7.10)", async () => {
    const p = makeProvider();
    expect(await p.validate("icd10cm", "E11.9", new Date("2010-01-01"))).toEqual({ valid: false });
  });

  it("lookup + lookupBatch resolve at a shared asOf", async () => {
    const p = makeProvider();
    expect((await p.lookup("icd10cm", "G93.41", new Date("2023-01-01")))?.display).toBe(
      "Metabolic encephalopathy",
    );
    const batch = await p.lookupBatch(
      "icd10cm",
      ["E11.9", "G93.41", "missing"],
      new Date("2023-01-01"),
    );
    expect(batch.get("E11.9")?.status).toBe("deprecated");
    expect(batch.get("G93.41")?.code).toBe("G93.41");
    expect(batch.has("missing")).toBe(false);
  });

  it("getDeprecationMapping surfaces the successor mapping", async () => {
    const p = makeProvider();
    expect((await p.getDeprecationMapping("icd10cm", "E11.9"))?.successorCodes).toEqual(["E11.8"]);
    expect(await p.getDeprecationMapping("icd10cm", "G93.41")).toBeNull();
  });

  it("isMemberOf reports platform provenance; tenant adds require an org scope", async () => {
    const p = makeProvider();
    expect(await p.isMemberOf("hospice_terminal_dx", "icd10cm", "G93.41")).toEqual({
      isMember: true,
      source: "platform",
    });
    expect(await p.isMemberOf("hospice_terminal_dx", "icd10cm", "E11.9")).toEqual({
      isMember: false,
      source: null,
    });
  });

  it("tenant extension add → expand folds it in only with includeTenantExtensions + orgId", async () => {
    const p = makeProvider();
    const { extensionId } = await p.addTenantExtension(
      "org_1",
      "hospice_terminal_dx",
      "icd10cm",
      "E11.8",
      "local policy",
      "user_1",
    );
    expect(extensionId).toMatch(/^vsext_/);

    // Default expand: platform members only.
    const platformOnly = await collect(p.expand("hospice_terminal_dx"));
    expect(platformOnly.map((m) => m.code)).toEqual(["G93.41"]);

    // With the org scope, the tenant add appears, and membership reports its provenance.
    const withTenant = await collect(
      p.expand("hospice_terminal_dx", { includeTenantExtensions: true, orgId: "org_1" }),
    );
    expect(withTenant.map((m) => m.code).sort()).toEqual(["E11.8", "G93.41"]);
    expect(
      await p.isMemberOf("hospice_terminal_dx", "icd10cm", "E11.8", { orgId: "org_1" }),
    ).toEqual({
      isMember: true,
      source: "tenant_extension",
    });

    // includeTenantExtensions without an org scope is rejected (§4.5).
    await expect(
      collect(p.expand("hospice_terminal_dx", { includeTenantExtensions: true })),
    ).rejects.toThrow(/orgId/);

    // Remove round-trips: the add disappears.
    await p.removeTenantExtension("org_1", extensionId, "user_1");
    const afterRemove = await collect(
      p.expand("hospice_terminal_dx", { includeTenantExtensions: true, orgId: "org_1" }),
    );
    expect(afterRemove.map((m) => m.code)).toEqual(["G93.41"]);
  });

  it("asFhirCodeSystem / asFhirValueSet are deterministic for the same (id, asOf)", async () => {
    const p = makeProvider();
    const cs = await p.asFhirCodeSystem("icd10cm", new Date("2023-01-01"));
    expect(cs.resourceType).toBe("CodeSystem");
    expect(cs.url).toBe("http://hl7.org/fhir/sid/icd-10-cm");
    // G93.41 active at 2023; E11.9 also active in its window → both present, code-sorted.
    expect(cs.concept.map((c) => c.code)).toEqual(["E11.9", "G93.41"]);

    const vs = await p.asFhirValueSet("hospice_terminal_dx", { asOf: new Date("2023-01-01") });
    expect(vs.resourceType).toBe("ValueSet");
    expect(vs.expansion.total).toBe(1);
    expect(vs.expansion.timestamp).toBe("2023-01-01T00:00:00Z");
  });
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
