// apps/backend/__tests__/consent-eraser.test.ts — M39-T10 the `consent` DataEraser (§3.8, D20).
//
// Proves: (1) M39 registers its REAL eraser over the deny-stub and the boot validateErasers() passes;
// (2) the §3.8 Part 2 LIFETIME refusal — a 42_cfr_part_2_release consent is retained while the patient
// is alive, erased once deceased; (3) the legal-hold refusal retains any class. The decision engine is
// unit-tested directly; the registration is exercised through a real buildServer() boot.
import {
  type ConsentSubjectSummary,
  createInMemoryConsentEraseStore,
  eraseConsentForSubject,
} from "@chartwarden/consent";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetErasersForTest,
  getEraser,
  validateErasers,
} from "../src/bootstrap/erasers/registry";
import { buildServer } from "../src/bootstrap/index";
import { wireModuleErasers, wireModuleSeams } from "../src/index";
import { registerConsentErasers } from "../src/modules/39-consent/index";

const ORG = "org-1";
const PAT = "pat-1";

function summary(over: Partial<ConsentSubjectSummary>): ConsentSubjectSummary {
  return { patientDeceased: false, rows: [], ...over };
}

describe("M39-T10 — consent eraser registration + validateErasers", () => {
  beforeEach(() => {
    __resetErasersForTest();
  });

  it("registers the real consent eraser and the boot eraser gate passes", async () => {
    // A real boot wires every module's eraser (incl. M39) over M1's deny-stubs, so validateErasers
    // passes — the missing `consent` eraser would otherwise have failed the gate.
    const app = buildServer({
      registerModuleSeams: wireModuleSeams,
      registerModuleErasers: wireModuleErasers,
    });
    expect(() => validateErasers()).not.toThrow();
    expect(typeof getEraser("consent").erase).toBe("function");
    await app.close();
  });

  it("erases via the registered eraser over the in-memory store", async () => {
    const { store, data } = createInMemoryConsentEraseStore();
    data.subjects.set(
      `${ORG}:${PAT}`,
      summary({
        patientDeceased: true,
        rows: [{ id: "c1", typeKey: "hipaa_release", legalHold: false }],
      }),
    );
    registerConsentErasers({ store });
    const result = await getEraser("consent").erase({ orgId: ORG }, PAT);
    expect(result.erased).toBe(1);
  });
});

describe("M39-T10 — §3.8 Part 2 lifetime + legal-hold refusal (eraseConsentForSubject)", () => {
  it("retains a 42_cfr_part_2_release while the patient is ALIVE, erases the rest", async () => {
    const { store, data } = createInMemoryConsentEraseStore();
    data.subjects.set(
      `${ORG}:${PAT}`,
      summary({
        patientDeceased: false,
        rows: [
          { id: "part2", typeKey: "42_cfr_part_2_release", legalHold: false },
          { id: "hipaa", typeKey: "hipaa_release", legalHold: false },
        ],
      }),
    );
    const r = await eraseConsentForSubject(ORG, PAT, store);
    expect(r.erased).toBe(1); // only the hipaa_release deleted
    expect(r.retained["42_cfr_part_2_release"]).toBe(1); // Part 2 retained for the lifetime
  });

  it("erases the 42_cfr_part_2_release once the patient is DECEASED (lifetime ended)", async () => {
    const { store, data } = createInMemoryConsentEraseStore();
    data.subjects.set(
      `${ORG}:${PAT}`,
      summary({
        patientDeceased: true,
        rows: [{ id: "part2", typeKey: "42_cfr_part_2_release", legalHold: false }],
      }),
    );
    const r = await eraseConsentForSubject(ORG, PAT, store);
    expect(r.erased).toBe(1);
    expect(r.retained["42_cfr_part_2_release"]).toBeUndefined();
  });

  it("retains ANY class under an active legal hold (override erases it)", async () => {
    const rows = [{ id: "h", typeKey: "hipaa_release" as const, legalHold: true }];
    const held = await eraseConsentForSubject(
      ORG,
      PAT,
      createInMemoryConsentEraseStore({
        subjects: new Map([[`${ORG}:${PAT}`, summary({ patientDeceased: true, rows })]]),
      }).store,
    );
    expect(held.erased).toBe(0);
    expect(held.retained.consent_held_by_legal_hold).toBe(1);

    const overridden = await eraseConsentForSubject(
      ORG,
      PAT,
      createInMemoryConsentEraseStore({
        subjects: new Map([[`${ORG}:${PAT}`, summary({ patientDeceased: true, rows })]]),
      }).store,
      { legalHoldOverride: true },
    );
    expect(overridden.erased).toBe(1);
  });
});
