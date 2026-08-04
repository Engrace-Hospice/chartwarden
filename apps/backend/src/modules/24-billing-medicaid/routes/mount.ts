// apps/backend/src/modules/24-billing-medicaid/routes/mount.ts — M24 route mount (§4.1) + plugin barrel.
//
// The six §4.1 route plugins (claims/validation/AR · rule-config · eligibility · room-and-board ·
// trading-partner · platform-admin). `mountM24Routes` is the single composition-root entry (the M25/M26
// mount precedent), mounted behind the same authenticate/security/error chain as every other module. Every
// route gates on its §4.7 requirePermission key; the lifecycle mutations compose the §4.8 ABAC + §D12 step-up
// + the §8.6 `actor_kind='ai_*'` reject; every mutating route declares Idempotency-Key (§F08).
import type { FastifyInstance } from "fastify";
import { registerAdminRoutes } from "./admin.routes";
import { registerClaimsRoutes } from "./claims.routes";
import { registerEligibilityRoutes } from "./eligibility.routes";
import type { M24RouteServices } from "./index";
import { registerRbRoutes } from "./rb.routes";
import { registerRuleConfigRoutes } from "./rule-config.routes";
import { registerTradingPartnerRoutes } from "./trading-partner.routes";

export { registerClaimsRoutes, type ClaimsRouteDeps } from "./claims.routes";
export { registerRuleConfigRoutes, type RuleConfigRouteDeps } from "./rule-config.routes";
export { registerEligibilityRoutes, type EligibilityRouteDeps } from "./eligibility.routes";
export { registerRbRoutes, type RbRouteDeps } from "./rb.routes";
export {
  registerTradingPartnerRoutes,
  type TradingPartnerRouteDeps,
} from "./trading-partner.routes";
export { registerAdminRoutes, type AdminRouteDeps } from "./admin.routes";

/** Mount every M24 §4.1 route plugin over the Drizzle-backed (or in-memory) read + write services. */
export function mountM24Routes(app: FastifyInstance, services: M24RouteServices): void {
  const { readService, writeService } = services;
  registerClaimsRoutes(app, { readService, writeService });
  registerRuleConfigRoutes(app, { readService, writeService });
  registerEligibilityRoutes(app, { readService, writeService });
  registerRbRoutes(app, { readService, writeService });
  registerTradingPartnerRoutes(app, { readService, writeService });
  registerAdminRoutes(app, { writeService });
}
