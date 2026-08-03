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
   * at boot). Defaults to {@link DEFAULT_READ_AUDIT_PREFIXES}; pass a list to narrow or widen it.
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
 * Parse `TRUSTED_PROXY_CIDRS` into Fastify's `trustProxy` value. Returns `false` when unset or empty,
 * so the default posture is "trust nothing" rather than "trust everything" — an unset env var must not
 * silently let a caller choose its own `X-Forwarded-For`, and therefore its own rate-limit bucket.
 */
export function parseTrustedProxies(raw: string | undefined): string[] | false {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length > 0 ? entries : false;
}

/**
 * The PHI read surface under §2.5 read-audit coverage. Every GET/HEAD registered under one of these
 * prefixes must declare `config.auditRead` — an emission config, or a justified `{ none: "…" }`
 * waiver — or the route refuses to register and the host refuses to boot.
 *
 * This was `["/api/v1/patients"]`, and `readAuditPrefixes` was never passed by the composition root,
 * so the gate governed ~9 of ~150 mounted PHI read routes. Everything else — M30's incident, abuse-
 * allegation, mortality and infection queues (whose own source says "These are PHI routes"), and the
 * M23/M24/M25 claim, denial and remittance surfaces, all of which carry `patient_id`, service dates
 * and diagnosis codes — registered with no declaration required and emitted nothing. An OCR
 * accounting-of-disclosures request under §164.528, or a snooping investigation, could not have
 * reconstructed those reads.
 *
 * The list is deliberately explicit rather than "/api/v1": the M6–M14/M17/M18/M22 clinical-core
 * prefixes are NOT here yet, because those routes carry no `config.auditRead` and adding their
 * prefixes would only fail the boot. They are the remaining widening work, and they matter most —
 * now that the clinical core mounts live Drizzle route services (see registerModuleRoutes in index.ts),
 * annotating their reads with `config.auditRead` is the follow-up. Prefixes are matched with startsWith,
 * so "/api/v1/claims" also governs "/api/v1/claims/:id/validation-runs".
 */
export const DEFAULT_READ_AUDIT_PREFIXES: readonly string[] = [
  // M5 patient chart (the original covered surface) + the patient-scoped reads M7/M9/M10/M12/M39 hang off it.
  "/api/v1/patients",
  // M16 Bereavement · M15 Discipline plans · M20 Field safety · M19 On-call — already at full
  // coverage; listing them locks that in so a new unannotated read route cannot regress them.
  "/api/v1/bereavement",
  "/api/v1/discipline-plans",
  "/api/v1/safety",
  "/api/v1/oncall",
  "/api/v1/escalations",
  // M30 HQRP & Quality — incidents (incl. abuse allegations), mortality reviews, infection
  // surveillance, CAHPS decedents. The QAPI/SRA/risk-register/measure reads carry justified waivers.
  "/api/v1/quality",
  // M23 Billing (Medicare) — a claim carries patient_id, dates of service and diagnosis codes.
  "/api/v1/billing",
  "/api/v1/claims",
  "/api/v1/noe-records",
  "/api/v1/notr-records",
  "/api/v1/internal/billing",
  // M24 Billing (Medicaid) — same PHI shape.
  "/api/v1/medicaid-claims",
  "/api/v1/medicaid-eligibility-checks",
  "/api/v1/medicaid-validation-runs",
  "/api/v1/medicaid-validation-worklist",
  "/api/v1/medicaid-validation-overrides",
  "/api/v1/medicaid-rule-config",
  "/api/v1/medicaid-ar-dashboard",
  "/api/v1/rb-days",
  "/api/v1/rb-arrangements",
  "/api/v1/state-medicaid-trading-partner-credentials",
  // M25 Remittance & Denials — an 835 line and a denial both resolve to a patient's claim.
  "/api/v1/remittance",
  "/api/v1/denials",
  "/api/v1/appeals",
  "/api/v1/taxonomy",
  "/api/v1/internal/denials",
  "/api/v1/internal/remittance",
  "/api/v1/internal/patient-responsibility",
];

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
    // `request.ip` is the SOCKET peer unless Fastify is told to trust the forwarding hop. Behind a
    // load balancer that makes every unauthenticated request share one `ip:<LB address>` rate-limit
    // bucket (plugins/security.ts keys on request.ip) — i.e. the 30/min unauthenticated tier becomes
    // 30/min for the ENTIRE deployment, and one client trivially locks everyone out of /login and the
    // public signup + collaborator-consume routes.
    //
    // Deliberately NOT `true`: trusting every hop lets any caller forge X-Forwarded-For and pick its
    // own bucket — or someone else's. `TRUSTED_PROXY_CIDRS` is an explicit allow-list (comma-separated
    // IPs/CIDRs, e.g. the LB subnet); absent, this stays false and the socket peer is used, which is
    // correct for local/dev and for a direct-exposure deployment.
    trustProxy: parseTrustedProxies(process.env.TRUSTED_PROXY_CIDRS),
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
  // PHI read-audit (M4 §2.5): coverage gate refuses a GET/HEAD under a covered PHI prefix lacking a
  // config.auditRead declaration; with a DB client it also EMITS the read event per successful response.
  // Added before any routes so the onRoute coverage hook sees them all.
  applyReadAuditCoverage(app, {
    enforcedPrefixes: deps.readAuditPrefixes ?? DEFAULT_READ_AUDIT_PREFIXES,
    db: deps.db,
  });

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
export * from "./in-memory-ledger";
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
export * from "./env";
export type * from "./interfaces";
