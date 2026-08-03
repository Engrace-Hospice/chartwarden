// apps/backend/src/modules/29-external-interfaces/routes/mount.ts — M29 route mount (§4.1/§4.2) + barrel.
//
// The six §4.1/§4.2 route plugin groups: feed + credential admin, ADT proposal review, HL7 message search /
// replay / retry / decrypt, NPPES administration, the read-mostly ops surface, and the clinician lab surface.
// `mountM29Routes` is the single composition-root entry (the M28/M32/M24 mount precedent), mounted behind the
// same authenticate / security / error chain as every other module.
import type { FastifyInstance } from "fastify";

import { registerFeedRoutes } from "./feed.routes";
import { registerLabRoutes } from "./labs.routes";
import { registerMessageRoutes } from "./message.routes";
import { registerNppesRoutes } from "./nppes.routes";
import { registerOpsRoutes } from "./ops.routes";
import { registerProposalRoutes } from "./proposal.routes";
import type { M29Store } from "./store";

export { registerFeedRoutes, type FeedRouteDeps } from "./feed.routes";
export { registerProposalRoutes, type ProposalRouteDeps } from "./proposal.routes";
export { registerMessageRoutes, type MessageRouteDeps } from "./message.routes";
export { registerNppesRoutes, type NppesRouteDeps } from "./nppes.routes";
export { registerOpsRoutes, type OpsRouteDeps } from "./ops.routes";
export { registerLabRoutes, type LabRouteDeps } from "./labs.routes";

/** The service surface every M29 route plugin composes over (bound at the composition root). */
export interface M29RouteServices {
  /** The Drizzle-backed repo (in-memory in tests / db-less boot). */
  readonly store: M29Store;
}

/** Mount every M29 §4.1/§4.2 route plugin over the composed service surface. */
export function mountM29Routes(app: FastifyInstance, services: M29RouteServices): void {
  const { store } = services;
  registerFeedRoutes(app, { store });
  registerProposalRoutes(app, { store });
  registerMessageRoutes(app, { store });
  registerNppesRoutes(app, { store });
  registerOpsRoutes(app, { store });
  registerLabRoutes(app, { store });
}
