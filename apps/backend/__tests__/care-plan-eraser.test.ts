// apps/backend/__tests__/care-plan-eraser.test.ts — M7-T09 the `care_plan_record` eraser (§3.6, D7/D8)
// + the m7 audit-catalog actions (§8.1). Proves M7 registers the REAL care_plan_record eraser over the
// Phase-0 deny-stub (validateErasers passes at boot), the eraser deletes the care-plan subtree +
// tombstones the care_plan root, and the m7 action catalog is well-formed (namespace + uniqueness).
import { ACTION_CATALOG, M7_ACTION_CATALOG, validateActionCatalog } from "@chartwarden/audit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import {
  eraseCarePlanRecord,
  createInMemoryCarePlanEraseStore as makeEraseStore,
  registerCarePlanErasers,
} from "../src/modules/07-care-plan/index";

describe("M7-T09 — care_plan_record eraser (§3.6, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("erases the care-plan subtree, tombstones the care_plan root, reports the total", async () => {
    const { store, tombstoned } = makeEraseStore({
      versions: 2,
      signatures: 3,
      problems: 4,
      goals: 5,
      interventions: 6,
    });
    const { erased, counts } = await eraseCarePlanRecord("org_a", "pat_1", store);
    expect(erased).toBe(20);
    expect(counts.goals).toBe(5);
    expect(tombstoned).toEqual(["pat_1"]);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ versions: 2, problems: 1 });
    expect((await eraseCarePlanRecord("org_a", "pat_1", store)).erased).toBe(3);
    expect((await eraseCarePlanRecord("org_a", "pat_1", store)).erased).toBe(0);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass for the data class", async () => {
    registerCarePlanErasers({ store: makeEraseStore({ versions: 1 }).store });
    const r = await getEraser("care_plan_record").erase({ orgId: "org_a" }, "pat_1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    // bootSeams() wires the Phase-0 deny-stubs AND the module erasers before validateErasers() — so
    // care_plan_record (and every required class) resolves at boot. The default in-memory store erases
    // nothing for an unseeded patient, but the real impl must not throw.
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("care_plan_record").erase({ orgId: "org_a" }, "pat_unseeded");
    expect(r.erased).toBe(0);
    await app.close();
  });
});

describe("M7-T09 — m7 audit action catalog (§8.1)", () => {
  it("every m7 action is namespaced m7.* and owned by m7", () => {
    for (const e of M7_ACTION_CATALOG) {
      expect(e.action.startsWith("m7.")).toBe(true);
      expect(e.moduleOwner).toBe("m7");
    }
  });

  it("the gate-override + reason carriers scrub narrative free text", () => {
    const byAction = new Map(M7_ACTION_CATALOG.map((e) => [e.action, e]));
    expect(byAction.get("m7.care_plan.gate_overridden")?.denylistCategories).toContain(
      "narrative_free_text",
    );
    expect(byAction.get("m7.care_plan.discharged")?.denylistCategories).toContain(
      "narrative_free_text",
    );
    expect(byAction.get("m7.care_plan.version_returned_to_draft")?.denylistCategories).toContain(
      "narrative_free_text",
    );
  });

  it("the consolidated catalog stays valid with m7 merged in (no namespace/dup violation)", () => {
    expect(ACTION_CATALOG.some((e) => e.action === "m7.care_plan.created")).toBe(true);
    expect(validateActionCatalog()).toEqual([]);
  });
});
