// apps/backend/__tests__/encounter-eraser.test.ts — M8-T12 the `encounter_record` eraser (§3.6, D7/D8)
// + the m8 audit-catalog actions (§8.1). Proves M8 registers the REAL encounter_record eraser over the
// Phase-0 deny-stub (validateErasers passes at boot), the eraser shreds the HearthNote cipher columns
// FIRST, then tombstones the encounter root, then deletes the encounter subtree, and the m8 action catalog is
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
  type EncounterEraseCounts,
  createDrizzleEncounterEraseStore,
  eraseEncounterRecord,
  createInMemoryEncounterEraseStore as makeEraseStore,
  registerEncounterErasers,
} from "../src/modules/08-encounters/index";

describe("M8-T12 — encounter_record eraser (§3.6, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("shreds the HearthNote cipher columns first, tombstones the root, deletes the encounter subtree, reports the total", async () => {
    const { store, tombstoned, cryptoErased } = makeEraseStore({
      tombstonedRoots: 2,
      signatures: 2,
      addenda: 1,
      carePlanLinks: 3,
      cosignatureRequests: 1,
      vitals: 4,
      mileage: 1,
      adlRecords: 2,
      nutritionRecords: 3,
      hearthnoteSelections: 5,
      hearthnoteAssembledOutputs: 2,
      hearthnoteLlmModifications: 1,
      draftConfirmations: 3,
      disciplinePlanLinks: 2,
      idgActionItemLinks: 1,
      signedSections: 6,
      amendments: 2,
      addendumCosignatureRequests: 1,
    });
    const { erased, counts } = await eraseEncounterRecord("org_a", "pat_1", store);
    expect(erased).toBe(42); // 40 satellites + 2 tombstoned roots
    expect(counts.vitals).toBe(4);
    expect(counts.tombstonedRoots).toBe(2);
    // The recorded ADLs and nutrition are counted: the encounter root is only tombstoned, so no cascade would remove them.
    expect(counts.adlRecords).toBe(2);
    expect(counts.nutritionRecords).toBe(3);
    // ADR-0114: the draft's confirmations and the sealed per-section rows go with the rest of the encounter subtree.
    expect(counts.draftConfirmations).toBe(3);
    // ADR-0114 S4b: the links to the M15 goals and interventions a drafted plan kept (live and removed alike) go with it.
    expect(counts.disciplinePlanLinks).toBe(2);
    // ADR-0114 S5b: the link to the M14 action item an IDG follow-up visit followed up goes with it.
    expect(counts.idgActionItemLinks).toBe(1);
    expect(counts.signedSections).toBe(6);
    // ADR-0114 VN-D30: an amendment's naming and resolution rows and the cosignature request an amending addendum opened go with the subtree too.
    expect(counts.amendments).toBe(2);
    expect(counts.addendumCosignatureRequests).toBe(1);
    expect(cryptoErased).toEqual(["pat_1"]); // cipher columns shredded before the tombstone and the deletes
    expect(tombstoned).toEqual(["pat_1"]);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ tombstonedRoots: 1, signatures: 2, vitals: 1 });
    expect((await eraseEncounterRecord("org_a", "pat_1", store)).erased).toBe(4);
    expect((await eraseEncounterRecord("org_a", "pat_1", store)).erased).toBe(0);
  });

  it("counts a tombstoned root even when it had no satellites, so the first run's certificate never reports 0 for a voided record", async () => {
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
    const none: Omit<EncounterEraseCounts, "tombstonedRoots"> = {
      signatures: 0,
      addenda: 0,
      carePlanLinks: 0,
      cosignatureRequests: 0,
      vitals: 0,
      mileage: 0,
      adlRecords: 0,
      nutritionRecords: 0,
      hearthnoteSelections: 0,
      hearthnoteAssembledOutputs: 0,
      hearthnoteLlmModifications: 0,
      draftConfirmations: 0,
      disciplinePlanLinks: 0,
      idgActionItemLinks: 0,
      signedSections: 0,
      amendments: 0,
      addendumCosignatureRequests: 0,
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

describe("M8-T12 — the tombstone scrubs everything about the destroyed patient the root still holds", () => {
  it("nulls the fall link (incident id and date) and voids the root with the one content-free reason", async () => {
    // A scripted `db`: the tombstone is one UPDATE inside a tenant transaction, so capture the values it sets.
    let set: Record<string, unknown> | undefined;
    const tx = {
      execute: async () => [],
      update: () => ({
        set: (values: Record<string, unknown>) => {
          set = values;
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
    };
    const db = { transaction: async (run: (tx: unknown) => unknown) => run(tx) };

    await createDrizzleEncounterEraseStore(db as never).tombstoneEncounters("org_a", "pat_1");

    expect(set).toMatchObject({
      status: "voided",
      fallIncidentId: null,
      fallOccurredOn: null,
      voidedReason: ENCOUNTER_ERASED_REASON,
    });
    expect((set?.voidedReason as string).length).toBeGreaterThanOrEqual(40); // encounter_voided_consistency
  });
});

describe("M8-T12 — m8 audit action catalog (§8.1)", () => {
  it("every m8 action is namespaced m8.* and owned by m8", () => {
    for (const e of M8_ACTION_CATALOG) {
      expect(e.action.startsWith("m8.")).toBe(true);
      expect(e.moduleOwner).toBe("m8");
    }
  });

  it("covers all 22 §8.1 events, the four ADR-0113 closure events (override granted, revoked and denied, policy changed) and the three ADR-0114 draft events (policy changed, section resolved, section amended)", () => {
    expect(M8_ACTION_CATALOG.length).toBe(29);
    const actions = M8_ACTION_CATALOG.map((e) => e.action);
    expect(actions).toContain("m8.encounter.draft_policy_changed");
    expect(actions).toContain("m8.encounter.draft_section_resolved");
    expect(actions).toContain("m8.encounter.section_amended");
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
