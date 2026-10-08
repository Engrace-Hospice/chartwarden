// apps/backend/src/modules/29-external-interfaces/routes/ops.routes.ts — §4.1.5 read-mostly ops surface.
//
// The operator health overview: the per-org feed-health aggregate + the per-feed listener socket status.
// Both are org-scoped reads gated on `external_interfaces.feed.read` (the §4.7 read authority). No PHI —
// segment counts and listener up/down only (the §8.4 PHI-minimization posture: only segment presence and
// byte counts reach ops).
import type { FastifyInstance } from "fastify";

import { actorOf } from "./actor";
import { ABAC_IN_ORG, P } from "./guards";
import type { M29Store } from "./store";
import { FEED_HEALTH_NO_PHI } from "./read-audit-configs";

export interface OpsRouteDeps {
  readonly store: M29Store;
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsRouteDeps): void {
  const { store } = deps;

  // GET /health/aggregate — tenant health overview.
  app.get(
    "/api/admin/external-interfaces/health/aggregate",
    {
      config: { auditRead: FEED_HEALTH_NO_PHI },
      preHandler: [
        P("external_interfaces.feed.read"),
        ABAC_IN_ORG("external_interfaces.feed.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      return { health: await store.feedHealthAggregate(actor.organizationId) };
    },
  );

  // GET /metrics/listener-status — per-feed listener socket status.
  app.get(
    "/api/admin/external-interfaces/metrics/listener-status",
    {
      config: { auditRead: FEED_HEALTH_NO_PHI },
      preHandler: [
        P("external_interfaces.feed.read"),
        ABAC_IN_ORG("external_interfaces.feed.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      return { listeners: await store.listenerStatus(actor.organizationId) };
    },
  );
}
