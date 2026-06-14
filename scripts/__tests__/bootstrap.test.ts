// Boot smoke test (PHASE_0_SCAFFOLD_PLAN.md PR-0.4 exit criterion).
// Asserts the seam + eraser boot gates FAIL CLOSED on a missing entry and pass once the
// Phase-0 deny-stubs are wired, and that buildServer() serves /healthz after booting.

import { beforeEach, describe, expect, it } from "vitest";
import { wireErasers } from "../../apps/backend/src/bootstrap/erasers/providers";
import {
  EraserError,
  __resetErasersForTest,
  validateErasers,
} from "../../apps/backend/src/bootstrap/erasers/registry";
import { bootSeams, buildServer } from "../../apps/backend/src/bootstrap/index";
import { wireSeams } from "../../apps/backend/src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  SeamError,
  __resetSeamsForTest,
  validateSeams,
} from "../../apps/backend/src/bootstrap/seams/registry";

describe("seam + eraser boot gate (fails closed)", () => {
  beforeEach(() => {
    __resetSeamsForTest();
    __resetErasersForTest();
  });

  it("validateSeams() throws when a required seam is unregistered", () => {
    expect(REQUIRED_SEAMS.length).toBeGreaterThan(0);
    expect(() => validateSeams()).toThrow(SeamError);
  });

  it("validateSeams() passes once every stub is wired", () => {
    wireSeams();
    expect(() => validateSeams()).not.toThrow();
  });

  it("validateErasers() throws when a PHI data class has no eraser", () => {
    expect(() => validateErasers()).toThrow(EraserError);
  });

  it("validateErasers() passes once every stub is wired", () => {
    wireErasers();
    expect(() => validateErasers()).not.toThrow();
  });

  it("bootSeams() wires + validates seams and erasers end-to-end", () => {
    expect(() => bootSeams()).not.toThrow();
  });

  it("buildServer() boots and serves /healthz", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
