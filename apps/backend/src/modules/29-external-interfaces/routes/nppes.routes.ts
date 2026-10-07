// apps/backend/src/modules/29-external-interfaces/routes/nppes.routes.ts — §4.1.4 NPPES administration.
//
// The NPPES cache is platform-shared public-directory data (no PHI). A tenant may READ a cached provider or
// the sync-run history; the manual sync TRIGGER is platform-only (`nppes_platform_job_caller`, W-XI-12) — a
// tenant-scoped session carries no platform-operator fact, so the predicate denies with a 403.
//
// GAP-045 — the trigger is now REAL. It enqueues onto the same `nppes-sync-platform` queue the D11 nightly
// repeatable fires, so the manual and cron paths run one engine (nppes/cron-workers.ts). The route never
// runs the sync inline: an NPPES walk is thousands of rate-limited CMS requests and would hold the HTTP
// connection open for the whole run. It answers 202 with the `syncRunId` the worker will open the
// `nppes_sync_run` row under, which is what `GET /nppes/sync-runs` then surfaces.
//
// UNBOUND (no queue connection — a db-only or REDIS-less boot) still fails closed, but as a 503
// `NPPES_SYNC_QUEUE_UNBOUND` rather than the old blanket 501: "this deployment has no worker" is an
// operational fact an operator can fix, where 501 said "this feature does not exist".
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, ABAC_NPPES_PLATFORM, P, STEP_UP } from "./guards";
import { NppesSyncRunListQuery, NppesSyncTriggerBody, parse, parseQuery } from "./m29-typebox";
import { type M29Store, M29StoreError } from "./store";

/** The §4.1.4 manual-trigger port (nppes/cron-workers.ts `NppesManualSyncTrigger`), restated locally so
 *  the route layer takes no import edge on bullmq. */
export interface NppesSyncTriggerPort {
  enqueue(input: {
    readonly kind: "daily_incremental" | "weekly_dissemination" | "monthly_deactivation" | "manual";
    readonly triggeredByMembershipId: string;
  }): Promise<{ readonly syncRunId: string; readonly jobId: string }>;
}

export interface NppesRouteDeps {
  readonly store: M29Store;
  /** Absent when the deployment has no queue connection — the trigger then 503s (see the header note). */
  readonly syncTrigger?: NppesSyncTriggerPort;
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
      if (!provider) throw new NotFoundError("NPI cache entry");
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
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(NppesSyncTriggerBody, request.body);
      if (!deps.syncTrigger) {
        // 503, not 501: the capability exists and is wired — THIS process has no queue connection.
        throw new M29StoreError(
          "the NPPES sync worker is not available on this deployment (no queue connection) — the nightly D11 run and the manual trigger both need REDIS_URL",
          503,
        );
      }
      const queued = await deps.syncTrigger.enqueue({
        // A manual run is `manual` unless the operator explicitly asks for one of the scheduled kinds
        // (a forced re-run of the weekly dissemination or the monthly deactivation pass).
        kind: body.kind ?? "manual",
        triggeredByMembershipId: actor.membershipId,
      });
      return reply.code(202).send({
        syncRunId: queued.syncRunId,
        jobId: queued.jobId,
        status: "queued",
      });
    },
  );
}
