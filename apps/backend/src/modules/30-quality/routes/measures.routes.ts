// apps/backend/src/modules/30-quality/routes/measures.routes.ts — M30 (§4.1 R-01..R-05).
//
// The quality-measure surface: list the org's measures with latest values (R-01), the rolling-12mo value
// series + history for one measure (R-02), the reproducibility snapshot behind an emitted value (R-03,
// the D1 invariant — gated on the stricter `quality.measure.audit` key), enqueue a selective recompute
// (R-04 → 202 onto `m30.measure_recompute`), and inspect the pending recompute queue (R-05). Every row is
// aggregate-only (no patient PHI), so the §4.6 `inOrg` scope — already enforced by `requirePermission`
// (org presence) + the org RLS predicate the P2c read/write service runs each method under inside ONE
// `withOrgContext(org, …)` transaction — is the full gate; no patient-scope guard is layered here.
//
// R-04 is the only mutating route and carries `Idempotency-Key` (§4.1.1: keyed on
// `(orgId, scope, priority)`); R-05 and the GET reads are idempotency-exempt. Org/actor binding is ALWAYS
// server-side (request.context, never the body): reads bind the read actor, R-04 the write actor (+ its
// active membership id). Mirrors the M33 routes/bases-metrics.routes.ts + exports.routes.ts shape.
import { requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import type { M30ReadRouteService } from "./read-service";
import type { M30WriteRouteService } from "./write-service";
import {
  EnqueueRecomputeBodySchema,
  MeasureIdParamsSchema,
  MeasureListQuerySchema,
  MeasureValueParamsSchema,
  MeasureValuesQuerySchema,
  parse,
} from "./quality-typebox";

export interface MeasureRouteDeps {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const MEASURE_READ = P("quality.measure.read");
const MEASURE_AUDIT = P("quality.measure.audit");
const MEASURE_RECOMPUTE = P("quality.measure.recompute");
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 quality-measure routes (R-01..R-05). */
export function registerMeasuresRoutes(app: FastifyInstance, deps: MeasureRouteDeps): void {
  const { readService, writeService } = deps;

  // R-01 — list the org's measures with their latest values (filter by domain; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/measures",
    {
      preHandler: [MEASURE_READ],
      config: {
        auditRead: {
          none: "measure catalog + latest computed rate/denominator counts — no patient identity",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(MeasureListQuerySchema, request.query);
      return readService.listMeasures(actor, { domain: q.domain }, q.cursor, q.limit);
    },
  );

  // R-02 — the rolling-12mo value series + history for one measure (aggregate). §4.1.
  app.get(
    "/api/v1/quality/measures/:measureId/values",
    {
      preHandler: [MEASURE_READ],
      config: {
        auditRead: { none: "computed rate + population COUNT per period — no patient identity" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { measureId } = parse(MeasureIdParamsSchema, request.params);
      const q = parse(MeasureValuesQuerySchema, request.query);
      return readService.getMeasureValues(actor, measureId, {
        windowStart: q.windowStart,
        windowEnd: q.windowEnd,
      });
    },
  );

  // R-03 — the reproducibility snapshot behind one emitted value (D1; `quality.measure.audit`). §4.1.
  app.get(
    "/api/v1/quality/measures/:measureId/values/:valueId/snapshot",
    {
      preHandler: [MEASURE_AUDIT],
      config: {
        auditRead: {
          none: "frozen numerator/denominator counts for one computed value — counts only, no member list",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { measureId, valueId } = parse(MeasureValueParamsSchema, request.params);
      return readService.getMeasureValueSnapshot(actor, measureId, valueId);
    },
  );

  // R-04 — enqueue a selective recompute onto `m30.measure_recompute` (202 accepted). Idempotent. §4.1.
  app.post(
    "/api/v1/quality/measures/recompute",
    { preHandler: [MEASURE_RECOMPUTE, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(EnqueueRecomputeBodySchema, request.body);
      const res = await writeService.enqueueRecompute(actor, body);
      return reply.code(202).send(res);
    },
  );

  // R-05 — inspect the pending recompute queue (the jobs R-04 scheduled; not yet completed). §4.1.
  app.get(
    "/api/v1/quality/measures/recompute/queue",
    {
      preHandler: [MEASURE_RECOMPUTE],
      config: {
        auditRead: { none: "recompute job queue state — job ids and status, no clinical payload" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      return readService.listRecomputeQueue(actor);
    },
  );
}
