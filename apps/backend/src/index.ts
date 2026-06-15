// @wardenx/backend — Fastify host entry + COMPOSITION ROOT (not in any module codePath, so
// exempt from the module-boundary import rules — it may import every module's init). It builds
// the server, runs the seam/eraser boot gate, and registers each Phase-1 module's real seams
// via `wireModuleSeams` (M1's bootstrap cannot import a downstream module; the composition
// root does, then hands the registration into the boot gate before validateSeams()).
import { buildServer } from "./bootstrap/index";
import { registerIdentityErasers, registerIdentitySeams } from "./modules/02-identity/index";

export { buildServer };
export * from "./bootstrap/index";

/**
 * Register every Phase-1 producer module's real seams into the M1 registry. Passed to
 * buildServer() as `registerModuleSeams`, it runs inside bootSeams() after M1's wireSeams()
 * and before validateSeams(), so the real seams stand over the deny-stubs (§3.18).
 */
export function wireModuleSeams(): void {
  registerIdentitySeams(); // M2 — SessionContextResolver + AuditorSessionMinter (§4.7)
  // Phase-1 producers append here as they land: M5 CaseloadProvider/PatientReader, M22
  // DocumentRenderer, M39 ConsentEvaluator, …
}

/**
 * Register every module's REAL data eraser over the Phase-0 deny-stubs. Passed to
 * buildServer() as `registerModuleErasers`, it runs inside bootSeams() AFTER wireErasers()
 * (which deny-stubs every REQUIRED_ERASERS class) and before validateErasers(), so a real
 * eraser stands over its stub. A right-to-erasure request then hits a working eraser, not a
 * silent no-op (M2-T10).
 */
export function wireModuleErasers(): void {
  registerIdentityErasers(); // M2 — `identity` data class (two_factor/passkey + invitations)
  // Phase-1 data-class owners append here as they land (M4 destruction-cert workflow).
}

// Start only when run directly (not when imported by tests/tooling).
// `import.meta.main` is a Bun runtime flag; cast keeps tsc happy without bun-types.
if ((import.meta as { main?: boolean }).main) {
  const app = buildServer({
    registerModuleSeams: wireModuleSeams,
    registerModuleErasers: wireModuleErasers,
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
