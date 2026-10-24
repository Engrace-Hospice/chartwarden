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
import { registerAdrReadinessRoutes } from "./adr-readiness.routes";
import { registerAdrRoutes } from "./adr.routes";
import { registerAppealRoutes } from "./appeals.routes";
import { registerAuditRequestRoutes } from "./audit-request.routes";
import { registerAuditResponseRoutes } from "./audit-response.routes";
import { registerCaseViewRoutes } from "./case-view.routes";
import { registerDenialRoutes } from "./denials.routes";
import type { M25RouteServices } from "./index";
import { registerInternalRoutes } from "./internal.routes";
import { registerLaterTierRoutes } from "./later-tier.routes";
import { registerQicRoutes } from "./qic.routes";
import { registerRemittanceRoutes } from "./remittance.routes";
import { registerReopeningRoutes } from "./reopening.routes";
import { registerSubmissionRoutes } from "./submission.routes";
import { registerTaxonomyRoutes } from "./taxonomy.routes";
import { registerTpeRoutes } from "./tpe.routes";

export { registerAdrRoutes, type AdrRouteDeps } from "./adr.routes";
export { registerAdrReadinessRoutes, type AdrReadinessRouteDeps } from "./adr-readiness.routes";
export { registerReopeningRoutes, type ReopeningRouteDeps } from "./reopening.routes";
export { registerTpeRoutes, type TpeRouteDeps } from "./tpe.routes";
export { registerQicRoutes, type QicRouteDeps } from "./qic.routes";
export { registerRemittanceRoutes, type RemittanceRouteDeps } from "./remittance.routes";
export { registerDenialRoutes, type DenialRouteDeps } from "./denials.routes";
export { registerAppealRoutes, type AppealRouteDeps } from "./appeals.routes";
export { registerTaxonomyRoutes, type TaxonomyRouteDeps } from "./taxonomy.routes";
export { registerInternalRoutes, type InternalRouteDeps } from "./internal.routes";
export { registerSubmissionRoutes, type SubmissionRouteDeps } from "./submission.routes";
export { registerAuditRequestRoutes, type AuditRequestRouteDeps } from "./audit-request.routes";
export { registerAuditResponseRoutes, type AuditResponseRouteDeps } from "./audit-response.routes";
export { registerLaterTierRoutes, type LaterTierRouteDeps } from "./later-tier.routes";
export { registerCaseViewRoutes, type CaseViewRouteDeps } from "./case-view.routes";

/** Mount every M25 §4.1 route plugin over the Drizzle-backed (or in-memory slice) read + write services. */
export function mountM25Routes(app: FastifyInstance, services: M25RouteServices): void {
  const { readService, writeService, ingestService, adrService } = services;
  const { reopeningService, denialRouteService, tpeService, qicService } = services;
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
  if (qicService) registerQicRoutes(app, { qicService });
  if (services.submissionService) {
    registerSubmissionRoutes(app, { submissionService: services.submissionService });
  }
  // Milestone 7a-1: later-tier record-keeping + recorded deadlines, audit request intake, the one case view.
  if (services.laterTierService) {
    registerLaterTierRoutes(app, { laterTierService: services.laterTierService });
    if (services.auditRequestService) {
      registerAuditRequestRoutes(app, {
        auditRequestService: services.auditRequestService,
        laterTierService: services.laterTierService,
      });
      // Milestone 7a-2: the response packet (the audit request service carries the packet operations).
      registerAuditResponseRoutes(app, { auditResponse: services.auditRequestService });
    }
  }
  if (services.caseViewService) {
    registerCaseViewRoutes(app, { caseViewService: services.caseViewService });
  }
  // Milestone 8a-1: advisory documentation readiness (deterministic gaps + a deny-stubbed assistant port).
  if (services.adrReadinessService) {
    registerAdrReadinessRoutes(app, { adrReadinessService: services.adrReadinessService });
  }
}
