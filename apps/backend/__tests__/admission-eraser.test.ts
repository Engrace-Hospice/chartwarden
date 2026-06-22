// apps/backend/__tests__/admission-eraser.test.ts — M6-T12 the `admission_record` eraser (§3.6, D7/D8)
// + the m6 audit-catalog actions (§8.1.2). Proves M6 registers the REAL admission_record eraser over
// the Phase-0 deny-stub (validateErasers passes at boot), the eraser deletes the admission subtree +
// tombstones the admission row, and the m6 action catalog is well-formed (namespace + uniqueness).
import { ACTION_CATALOG, M6_ACTION_CATALOG, validateActionCatalog } from "@wardenx/audit";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetErasersForTest, getEraser, validateErasers } from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import {
  createInMemoryAdmissionEraseStore as makeEraseStore,
  eraseAdmissionRecord,
  registerAdmissionErasers,
} from "../src/modules/06-admission/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";

describe("M6-T12 — admission_record eraser (§3.6, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("erases the admission subtree, tombstones the admission, reports the total", async () => {
    const { store, tombstoned } = makeEraseStore({
      referrals: 1, electionPeriods: 2, certifications: 2, faceToFaceEncounters: 1, complianceWindows: 3,
    });
    const { erased, counts } = await eraseAdmissionRecord("org_a", "pat_1", store);
    expect(erased).toBe(9);
    expect(counts.electionPeriods).toBe(2);
    expect(tombstoned).toEqual(["pat_1"]);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ electionPeriods: 2 });
    expect((await eraseAdmissionRecord("org_a", "pat_1", store)).erased).toBe(2);
    expect((await eraseAdmissionRecord("org_a", "pat_1", store)).erased).toBe(0);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass", async () => {
    registerAdmissionErasers({ store: makeEraseStore({ dischargeEvents: 1 }).store });
    const r = await getEraser("admission_record").erase({ orgId: "org_a" }, "pat_1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams, registerModuleErasers: wireModuleErasers });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("admission_record").erase({ orgId: "org_a" }, "pat_unseeded");
    expect(r.erased).toBe(0); // default in-memory store → nothing to erase, no throw (real impl)
    await app.close();
  });
});

describe("M6-T12 action catalog (§8.1.2)", () => {
  it("declares only m6.* actions owned by m6, in the consolidated catalog, with no violations", () => {
    for (const entry of M6_ACTION_CATALOG) {
      expect(entry.action.startsWith("m6.")).toBe(true);
      expect(entry.moduleOwner).toBe("m6");
      expect(ACTION_CATALOG).toContainEqual(entry);
    }
    // §4.6.7 — the consolidated catalog (now including m6) is namespace- + uniqueness-clean.
    expect(validateActionCatalog()).toEqual([]);
  });

  it("scrubs free-text reason carriers (override/discharge) for narrative_free_text", () => {
    const overrides = M6_ACTION_CATALOG.filter((e) =>
      ["m6.f2f.window_overridden", "m6.compliance.window.overridden", "m6.discharge.created"].includes(e.action),
    );
    expect(overrides).toHaveLength(3);
    for (const e of overrides) expect(e.denylistCategories).toContain("narrative_free_text");
  });
});
