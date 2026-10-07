// apps/backend/src/modules/23-billing-medicare/routes/mount.ts — M23 route mount (§4.1) + plugin barrel.
//
// `mountM23Routes` is the single composition-root entry (the M27 `mountM27Routes` precedent), mounted behind
// the same authenticate/security/error chain as every other module's routes. Each §4.1 route group is a
// self-contained plugin that takes the split `{ readService, writeService, assemblyService }` deps from
// {@link M23RouteServices}; this file composes them and re-exports each so a route test can mount one group
// over a fresh in-memory backend. This file touches no SHARED composition file — the composition root
// imports `mountM23Routes` from here and binds the three Drizzle-backed / seam-backed services.
//
// Every route already gates on its §4.6 `requirePermission` key + the §4.7 ABAC chain; every MUTATING route
// composes the §D13 `rejectAiActor` block + the `Idempotency-Key` presence guard, and the filing actions
// (claim submit / replace / void, NOE/NOTR submit, validation override, MAC-credential admin) add the §D14
// `requireStepUp` assertion. Route groups B–F (validation/override, NOE/NOTR, rule-config, eligibility,
// sequestration/MAC, AR/metrics, the internal seams, platform admin) register alongside claims-core as their
// plugins land — each is appended below with the SAME split-service signature.
import type { FastifyInstance } from "fastify";

import { registerClaimsRoutes } from "./claims.routes";
import { registerEligibilityRoutes } from "./eligibility.routes";
import type { M23RouteServices } from "./index";
import { type M23InternalSeamProvider, registerInternalSeamRoutes } from "./internal.routes";
import { registerMacCredentialRoutes } from "./mac-credentials.routes";
import { registerMetricsRoutes } from "./metrics.routes";
import { registerNoeRoutes } from "./noe.routes";
import { registerNotrRoutes } from "./notr.routes";
import { registerRateTableRoutes } from "./rate-table.routes";
import { registerRuleConfigRoutes } from "./rule-config.routes";
import { registerSequestrationPolicyRoutes } from "./sequestration-policy.routes";
import { registerTransferNoticeRoutes } from "./transfer-notice.routes";
import { registerValidationRoutes } from "./validation.routes";
import { registerWageIndexRoutes } from "./wage-index.routes";

export { registerClaimsRoutes, type ClaimsRouteDeps } from "./claims.routes";
export { registerValidationRoutes, type ValidationRouteDeps } from "./validation.routes";
export { registerRuleConfigRoutes, type RuleConfigRouteDeps } from "./rule-config.routes";
export { registerNoeRoutes, type NoeRouteDeps } from "./noe.routes";
export { registerNotrRoutes, type NotrRouteDeps } from "./notr.routes";
export {
  registerTransferNoticeRoutes,
  type TransferNoticeRouteDeps,
} from "./transfer-notice.routes";
export { registerEligibilityRoutes, type EligibilityRouteDeps } from "./eligibility.routes";
export {
  registerSequestrationPolicyRoutes,
  type SequestrationPolicyRouteDeps,
} from "./sequestration-policy.routes";
export { registerMacCredentialRoutes, type MacCredentialRouteDeps } from "./mac-credentials.routes";
export { registerRateTableRoutes, type RateTableRouteDeps } from "./rate-table.routes";
export { registerWageIndexRoutes, type WageIndexRouteDeps } from "./wage-index.routes";
export { registerMetricsRoutes, type MetricsRouteDeps } from "./metrics.routes";
export {
  registerInternalSeamRoutes,
  denyStubInternalSeamProvider,
  type InternalSeamRouteDeps,
  type M23InternalSeamProvider,
} from "./internal.routes";

/**
 * Mount every M23 §4.1 route plugin over the read / write / assembly services. The composition root calls
 * this when a DB client is present, behind the same authenticate/security/error chain as the other modules
 * (the `mountM27Routes` precedent). No read/write method-name overlap, so each plugin binds the services
 * directly.
 */
export function mountM23Routes(
  app: FastifyInstance,
  services: M23RouteServices & { readonly internalSeam?: M23InternalSeamProvider },
): void {
  const { readService, writeService, assemblyService, internalSeam } = services;

  // Route group A — claims core (§4.1 routes #1–#13): assemble / list / detail / patch-draft / delete /
  // validate / submit / replace / void / lines / state-history / submissions / acknowledgments.
  registerClaimsRoutes(app, { readService, writeService, assemblyService });

  // Route group B — validation + override (validation-runs read/detail, validate, result override).
  registerValidationRoutes(app, { readService, writeService });
  // Route group C — rule-config (list/detail/create-custom/patch/delete; D5 regulatory-floor protected).
  registerRuleConfigRoutes(app, { readService, writeService });
  // Route group D — NOE / NOTR (list/detail/submit/cancel).
  registerNoeRoutes(app, { readService, writeService });
  registerNotrRoutes(app, { readService, writeService });
  // The Medicare transfer notice (TOB 8xC / corrected 8xC / 8xD; CMS Pub. 100-04 ch. 11 §20.1.3–§20.1.4).
  if (services.transferNoticeService) {
    registerTransferNoticeRoutes(app, { transferNoticeService: services.transferNoticeService });
  }
  // Route group E — eligibility / sequestration-policy / MAC credentials.
  registerEligibilityRoutes(app, { readService, writeService });
  // F-212 — the tenant-entered sequestration policy (absent service => the /billing/sequestration-policies routes are not mounted).
  if (services.sequestrationService) {
    registerSequestrationPolicyRoutes(app, { sequestrationService: services.sequestrationService });
  }
  registerMacCredentialRoutes(app, { readService, writeService });
  // F-210 — the tenant-entered hospice rate table (the per-diem input claim assembly prices from).
  if (services.rateTableService) {
    registerRateTableRoutes(app, { rateTableService: services.rateTableService });
  }
  // F-211 — the tenant-entered CMS wage index (the other pricing input claim assembly needs).
  if (services.wageIndexService) {
    registerWageIndexRoutes(app, { wageIndexService: services.wageIndexService });
  }
  // Route group F — AR dashboard + metrics (read-only) + the system-principal internal seams (M25/M26/M27).
  registerMetricsRoutes(app, { readService });
  registerInternalSeamRoutes(app, internalSeam ? { internalSeam } : {});
}
