// apps/backend/src/modules/27-cost-report/routes/mount.ts — M27 route mount (§4.1) + plugin barrel.
//
// The eleven §4.1 route plugins (cost-reports / worksheets / cost-center-mappings / bad-debt / statistics /
// imports / validations / submissions / snapshots / compliance / validation-rules). `mountM27Routes` is the
// single composition-root entry (the M30 `mountM30Routes` precedent), mounted behind the same
// authenticate/security/error chain as every other module's routes; each plugin is also re-exported so a
// route test can mount one group over a fresh in-memory backend.
//
// Every plugin takes the split `{ readService, writeService }` deps from {@link M27RouteServices} (the M27
// read + write surfaces share no method name); the snapshot plugin needs only `readService`. This file
// touches no SHARED composition file — the composition root imports `mountM27Routes` from here and binds the
// two Drizzle-backed services. Every route already gates on its §4.6 `requirePermission` key; the edit /
// approval / submit / reopen / override set composes the §4.7 ABAC chain + the §D14 step-up assertion, and
// every mutating route declares `Idempotency-Key` (§4.1).
import type { FastifyInstance } from "fastify";

import { registerBadDebtRoutes } from "./bad-debt.routes";
import { registerComplianceRoutes } from "./compliance.routes";
import { registerCostCenterMappingRoutes } from "./cost-center-mappings.routes";
import { registerCostReportRoutes } from "./cost-reports.routes";
import { registerImportRoutes } from "./imports.routes";
import { registerSnapshotRoutes } from "./snapshots.routes";
import { registerStatisticsRoutes } from "./statistics.routes";
import { registerSubmissionRoutes } from "./submissions.routes";
import { registerValidationRoutes } from "./validations.routes";
import { registerValidationRuleRoutes } from "./validation-rules.routes";
import { registerWorksheetRoutes } from "./worksheets.routes";
import type { M27RouteServices } from "./index";

export { registerCostReportRoutes, type CostReportRouteDeps } from "./cost-reports.routes";
export { registerWorksheetRoutes, type WorksheetRouteDeps } from "./worksheets.routes";
export {
  registerCostCenterMappingRoutes,
  type CostCenterMappingRouteDeps,
} from "./cost-center-mappings.routes";
export { registerBadDebtRoutes, type BadDebtRouteDeps } from "./bad-debt.routes";
export { registerStatisticsRoutes, type StatisticsRouteDeps } from "./statistics.routes";
export { registerImportRoutes, type ImportRouteDeps } from "./imports.routes";
export { registerValidationRoutes, type ValidationRouteDeps } from "./validations.routes";
export { registerSubmissionRoutes, type SubmissionRouteDeps } from "./submissions.routes";
export { registerSnapshotRoutes, type SnapshotRouteDeps } from "./snapshots.routes";
export { registerComplianceRoutes, type ComplianceRouteDeps } from "./compliance.routes";
export {
  registerValidationRuleRoutes,
  type ValidationRuleRouteDeps,
} from "./validation-rules.routes";

/**
 * Mount every M27 §4.1 route plugin over the Drizzle-backed (or in-memory slice) read + write services.
 * The composition root calls this when a DB client is present, behind the same authenticate/security/error
 * chain as the other modules (the `mountM30Routes` precedent). No read/write method-name overlap, so each
 * plugin binds the two services directly.
 */
export function mountM27Routes(app: FastifyInstance, services: M27RouteServices): void {
  const { readService, writeService } = services;

  registerCostReportRoutes(app, { readService, writeService });
  registerWorksheetRoutes(app, { readService, writeService });
  registerCostCenterMappingRoutes(app, { readService, writeService });
  registerBadDebtRoutes(app, { readService, writeService });
  registerStatisticsRoutes(app, { readService, writeService });
  registerImportRoutes(app, { readService, writeService });
  registerValidationRoutes(app, { readService, writeService });
  registerSubmissionRoutes(app, { readService, writeService });
  registerSnapshotRoutes(app, { readService });
  registerComplianceRoutes(app, { readService, writeService });
  registerValidationRuleRoutes(app, { readService, writeService });
}
