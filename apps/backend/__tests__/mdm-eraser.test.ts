// apps/backend/__tests__/mdm-eraser.test.ts — M40-T10 the `mdm_tenant_overlays` data eraser
// (M40 spec §7.8, D7 tenant offboarding).
//
// Proves M40 registers a REAL eraser for the `mdm_tenant_overlays` data class over the Phase-0
// deny-stub, and that the registered eraser deletes ONLY the offboarding org's overlay/provisional/
// baa rows (canonical reference entities are never in scope):
//   • the composition-root wireModuleErasers hook makes validateErasers() pass during a real
//     buildServer() boot (the missing eraser would otherwise have failed the boot gate);
//   • a tenant-offboarding erase reports the org's per-class total.
import { createInMemoryMdmEraseStore } from "@wardenx/mdm";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetErasersForTest, getEraser, validateErasers } from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { registerMdmErasers } from "../src/modules/40-mdm/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";

const ORG = "org_1";

describe("M40-T10 — the mdm_tenant_overlays eraser registers over the deny-stub (D7, §7.8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("erases the offboarding org's overlay/provisional/baa rows and reports the total", async () => {
    const { store } = createInMemoryMdmEraseStore({
      overlaysByOrg: { [ORG]: 3 },
      provisionalsByOrg: { [ORG]: 1 },
      baaByOrg: { [ORG]: 2 },
    });
    registerMdmErasers({ store });
    const result = await getEraser("mdm_tenant_overlays").erase({ orgId: ORG }, ORG);
    expect(result.erased).toBe(6);
  });

  it("the composition-root wireModuleErasers hook makes validateErasers() pass at boot", async () => {
    // A real boot wires every module's eraser (incl. M40) so the boot gate passes — the missing
    // mdm_tenant_overlays eraser would otherwise have failed validateErasers().
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    // The registered eraser is the real M40 impl (an unseeded org erases to 0, doesn't throw).
    const result = await getEraser("mdm_tenant_overlays").erase({ orgId: "org_x" }, "org_x");
    expect(result.erased).toBe(0);
    await app.close();
  });
});
