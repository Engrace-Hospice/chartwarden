// apps/backend/src/modules/25-remittance/routes/mount.ts — M25 route mount (§4.1) + plugin barrel.
//
// The five §4.1 route plugins (remittance / denials / appeals / taxonomy / internal). `mountM25Routes` is
// the single composition-root entry (the M27 `mountM27Routes` precedent), mounted behind the same
// authenticate/security/error chain as every other module's routes; each plugin is also re-exported so a
// route test can mount one group over a fresh in-memory backend. Every route already gates on its §4.6
// `requirePermission` key; the manual-match / denial-detail compose the §4.7 ABAC chain, the override /
// close-write-off / appeal-submit compose the §D15 step-up, and every mutating route declares
// `Idempotency-Key` (§F05).
import type { FastifyInstance } from "fastify";
import { registerAdrRoutes } from "./adr.routes";
import { registerAppealRoutes } from "./appeals.routes";
import { registerDenialRoutes } from "./denials.routes";
import type { M25RouteServices } from "./index";
import { registerInternalRoutes } from "./internal.routes";
import { registerRemittanceRoutes } from "./remittance.routes";
import { registerReopeningRoutes } from "./reopening.routes";
import { registerTaxonomyRoutes } from "./taxonomy.routes";
import { registerTpeRoutes } from "./tpe.routes";

export { registerAdrRoutes, type AdrRouteDeps } from "./adr.routes";
export { registerReopeningRoutes, type ReopeningRouteDeps } from "./reopening.routes";
export { registerTpeRoutes, type TpeRouteDeps } from "./tpe.routes";
export { registerRemittanceRoutes, type RemittanceRouteDeps } from "./remittance.routes";
export { registerDenialRoutes, type DenialRouteDeps } from "./denials.routes";
export { registerAppealRoutes, type AppealRouteDeps } from "./appeals.routes";
export { registerTaxonomyRoutes, type TaxonomyRouteDeps } from "./taxonomy.routes";
export { registerInternalRoutes, type InternalRouteDeps } from "./internal.routes";

/** Mount every M25 §4.1 route plugin over the Drizzle-backed (or in-memory slice) read + write services. */
export function mountM25Routes(app: FastifyInstance, services: M25RouteServices): void {
  const { readService, writeService, ingestService, adrService } = services;
  const { reopeningService, denialRouteService, tpeService } = services;
  registerRemittanceRoutes(app, { readService, writeService });
  registerDenialRoutes(app, { readService, writeService });
  registerAppealRoutes(app, { readService, writeService });
  registerTaxonomyRoutes(app, { readService, writeService });
  registerInternalRoutes(app, { readService, ingestService });
  if (adrService) registerAdrRoutes(app, { adrService });
  if (reopeningService && denialRouteService) {
    registerReopeningRoutes(app, { reopeningService, denialRouteService });
  }
  if (tpeService) registerTpeRoutes(app, { tpeService });
}
