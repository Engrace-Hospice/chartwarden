// apps/backend/__tests__/patient-eraser.test.ts — M5-T12 the `clinical_record` eraser (§8/§10, D7/D8).
// Proves M5 registers the REAL clinical_record eraser over the Phase-0 deny-stub (validateErasers
// passes at boot), and the eraser deletes the patient subtree + tombstones the row (patient_merge
// preserved). Plus the m5 audit-catalog action.
import { ACTION_CATALOG, M5_ACTION_CATALOG, validateActionCatalog } from "@wardenx/audit";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetErasersForTest, getEraser, validateErasers } from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import {
  createInMemoryPatientEraseStore as makeEraseStore,
  erasePatientClinicalRecord,
  registerPatientErasers,
} from "../src/modules/05-patient/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";

describe("M5-T12 — clinical_record eraser (§8/§10, D7/D8)", () => {
  beforeEach(() => __resetErasersForTest());

  it("erases the patient subtree, tombstones the row, reports the total", async () => {
    const { store, tombstoned } = makeEraseStore({ addresses: 2, identifiers: 3, payers: 1, assignments: 4 });
    const { erased, counts } = await erasePatientClinicalRecord("org_a", "p1", store);
    expect(erased).toBe(10);
    expect(counts.addresses).toBe(2);
    expect(tombstoned).toEqual(["p1"]);
  });

  it("is idempotent — a second erase removes nothing", async () => {
    const { store } = makeEraseStore({ addresses: 2 });
    expect((await erasePatientClinicalRecord("org_a", "p1", store)).erased).toBe(2);
    expect((await erasePatientClinicalRecord("org_a", "p1", store)).erased).toBe(0);
  });

  it("registers over the deny-stub; the boot hook makes validateErasers() pass", async () => {
    registerPatientErasers({ store: makeEraseStore({ identifiers: 1 }).store });
    const r = await getEraser("clinical_record").erase({ orgId: "org_a" }, "p1");
    expect(r.erased).toBe(1);
  });

  it("a real buildServer() boot wires the eraser so validateErasers() passes", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams, registerModuleErasers: wireModuleErasers });
    expect(() => validateErasers()).not.toThrow();
    const r = await getEraser("clinical_record").erase({ orgId: "org_a" }, "p-unseeded");
    expect(r.erased).toBe(0); // default in-memory store → nothing to erase, no throw (real impl)
    await app.close();
  });
});

describe("M5-T12 action catalog (§8.1)", () => {
  it("declares m5.patient.mutator_applied owned by m5, Part-2 eligible, in the consolidated catalog", () => {
    expect(M5_ACTION_CATALOG.map((e) => e.action)).toEqual(["m5.patient.mutator_applied"]);
    const entry = M5_ACTION_CATALOG[0];
    expect(entry?.moduleOwner).toBe("m5");
    expect(entry?.isPartTwoEligible).toBe(true);
    expect(entry?.defaultRetentionClass).toBe("compliance");
    expect(validateActionCatalog()).toEqual([]);
    expect(ACTION_CATALOG).toContainEqual(entry);
  });
});
