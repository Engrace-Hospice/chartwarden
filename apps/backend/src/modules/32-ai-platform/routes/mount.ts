// apps/backend/src/modules/32-ai-platform/routes/mount.ts — M32 route mount (§4.1) + plugin barrel.
//
// The six §4.1 route plugins (the capability registry · the kill switch · the two consent layers · the
// disclosure ledger · the hallucination loop · the tenant + safety operational surfaces).
// `mountM32Routes` is the single composition-root entry (the M15/M16/M19/M20/M21/M24/M26 mount
// precedent), mounted behind the same authenticate / security / error chain as every other module.
//
// Every route gates on its §4.6 `requirePermission` key plus its §4.7 ABAC binding; the THREE §4.1
// step-up operations (`ai.kill_switch.activate` on both directions, `ai.capability.transition`,
// `ai.prompt.activate`) add `requireStepUp` — the set is pinned in ../permission-keys.ts and asserted by
// the §10 test, so a future key cannot silently join or leave it.
//
// ── WHAT IS NOT MOUNTED, AND WHY THAT IS THE POINT OF THE MODULE ───────────────────────────────────
//
// `aiSdk.invoke`, `aiSdk.recordHitlOutcome` and `aiSdk.embeddings.embed` are §4.1's "internal-only" trio
// and have NO route. They are reached through the §4.2 seams, in-process, by consumer modules — which is
// what lets the invocation path run inside the caller's own request context and record the disclosure on
// the caller's own transaction. Exposing them over HTTP would put an unauthenticated-by-construction
// entry point in front of the one code path that writes PHI to a model vendor.
import type { FastifyInstance } from "fastify";

import { registerCapabilityRoutes } from "./capabilities.routes";
import { registerConsentRoutes } from "./consent.routes";
import { registerHallucinationRoutes } from "./hallucinations.routes";
import type { M32RouteServices } from "./index";
import { registerInvocationRoutes } from "./invocations.routes";
import { registerKillSwitchRoutes } from "./kill-switch.routes";
import { registerSafetyOpsRoutes } from "./safety-ops.routes";
import { registerTenantOpsRoutes } from "./tenant-ops.routes";

export { registerCapabilityRoutes, type CapabilityRouteDeps } from "./capabilities.routes";
export { registerKillSwitchRoutes, type KillSwitchRouteDeps } from "./kill-switch.routes";
export { registerConsentRoutes, type ConsentRouteDeps } from "./consent.routes";
export { registerInvocationRoutes, type InvocationRouteDeps } from "./invocations.routes";
export {
  registerHallucinationRoutes,
  type AiReportCipherPort,
  type HallucinationRouteDeps,
} from "./hallucinations.routes";
export { registerTenantOpsRoutes, type TenantOpsRouteDeps } from "./tenant-ops.routes";
export {
  registerSafetyOpsRoutes,
  M32_DEFAULT_DRIFT_WINDOW_HOURS,
  type SafetyOpsRouteDeps,
} from "./safety-ops.routes";

/** Mount every M32 §4.1 route plugin over the composed service surface. */
export function mountM32Routes(app: FastifyInstance, services: M32RouteServices): void {
  const { governance, safety, prompts, read, routing, cipher, promptRegistry, now } = services;
  registerCapabilityRoutes(app, { governance });
  registerKillSwitchRoutes(app, { safety });
  registerConsentRoutes(app, { governance });
  registerInvocationRoutes(app, { read });
  registerHallucinationRoutes(app, { safety, cipher });
  registerTenantOpsRoutes(app, { read, routing, now });
  registerSafetyOpsRoutes(app, { safety, prompts, read, promptRegistry, now });
}
