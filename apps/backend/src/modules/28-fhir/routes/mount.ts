// apps/backend/src/modules/28-fhir/routes/mount.ts — M28 route mount (§4.1) + plugin barrel.
//
// The five §4.1 route plugin groups: the FHIR-spec bearer surface (R1-R22), the client registry admin
// (R23-R30), the bulk-export admin (R31-R33), the inbound-proposal review (R34-R36), and the tenant config
// (R37-R39). `mountM28Routes` is the single composition-root entry (the M32/M15/M20/M24/M26 mount
// precedent), mounted behind the same authenticate / security / error chain as every other module — the
// FHIR-spec routes simply resolve their own bearer instead of composing the M3 permission preHandlers.
import type { FastifyInstance } from "fastify";

import { registerAdminClientRoutes } from "./admin-clients.routes";
import { registerAdminConfigRoutes } from "./admin-config.routes";
import { registerAdminExportRoutes } from "./admin-export.routes";
import { registerAdminInboundRoutes } from "./admin-inbound.routes";
import { type FhirDisclosureAuditPort, registerFhirR4Routes } from "./fhir-r4.routes";
import type { FhirGatewayStore } from "./store";

export { registerAdminClientRoutes, type AdminClientsRouteDeps } from "./admin-clients.routes";
export { registerAdminConfigRoutes, type AdminConfigRouteDeps } from "./admin-config.routes";
export { registerAdminExportRoutes, type AdminExportRouteDeps } from "./admin-export.routes";
export { registerAdminInboundRoutes, type AdminInboundRouteDeps } from "./admin-inbound.routes";
export {
  registerFhirR4Routes,
  type FhirR4RouteDeps,
  type FhirDisclosureAuditPort,
} from "./fhir-r4.routes";

/** The service surface every M28 route plugin composes over (bound at the composition root). */
export interface M28RouteServices {
  /** The Drizzle-backed repo (in-memory in tests / db-less boot). */
  readonly store: FhirGatewayStore;
  /** The D15 disclosure-audit sink for served FHIR reads; absent ⇒ reads are not persisted. */
  readonly audit?: FhirDisclosureAuditPort;
  /** Injectable clock — the §7 tests pin served-at timestamps. */
  readonly now?: () => string;
}

/** Mount every M28 §4.1 route plugin over the composed service surface. */
export function mountM28Routes(app: FastifyInstance, services: M28RouteServices): void {
  const { store, audit, now } = services;
  registerFhirR4Routes(app, { store, audit, now });
  registerAdminClientRoutes(app, { store });
  registerAdminExportRoutes(app, { store });
  registerAdminInboundRoutes(app, { store });
  registerAdminConfigRoutes(app, { store });
}
