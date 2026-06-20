// apps/backend/__tests__/mdm-seam.test.ts — M40-T05 published-seam registration (§4.5).
//
// Proves M40's boot-validated cross-module seam — `MdmEntityProvider`, the master-data read surface
// every clinical/billing/interop module consumes — registers over the M1 deny-stub and passes
// validateSeams(). Asserts the fail-closed baseline (unregistered ⇒ generic deny-stub throws on any
// call), that the real provider is MERGE-AWARE (§7.2: a FK to a merged row still resolves, carrying
// `resolvedFrom`) and joins this tenant's overlay (§2.3), and that the composition-root
// `wireModuleSeams` hook wires it during a real buildServer() boot.
import {
  type MdmEntityProvider,
  type SeedCanonical,
  createInMemoryMdmStore,
} from "@wardenx/mdm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import { REQUIRED_SEAMS, __resetSeamsForTest, validateSeams } from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import { getMdmEntityProvider, registerMdmSeams } from "../src/modules/40-mdm/index";

// A live survivor physician + a duplicate merged into it — the §7.2 redirect fixture.
const SURVIVOR = "11111111-1111-1111-1111-111111111111";
const DUPLICATE = "22222222-2222-2222-2222-222222222222";
const ORG = "org-engrace";

const physicianCanonicals: SeedCanonical[] = [
  {
    kind: "physician",
    redirect: { id: SURVIVOR, status: "active", mergedIntoId: null },
    fields: {
      id: SURVIVOR,
      identifierType: "npi",
      identifierValue: "1234567893",
      displayName: "Dr. Jane Roe",
      firstName: "Jane",
      lastName: "Roe",
      credentials: "MD",
      isNp: false,
      specialtyTaxonomy: null,
      licenseStates: ["OR"],
    },
  },
  {
    kind: "physician",
    redirect: { id: DUPLICATE, status: "merged", mergedIntoId: SURVIVOR },
    fields: {
      id: DUPLICATE,
      identifierType: "npi",
      identifierValue: null,
      displayName: "Dr. J. Roe (dup)",
      firstName: "J",
      lastName: "Roe",
      credentials: "MD",
      isNp: false,
      specialtyTaxonomy: null,
      licenseStates: null,
    },
  },
];

function seededStore() {
  return createInMemoryMdmStore({
    canonicals: physicianCanonicals,
    overlays: [
      {
        orgId: ORG,
        canonicalId: SURVIVOR,
        fields: {
          preferredContactPhone: "503-555-0100",
          preferredContactEmail: null,
          relationshipNotes: null,
          doNotRefer: false,
          isPreferred: true,
          preferredRank: 1,
        },
      },
    ],
  }).store;
}

describe("M40-T05 — MdmEntityProvider registers over the M1 deny-stub (§4.5)", () => {
  beforeEach(() => __resetSeamsForTest());

  it("declares the seam in REQUIRED_SEAMS owned by M40 with a deny-stub", () => {
    const entry = REQUIRED_SEAMS.find((r) => r.key === "MdmEntityProvider");
    expect(entry).toBeDefined();
    expect(entry?.ownerModule).toBe(40);
    expect(entry?.denyStub).toBeDefined();
    expect(entry?.phi).toBe(false); // canonical reference data + overlay, not a patient record
  });

  it("registers the real provider so validateSeams() passes and the typed getter resolves it", () => {
    registerMdmSeams();
    expect(() => validateSeams()).not.toThrow();
    const provider: MdmEntityProvider = getMdmEntityProvider();
    expect(provider).toBeDefined();
  });

  it("resolves a live physician with this tenant's overlay joined (§2.3, not the deny-stub)", async () => {
    registerMdmSeams({ store: seededStore() });
    validateSeams();
    const provider = getMdmEntityProvider();
    const resolved = await provider.resolvePhysician(ORG, SURVIVOR);
    expect(resolved?.id).toBe(SURVIVOR);
    expect(resolved?.resolvedFrom).toBeUndefined(); // direct hit — no redirect followed
    expect(resolved?.canonical.lastName).toBe("Roe");
    expect(resolved?.overlay?.isPreferred).toBe(true);
    expect(resolved?.status).toBe("active");
  });

  it("§7.2 a FK to a merged row resolves to the survivor, carrying resolvedFrom", async () => {
    registerMdmSeams({ store: seededStore() });
    validateSeams();
    const provider = getMdmEntityProvider();
    const resolved = await provider.resolvePhysician(ORG, DUPLICATE);
    expect(resolved?.id).toBe(SURVIVOR); // redirect chased through transparently
    expect(resolved?.resolvedFrom).toBe(DUPLICATE); // breadcrumb so the caller may patch its FK
    expect(resolved?.overlay?.isPreferred).toBe(true); // overlay joined on the SURVIVOR
  });

  it("getOrCreate returns matched_canonical when the identifier already exists (§7.1)", async () => {
    registerMdmSeams({ store: seededStore() });
    validateSeams();
    const provider = getMdmEntityProvider();
    const out = await provider.getOrCreate(
      ORG,
      "physician",
      { identifierType: "npi", identifierValue: "1234567893" },
      "user-1",
    );
    expect(out.kind).toBe("matched_canonical");
    if (out.kind === "matched_canonical") expect(out.entity.id).toBe(SURVIVOR);
  });

  it("without registration the seam boots FAIL-CLOSED (generic deny-stub throws on any call)", () => {
    validateSeams(); // no module registered anything → deny-stub default applied
    const provider = getMdmEntityProvider();
    expect(() => provider.resolvePhysician(ORG, SURVIVOR)).toThrow(NotImplementedError);
    expect(() => provider.resolvePayer(ORG, SURVIVOR)).toThrow(NotImplementedError);
  });

  it("the composition-root wireModuleSeams hook registers M40's seam during buildServer() boot", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams });
    const provider = getMdmEntityProvider();
    // Boot completed (validateSeams() did not throw) AND the seam is the real impl: an unseeded id
    // resolves to null rather than throwing the deny-stub.
    expect(await provider.resolvePhysician(ORG, SURVIVOR)).toBeNull();
    await app.close();
  });
});
