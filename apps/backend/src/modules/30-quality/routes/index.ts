// apps/backend/src/modules/30-quality/routes/index.ts — M30 route barrel + mount.
//
// The nine §4.1 route plugins (measures / CAHPS / risk-register / QAPI / SRA / CoP / incidents / mortality /
// infection) + their shared TypeBox schemas, cursor/idempotency helpers, and the request-scoped actor
// resolver. `mountM30Routes` is the single composition-root entry (the M33 `mountM33ReadRoutes` precedent);
// each plugin is also exported so a route test can mount one group over a fresh in-memory backend.
//
// Six plugins take the split `{ readService, writeService }` deps; the QAPI / SRA / CoP plugins take a single
// `{ service }` implementing BOTH halves (M30ReadRouteService & M30WriteRouteService) — `mountM30Routes`
// composes that combined object from the two Drizzle-backed services (no read/write method-name overlap, so
// the spread merge is total). Every route already gates on its §4.6 `requirePermission(key)`; the PHI list/
// detail plugins layer `requirePatientScope()` and the mutating set declares `Idempotency-Key` (§4.1.1).
import type { FastifyInstance } from "fastify";

import { type CahpsExportFileReader, registerCahpsRoutes } from "./cahps.routes";
import { registerCopRoutes } from "./cop.routes";
import { registerIncidentRoutes } from "./incidents.routes";
import { registerInfectionRoutes } from "./infection.routes";
import { registerMeasuresRoutes } from "./measures.routes";
import { type PatientDisplayPort, registerMortalityRoutes } from "./mortality.routes";
import { registerQapiRoutes } from "./qapi.routes";
import type { M30ReadRouteService } from "./read-service";
import { registerRiskRegisterRoutes } from "./risk-register.routes";
import type { PatientScopeResolver } from "./scope-resolver";
import { registerSraRoutes } from "./sra.routes";
import type { M30WriteRouteService } from "./write-service";

export { registerMeasuresRoutes, type MeasureRouteDeps } from "./measures.routes";
export { registerCahpsRoutes, type CahpsRouteDeps } from "./cahps.routes";
export { registerRiskRegisterRoutes, type RiskRegisterRouteDeps } from "./risk-register.routes";
export { registerQapiRoutes, type QapiRouteDeps } from "./qapi.routes";
export { registerSraRoutes, type SraRouteDeps } from "./sra.routes";
export { registerCopRoutes, type CopRouteDeps } from "./cop.routes";
export { registerIncidentRoutes, type IncidentRouteDeps } from "./incidents.routes";
export { registerMortalityRoutes, type MortalityRouteDeps } from "./mortality.routes";
export { registerInfectionRoutes, type InfectionRouteDeps } from "./infection.routes";

export {
  type CursorKeyset,
  type CursorPage,
  encodeCursor,
  decodeCursor,
  paginate,
  pageSizeOf,
  requireIdempotencyKey,
  IdempotencyKeyRequiredError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./concurrency";
export {
  type M30ReadActor,
  type M30WriteActor,
  type PreHandler,
  actorOf,
  isM30SystemActor,
  m30SystemWriteActor,
  writeActorOf,
} from "./actor";

export type { M30ReadRouteService } from "./read-service";
export type { PatientScopeResolver } from "./scope-resolver";
export type { QualityPatientScope } from "./patient-scope";
export type { M30WriteRouteService } from "./write-service";
export {
  type M30ReadServicePorts,
  buildDrizzleM30ReadService,
} from "./read-service-drizzle";
export {
  type M30WriteServicePorts,
  type ProviderEntityPort,
  type WriteTx,
  buildDrizzleM30WriteService,
} from "./write-service-drizzle";

/** The combined READ + WRITE route service the QAPI / SRA / CoP plugins bind (no method-name overlap). */
export type M30CombinedRouteService = M30ReadRouteService & M30WriteRouteService;

/** The split route-service deps `mountM30Routes` mounts the nine §4.1 plugins over. */
export interface M30RouteServices {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
  /** GAP-091 — overrides the PHI patient-scope resolver (default: org-wide roles ⇒ org, else M5 caseload). */
  readonly resolveScope?: PatientScopeResolver;
  /** D19 — M5's display-label port (injected at the composition root); gates on `mortality.read_with_patient`. */
  readonly patientDisplay?: PatientDisplayPort;
  /** GAP-087 — the sealed CAHPS export-file reader behind R-15's `downloadUrl` (needs the tenant-DEK cipher). */
  readonly cahpsExportFile?: CahpsExportFileReader;
}

/**
 * Mount every M30 §4.1 route plugin over the Drizzle-backed (or in-memory slice) read + write services.
 * The composition root calls this when a DB client is present, behind the same authenticate/security/error
 * chain (the M33 `mountM33ReadRoutes` + `mountM33WriteRoutes` precedent). The QAPI / SRA / CoP plugins take a
 * single object implementing both interfaces — composed here by spreading the two services (the read and
 * write surfaces share no method name, so the merge is total and unambiguous).
 */
export function mountM30Routes(app: FastifyInstance, services: M30RouteServices): void {
  const { readService, writeService, resolveScope, patientDisplay, cahpsExportFile } = services;
  const combined: M30CombinedRouteService = { ...readService, ...writeService };

  registerMeasuresRoutes(app, { readService, writeService });
  registerCahpsRoutes(app, { readService, writeService, exportFile: cahpsExportFile });
  registerRiskRegisterRoutes(app, { readService, writeService });
  registerIncidentRoutes(app, { readService, writeService, resolveScope });
  registerMortalityRoutes(app, { readService, writeService, resolveScope, patientDisplay });
  registerInfectionRoutes(app, { readService, writeService, resolveScope });
  registerQapiRoutes(app, { service: combined });
  registerSraRoutes(app, { service: combined });
  registerCopRoutes(app, { service: combined });
}
