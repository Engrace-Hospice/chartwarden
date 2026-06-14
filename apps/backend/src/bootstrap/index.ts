// apps/backend/src/bootstrap/index.ts — M1 bootstrap barrel + boot gate.
//
// Promoted from the repo-root example boot.ts (PHASE_0_SCAFFOLD_PLAN.md PR-0.4). The
// server may not listen until bootSeams() has wired every module's seams + erasers and
// both validators pass. validateSeams()/validateErasers() FAIL CLOSED on a missing entry.

import Fastify, { type FastifyInstance } from "fastify";
import { wireErasers } from "./erasers/providers";
import { validateErasers } from "./erasers/registry";
import { wireSeams } from "./seams/providers";
import { validateSeams } from "./seams/registry";

/**
 * Wire every module's seams + erasers, then validate. Call before server.listen().
 * Throws SeamError / EraserError (and refuses to start) if any required entry is missing.
 */
export function bootSeams(): void {
  // In Phase 1 each module's init() runs here and registers its real implementations.
  wireSeams();
  wireErasers();
  validateSeams();
  validateErasers();
}

/** Build the Fastify host. Phase 0: validates boot contracts + a /healthz probe only. */
export function buildServer(): FastifyInstance {
  bootSeams();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}

export * from "./seams/registry";
export * from "./seams/providers";
export * from "./erasers/registry";
export * from "./erasers/providers";
export type * from "./interfaces";
