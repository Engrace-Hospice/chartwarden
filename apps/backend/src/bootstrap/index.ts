// apps/backend/src/bootstrap/index.ts — M1 bootstrap barrel + boot gate + Fastify host.
//
// Promoted from the repo-root example boot.ts (PHASE_0_SCAFFOLD_PLAN.md PR-0.4). The
// server may not listen until bootSeams() has wired every module's seams + erasers and
// both validators pass. validateSeams()/validateErasers() FAIL CLOSED on a missing entry.
//
// M1-T10 mounts the foundation API surface (spec §4): the security baseline (§4.6.1),
// request-context + error-envelope + idempotency middleware (§4.4–4.6), and the
// health/ready/version + system-status + feature-flag routes (§4.1–4.2). Every external
// dependency (DB/Valkey readers, the auth hook) is INJECTED with a safe slice default, so
// the host boots and is testable with no live infra; production supplies the real adapters.
import type { DbClient } from "@wardenx/db";
import type { IdempotencyStore } from "@wardenx/shared";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { wireErasers } from "./erasers/providers";
import { validateErasers } from "./erasers/registry";
import { applyErrorHandler } from "./plugins/error-handler";
import { applyIdempotency, createInMemoryIdempotencyStore } from "./plugins/idempotency";
import { buildLoggerOptions } from "./plugins/logger";
import { applyReadAuditCoverage } from "./plugins/read-audit";
import { applyRequestContext } from "./plugins/request-context";
import { type SecurityOptions, applySecurityBaseline } from "./plugins/security";
import { type ReadinessProbe, defaultReadinessProbe, registerHealthRoutes } from "./routes/health";
import {
  type FeatureFlagReader,
  type SystemStatusReader,
  createDefaultFeatureFlagReader,
  createInMemorySystemStatusReader,
  registerSystemRoutes,
} from "./routes/system";
import { wireSeams } from "./seams/providers";
import { validateSeams } from "./seams/registry";

/** Hook M2's auth plugin supplies to populate userId/organizationId/roles (spec §4.5). */
export type AuthenticateHook = (request: FastifyRequest) => Promise<void> | void;

/** Injection surface for the foundation host — every field has a slice-safe default. */
export interface ServerDeps {
  systemStatusReader?: SystemStatusReader;
  featureFlagReader?: FeatureFlagReader;
  idempotencyStore?: IdempotencyStore;
  readinessProbe?: ReadinessProbe;
  authenticate?: AuthenticateHook;
  security?: SecurityOptions;
  /** Request body size cap (SEC-065); default 10 MB. */
  bodyLimit?: number;
  /**
   * PHI path prefixes under read-audit coverage (M4 §2.5). Every GET/HEAD registered under one of
   * these refuses to register unless it carries `config.auditRead` (audit finding #4 — fail-closed
   * at boot). Defaults to the mounted PHI patient surface; the composition root widens it as more
   * PHI read modules adopt the `config.auditRead` annotation.
   */
  readAuditPrefixes?: readonly string[];
  /**
   * The production DB client (AUTH-T01, ADR-0033). The composition root builds it from DATABASE_URL
   * and injects it here; it is consumed by the Better Auth mount (AUTH-T02) + repositories. Absent in
   * the slice/tests, so the host still boots infra-free (the unit suite never opens a connection).
   */
  db?: DbClient;
  /**
   * Composition-root hook to register every Phase-1 module's REAL seams before
   * validateSeams() (§3.18). M1 cannot import a downstream module, so the composition root
   * (apps/backend/src/index.ts) supplies this; when omitted, validateSeams() applies the
   * REQUIRED_SEAMS deny-stub defaults and every unregistered seam boots fail-closed.
   */
  registerModuleSeams?: () => void;
  /**
   * Composition-root hook to register every module's REAL data eraser over the Phase-0
   * deny-stubs (M2-T10). It runs after wireErasers() (which deny-stubs every required class)
   * and before validateErasers(), so a real eraser stands over its stub. M1 cannot import a
   * downstream module, so the composition root (apps/backend/src/index.ts) supplies this.
   */
  registerModuleErasers?: () => void;
  /**
   * Composition-root hook to MOUNT every module's REST routes (M2..M40 `registerNRoutes(app, deps)`).
   * M1's bootstrap cannot import a downstream module, so the composition root supplies this; it runs
   * after the M1 foundation routes, inside the same authenticate/security/error chain. When omitted
   * (slice/tests that don't exercise HTTP), only the foundation routes are served.
   */
  registerModuleRoutes?: (app: FastifyInstance) => void;
}

const TEN_MB = 10 * 1024 * 1024;

/**
 * Wire every module's seams + erasers, then validate. Call before server.listen().
 * Throws SeamError / EraserError (and refuses to start) if any required entry is missing.
 * `registerModuleSeams` registers downstream modules' real seams (after wireSeams(), before
 * validateSeams()); `registerModuleErasers` registers their real erasers AFTER wireErasers()
 * (so a real eraser stands over its deny-stub) and before validateErasers(). M1 may import
 * neither — the composition root supplies both.
 */
export function bootSeams(
  registerModuleSeams?: () => void,
  registerModuleErasers?: () => void,
): void {
  // In Phase 1 each module's init() runs here and registers its real implementations.
  wireSeams();
  registerModuleSeams?.(); // composition-root: M2..M40 producer seam registrations
  wireErasers();
  registerModuleErasers?.(); // composition-root: M2..M40 real erasers over the deny-stubs
  validateSeams();
  validateErasers();
}

/**
 * Build the Fastify host: run the seam/eraser boot gate, wire the cross-cutting middleware
 * chain (onRequest order matters: request-context → authenticate → security, so the
 * rate-limiter sees the authenticated tier), then mount the M1 foundation routes.
 */
export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  bootSeams(deps.registerModuleSeams, deps.registerModuleErasers);

  const app = Fastify({
    logger: buildLoggerOptions(), // PHI-safe: path-only URLs + redacted auth headers/cookies
    bodyLimit: deps.bodyLimit ?? TEN_MB,
  });

  // --- cross-cutting middleware ---
  applyRequestContext(app);
  if (deps.authenticate) {
    const authenticate = deps.authenticate;
    app.addHook("onRequest", async (request) => {
      await authenticate(request);
    });
  }
  applySecurityBaseline(app, deps.security); // CORS + rate-limit read the (now-auth'd) context
  applyErrorHandler(app);
  applyIdempotency(app, deps.idempotencyStore ?? createInMemoryIdempotencyStore());
  // PHI read-audit coverage (M4 §2.5): refuse to register a GET/HEAD under a covered PHI prefix that
  // lacks a config.auditRead declaration. Added before any routes so the hook sees them all.
  applyReadAuditCoverage(app, { enforcedPrefixes: deps.readAuditPrefixes ?? ["/api/v1/patients"] });

  // --- routes ---
  app.get("/healthz", async () => ({ status: "ok" })); // legacy probe (boot smoke test)
  registerHealthRoutes(app, deps.readinessProbe ?? defaultReadinessProbe);
  registerSystemRoutes(app, {
    statusReader: deps.systemStatusReader ?? createInMemorySystemStatusReader(),
    flagReader: deps.featureFlagReader ?? createDefaultFeatureFlagReader(),
  });
  // Module REST routes (M2..M40) — mounted by the composition root behind the same auth/security chain.
  deps.registerModuleRoutes?.(app);

  return app;
}

export * from "./seams/registry";
export * from "./seams/providers";
export * from "./erasers/registry";
export * from "./erasers/providers";
export * from "./plugins/request-context";
export * from "./plugins/error-handler";
export * from "./plugins/security";
export * from "./plugins/idempotency";
// The M1 deny-stub guards (requireSession/requireRole/requirePermission/requireAbac) were a
// forward-seam until M3 landed; M3-T10 flipped every route to the REAL @wardenx/auth contract,
// so the deny-stub is retired (no `./plugins/guards` re-export).
export * from "./routes/health";
export * from "./routes/system";
export * from "./plugins/authenticate";
export type * from "./interfaces";
