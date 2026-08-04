// apps/backend/src/modules/29-external-interfaces/routes/nppes.routes.ts — §4.1.4 NPPES administration.
//
// The NPPES cache is platform-shared public-directory data (no PHI). A tenant may READ a cached provider or
// the sync-run history; the manual sync TRIGGER is platform-only (`nppes_platform_job_caller`, W-XI-12) — a
// tenant-scoped session carries no platform-operator fact, so the predicate denies with a 403. Even the
// platform path fails closed here (the real sync runs under the platform scheduler, T07) with a typed 501.
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_NPPES_PLATFORM, P, STEP_UP } from "./guards";
import { NppesSyncRunListQuery, NppesSyncTriggerBody, parse, parseQuery } from "./m29-typebox";
import { type M29Store, M29StoreError } from "./store";

export interface NppesRouteDeps {
  readonly store: M29Store;
}

export function registerNppesRoutes(app: FastifyInstance, deps: NppesRouteDeps): void {
  const { store } = deps;

  // GET /nppes/providers/:npi — read one platform-shared NPPES row (public directory, no PHI).
  app.get(
    "/api/admin/external-interfaces/nppes/providers/:npi",
    {
      preHandler: [
        P("external_interfaces.nppes.read"),
        ABAC_IN_ORG("external_interfaces.nppes.read"),
      ],
    },
    async (request, reply) => {
      actorOf(request);
      const { npi } = request.params as { npi: string };
      const provider = await store.getNppesProvider(npi);
      if (!provider) return reply.code(404).send({ code: "NOT_FOUND", message: "NPI not cached" });
      return { provider };
    },
  );

  // GET /nppes/sync-runs — list sync-run history.
  app.get(
    "/api/admin/external-interfaces/nppes/sync-runs",
    {
      preHandler: [
        P("external_interfaces.nppes.read"),
        ABAC_IN_ORG("external_interfaces.nppes.read"),
      ],
    },
    async (request) => {
      actorOf(request);
      const q = parseQuery(NppesSyncRunListQuery, request.query);
      return store.listSyncRuns({ limit: q.limit, cursor: q.cursor });
    },
  );

  // POST /nppes/sync-runs — trigger a manual sync (platform-only, W-XI-12; step-up D18).
  app.post(
    "/api/admin/external-interfaces/nppes/sync-runs",
    {
      preHandler: [
        P("external_interfaces.nppes.sync_trigger"),
        STEP_UP("external_interfaces.nppes.sync_trigger"),
        ABAC_NPPES_PLATFORM("external_interfaces.nppes.sync_trigger"),
      ],
    },
    async (request) => {
      writeActorOf(request);
      parse(NppesSyncTriggerBody, request.body);
      throw new M29StoreError(
        "the NPPES sync job runs under the platform scheduler (withPlatformContext); no tenant-triggered path in Phase 1 (W-XI-12)",
      );
    },
  );
}
