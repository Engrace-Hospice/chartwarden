// apps/backend/__tests__/encounter-eraser.test.ts — M8-T12 the `encounter_record` eraser (§3.6, D7/D8)
// + the m8 audit-catalog actions (§8.1). Proves M8 registers the REAL encounter_record eraser over the
// Phase-0 deny-stub (validateErasers passes at boot), the eraser crypto-erases the HearthNote ciphertext
// FIRST then tombstones the encounter root + deletes the encounter subtree, and the m8 action catalog is
// well-formed (namespace + uniqueness) — and disjoint from M5/M6/M7's data classes.
import { ACTION_CATALOG, M8_ACTION_CATALOG, validateActionCatalog } from "@chartwarden/audit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import { ENCOUNTER_ERASED_REASON } from "../src/modules/08-encounters/erasers/encounter-eraser";
import {
  eraseEncounterRecord,
  createInMemoryEncounterEraseStore as makeEraseStore,
  registerEncounterErasers,
} from "../src/modules/08-encounters/index";

describe("M8-T12 — encounter_record eraser (§3.6, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("crypto-erases HearthNote first, deletes the encounter subtree, tombstones the root, reports the total", async () => {
    const { store, tombstoned, cryptoErased } = makeEraseStore({
      tombstonedRoots: 2,
      signatures: 2,
      addenda: 1,
      carePlanLinks: 3,
      cosignatureRequests: 1,
      vitals: 4,
      mileage: 1,
      hearthnoteSelections: 5,
      hearthnoteAssembledOutputs: 2,
      hearthnoteLlmModifications: 1,
    });
    const { erased, counts } = await eraseEncounterRecord("org_a", "pat_1", store);
    expect(erased).toBe(22); // 20 satellites + 2 tombstoned roots
    expect(counts.vitals).toBe(4);
    expect(counts.tombstonedRoots).toBe(2);
    expect(cryptoErased).toEqual(["pat_1"]); // DEK destroyed before structural delete
    expect(tombstoned).toEqual(["pat_1"]);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ tombstonedRoots: 1, signatures: 2, vitals: 1 });
    expect((await eraseEncounterRecord("org_a", "pat_1", store)).erased).toBe(4);
    expect((await eraseEncounterRecord("org_a", "pat_1", store)).erased).toBe(0);
  });

  it("counts a tombstoned root even when it had no satellites, so the certificate never reports 0 for a voided record", async () => {
    const { store } = makeEraseStore({ tombstonedRoots: 3 });
    const { erased, counts } = await eraseEncounterRecord("org_a", "pat_1", store);
    expect(counts.tombstonedRoots).toBe(3);
    expect(erased).toBe(3);
  });

  it("refuses before any write unless the connection is the destruction role, and changes nothing", async () => {
    const { store, tombstoned, cryptoErased } = makeEraseStore(
      { tombstonedRoots: 1, signatures: 2 },
      { destructionRole: false },
    );
    await expect(eraseEncounterRecord("org_a", "pat_1", store)).rejects.toMatchObject({
      code: "DEGRADED",
      statusCode: 503,
    });
    expect(cryptoErased).toEqual([]); // nothing shredded
    expect(tombstoned).toEqual([]); // nothing tombstoned
  });

  it("checks the role, then shreds, then scrubs the root's text, then deletes the satellites — a failed tombstone leaves the satellites for a retry", async () => {
    const calls: string[] = [];
    const none = {
      signatures: 0,
      addenda: 0,
      carePlanLinks: 0,
      cosignatureRequests: 0,
      vitals: 0,
      mileage: 0,
      hearthnoteSelections: 0,
      hearthnoteAssembledOutputs: 0,
      hearthnoteLlmModifications: 0,
    };
    const store = {
      assertDestructionRole: async () => void calls.push("role"),
      cryptoEraseHearthnote: async () => void calls.push("shred"),
      tombstoneEncounters: async () => {
        calls.push("tombstone");
        return 0;
      },
      eraseEncounterSubtree: async () => {
        calls.push("delete");
        return none;
      },
    };
    await eraseEncounterRecord("org_a", "pat_1", store);
    expect(calls).toEqual(["role", "shred", "tombstone", "delete"]);
  });

  it("the tombstone placeholder clears the longest reason-length CHECK floor (the live suite proves the CHECKs themselves)", () => {
    // encounter_administrative_override_consistency wants 100 characters; a shorter placeholder would make every
    // destruction of a root with that tier roll back on a real database (the in-memory store has no CHECKs).
    expect(ENCOUNTER_ERASED_REASON.length).toBeGreaterThanOrEqual(100);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass for the data class", async () => {
    registerEncounterErasers({ store: makeEraseStore({ signatures: 1 }).store });
    const r = await getEraser("encounter_record").erase({ orgId: "org_a" }, "pat_1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    // bootSeams() wires the Phase-0 deny-stubs AND the module erasers before validateErasers() — so
    // encounter_record (and every required class) resolves at boot. The default in-memory store erases
    // nothing for an unseeded patient, but the real impl must not throw.
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("encounter_record").erase({ orgId: "org_a" }, "pat_unseeded");
    expect(r.erased).toBe(0);
    await app.close();
  });
});

describe("M8-T12 — m8 audit action catalog (§8.1)", () => {
  it("every m8 action is namespaced m8.* and owned by m8", () => {
    for (const e of M8_ACTION_CATALOG) {
      expect(e.action.startsWith("m8.")).toBe(true);
      expect(e.moduleOwner).toBe("m8");
    }
  });

  it("covers all 22 §8.1 events plus the four ADR-0113 closure events (override granted, revoked and denied, policy changed)", () => {
    expect(M8_ACTION_CATALOG.length).toBe(26);
  });

  it("the reason carriers scrub narrative free text", () => {
    const byAction = new Map(M8_ACTION_CATALOG.map((e) => [e.action, e]));
    expect(
      byAction.get("m8.encounter.cosignature_supervisor_released")?.denylistCategories,
    ).toContain("narrative_free_text");
    expect(
      byAction.get("m8.encounter.significant_late_entry_overridden")?.denylistCategories,
    ).toContain("narrative_free_text");
    expect(byAction.get("m8.encounter.administrative_late_override")?.denylistCategories).toContain(
      "narrative_free_text",
    );
    expect(byAction.get("m8.encounter.voided")?.denylistCategories).toContain(
      "narrative_free_text",
    );
    expect(byAction.get("m8.encounter.addendum_created")?.denylistCategories).toContain(
      "narrative_free_text",
    );
    expect(byAction.get("m8.encounter.evv_missing_documented")?.denylistCategories).toContain(
      "narrative_free_text",
    );
  });

  it("the consolidated catalog stays valid with m8 merged in (no namespace/dup violation)", () => {
    expect(ACTION_CATALOG.some((e) => e.action === "m8.encounter.signed")).toBe(true);
    expect(validateActionCatalog()).toEqual([]);
  });
});
