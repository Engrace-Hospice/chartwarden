// Boot smoke test (PHASE_0_SCAFFOLD_PLAN.md PR-0.4 exit criterion; promoted to the real
// §3.18 seam-registry surface by M1-T09).
// Asserts: (1) validateSeams() applies REQUIRED_SEAMS deny-stub defaults so an unregistered
// cross-module seam boots FAIL-CLOSED (present, but throwing on call) rather than open;
// (2) a module's real registration survives validateSeams() unchanged; (3) the eraser gate
// FAILS CLOSED at boot when a PHI data class has no eraser; (4) buildServer() serves /health.

import { beforeEach, describe, expect, it } from "vitest";
import { wireErasers } from "../../apps/backend/src/bootstrap/erasers/providers";
import {
  EraserError,
  __resetErasersForTest,
  validateErasers,
} from "../../apps/backend/src/bootstrap/erasers/registry";
import { bootSeams, buildServer } from "../../apps/backend/src/bootstrap/index";
import { NotImplementedError, wireSeams } from "../../apps/backend/src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  getSeam,
  registerSeam,
  validateSeams,
} from "../../apps/backend/src/bootstrap/seams/registry";

describe("seam + eraser boot gate (§3.18 fail-closed)", () => {
  beforeEach(() => {
    __resetSeamsForTest();
    __resetErasersForTest();
  });

  it("REQUIRED_SEAMS declares every required seam with an owner + deny-stub (§3.18.2)", () => {
    expect(REQUIRED_SEAMS.length).toBeGreaterThan(0);
    for (const r of REQUIRED_SEAMS) {
      expect(typeof r.key).toBe("string");
      expect(typeof r.ownerModule).toBe("number");
      expect(r.denyStub).toBeDefined();
    }
  });

  it("validateSeams() applies deny-stub defaults so an unregistered seam boots fail-closed", () => {
    // No module registered anything (Phase-0 baseline: wireSeams is a no-op hook).
    wireSeams();
    expect(() => validateSeams()).not.toThrow();
    // The contract is present after validation — but denies LOUDLY on call.
    const caseload = getSeam("CaseloadProvider");
    expect(() =>
      caseload.isInCaseload({ organizationId: "org_1", userId: "u_1", patientId: "p_1" }),
    ).toThrow(NotImplementedError);
  });

  it("validateSeams() keeps a module's real registration over the deny-stub", () => {
    const realCaseload = {
      async isInCaseload() {
        return true;
      },
      async caseloadPatientIds() {
        return ["patient_1"] as const;
      },
    };
    registerSeam("CaseloadProvider", realCaseload);
    validateSeams();
    expect(getSeam("CaseloadProvider")).toBe(realCaseload);
  });

  it("validateErasers() throws when a PHI data class has no eraser (no deny-stub default)", () => {
    expect(() => validateErasers()).toThrow(EraserError);
  });

  it("validateErasers() passes once every eraser stub is wired", () => {
    wireErasers();
    expect(() => validateErasers()).not.toThrow();
  });

  it("bootSeams() wires + validates seams and erasers end-to-end", () => {
    expect(() => bootSeams()).not.toThrow();
  });

  it("buildServer() boots and serves /health", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
