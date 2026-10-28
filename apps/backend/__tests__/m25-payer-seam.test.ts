// M25 payer seam against the REAL M40 provider (in-memory store seeded with the platform payer seed). The 12a-1 live suites
// inject their own PayerSeam, so they never read M40's actual canonical shape (displayName, kind); this test does.
import {
  createInMemoryMdmStore,
  createMdmEntityProvider,
  toPayerCanonicalSeed,
} from "@chartwarden/mdm";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { buildSeamPayerSeam } from "../src/modules/25-remittance/routes/payer-seam";

const ORG = "11111111-1111-4111-8111-111111111111";

const seeded = toPayerCanonicalSeed();
const provider = createMdmEntityProvider(
  createInMemoryMdmStore({
    canonicals: seeded.map((fields) => ({
      kind: "payer" as const,
      redirect: { id: fields.id, status: "active" as const, mergedIntoId: null },
      fields,
    })),
  }).store,
);

describe("buildSeamPayerSeam over the real M40 provider", () => {
  afterEach(() => __resetSeamsForTest());

  it("resolves a seeded payer to its name and program kind", async () => {
    registerSeam("MdmEntityProvider", provider as never);
    const medicare = seeded.find((p) => p.kind === "medicare");
    expect(medicare).toBeDefined();
    const resolved = await buildSeamPayerSeam().resolve(ORG, medicare!.id);
    expect(resolved).toEqual({ id: medicare!.id, name: medicare!.displayName, kind: "medicare" });
  });

  it("returns every seeded Medicaid payer as kind medicaid, so the payer guard can refuse it", async () => {
    registerSeam("MdmEntityProvider", provider as never);
    const medicaid = seeded.filter((p) => p.kind === "medicaid");
    expect(medicaid.length).toBeGreaterThan(0);
    for (const p of medicaid) {
      expect((await buildSeamPayerSeam().resolve(ORG, p.id))?.kind).toBe("medicaid");
    }
  });

  it("returns null for an unknown payer id", async () => {
    registerSeam("MdmEntityProvider", provider as never);
    expect(await buildSeamPayerSeam().resolve(ORG, "payer_does_not_exist")).toBeNull();
  });

  it("fails closed when the provider gives no program kind (never defaults to a passing kind)", async () => {
    registerSeam("MdmEntityProvider", {
      resolvePayer: async () => ({ id: "p1", canonical: { displayName: "No Kind Payer" } }),
    } as never);
    expect(await buildSeamPayerSeam().resolve(ORG, "p1")).toBeNull();
  });

  it("fails closed when the provider gives no name, or the seam is unbound", async () => {
    registerSeam("MdmEntityProvider", {
      resolvePayer: async () => ({ id: "p1", canonical: { displayName: " ", kind: "commercial" } }),
    } as never);
    expect(await buildSeamPayerSeam().resolve(ORG, "p1")).toBeNull();
    __resetSeamsForTest();
    expect(await buildSeamPayerSeam().resolve(ORG, "p1")).toBeNull();
  });
});
