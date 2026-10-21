import { createInMemoryTerminologyStore } from "@chartwarden/terminology";
// apps/backend/__tests__/terminology-eraser.test.ts — M38-T10 the `terminology_tenant_extensions`
// data eraser (spec §11 D8).
//
// Proves M38 registers a REAL eraser for the `terminology_tenant_extensions` data class over the
// Phase-0 deny-stub, and that the registered eraser deletes ONLY the offboarding org's value-set
// extensions:
//   • the composition-root wireModuleErasers hook makes validateErasers() pass during a real
//     buildServer() boot (the deny-stub would otherwise have stood);
//   • a tenant-offboarding erase removes the org's extensions and reports the count; another org's
//     extensions are untouched (no cross-tenant deletion through the eraser).
import { beforeEach, describe, expect, it } from "vitest";
import { wireErasers } from "../src/bootstrap/erasers/providers";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import { registerTerminologyErasers } from "../src/modules/38-terminology/index";

const ORG = "org_1";
const OTHER_ORG = "org_2";

describe("M38-T10 — the terminology_tenant_extensions eraser registers over the deny-stub (D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("erases the offboarding org's value-set extensions and reports the count", async () => {
    const { store } = createInMemoryTerminologyStore();
    // Two extensions for ORG, one for another org — only ORG's must be erased.
    await store.insertTenantExtension({
      orgId: ORG,
      valueSetId: "hospice_terminal_diagnosis",
      system: "icd10cm",
      code: "G30.9",
      reason: "tenant-specific terminal dx mapping",
      actorUserId: "u_1",
    });
    await store.insertTenantExtension({
      orgId: ORG,
      valueSetId: "level_of_care",
      system: "hcpcs",
      code: "Q5001",
      reason: "tenant LOC extension",
      actorUserId: "u_1",
    });
    await store.insertTenantExtension({
      orgId: OTHER_ORG,
      valueSetId: "level_of_care",
      system: "hcpcs",
      code: "Q5002",
      reason: "other org extension",
      actorUserId: "u_2",
    });

    registerTerminologyErasers({ store });
    const result = await getEraser("terminology_tenant_extensions").erase({ orgId: ORG }, ORG);

    expect(result).toEqual({ erased: 2 });
    // The other org's extension survives (no cross-tenant deletion).
    expect(await store.tenantExtensionMembers(OTHER_ORG, "level_of_care")).toHaveLength(1);
    expect(await store.tenantExtensionMembers(ORG, "level_of_care")).toHaveLength(0);
  });

  it("reports zero when the org never extended a value set (no-op, not an error)", async () => {
    const { store } = createInMemoryTerminologyStore();
    registerTerminologyErasers({ store });
    expect(await getEraser("terminology_tenant_extensions").erase({ orgId: ORG }, ORG)).toEqual({
      erased: 0,
    });
  });

  it("makes validateErasers() pass during a real buildServer() boot (no deny-stub left standing)", () => {
    wireErasers(); // deny-stub every required class first…
    // …then the registered terminology eraser must stand over its stub (no NotImplemented throw).
    expect(() =>
      buildServer({
        registerModuleSeams: wireModuleSeams,
        registerModuleErasers: wireModuleErasers,
      }),
    ).not.toThrow();
    expect(() => validateErasers()).not.toThrow();
  });
});
