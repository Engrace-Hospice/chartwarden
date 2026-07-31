// apps/backend/src/modules/21-supplies/routes/operations.routes.ts — M21 (§4.1) rows 28–35: the agency
// OPERATIONS surface — the D4 vendor-routing ladder and the D5 par-stock shelf.
//
// NO PATIENT APPEARS ON THIS SURFACE. A routing rule is org+Location config and a par row is agency
// inventory at a Location (§3.1.6 is explicit that `M21ParThresholdPayload` carries no `patientId` at
// all), so these reads carry an explicit read-audit WAIVER rather than an emission — decided, not
// forgotten. They are `admin` category in the §4.3 catalog for the same reason.
//
// TWO THINGS THAT LOOK LIKE DELETES AND ARE NOT:
//
//   • `DELETE /vendor-routing-rules/:ruleId` RETIRES the rule (`is_active = false`, `effective_to = now`).
//     Every historical `supply_request.routing_rule_resolved_jsonb` names this rule id, and a survey asking
//     "which rule sent this bed to Apria" must still resolve it. A real DELETE would break the one record
//     D4 exists to preserve. The verb stays `DELETE` because §4.1's table says so.
//   • A par-stock OBSERVATION sets the shelf; it does not adjust it. A hub worker counting a shelf knows
//     what is on it, not what changed since the last count, and an adjustment-shaped API drifts from the
//     shelf every time a count is missed. The delta is derived and run through the pure §2.7 rule, so a
//     count that would drive the shelf negative is the typed refusal rather than a silent clamp.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchStamp, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import {
  ListParStockQuery,
  ListRoutingRulesQuery,
  ObserveParStockBody,
  ParStockIdParams,
  RuleIdParams,
  UpdateParStockBody,
  UpsertRoutingRuleBody,
  parse,
  parseQuery,
} from "./m21-typebox";
import type { M21ReadService } from "./read-service";
import type { M21WriteService } from "./write-service";

export interface OperationsRouteDeps {
  readonly readService: M21ReadService;
  readonly writeService: M21WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** M4 §2.5 — an explicit, justified waiver: agency operations data, no patient is identifiable. */
const NO_PHI = {
  auditRead: {
    none: "vendor-routing config / hub inventory — org+Location scoped, no patient is identifiable",
  },
} as const;

export function registerSupplyOperationsRoutes(
  app: FastifyInstance,
  deps: OperationsRouteDeps,
): void {
  const { readService, writeService } = deps;

  // 28 — the D4 ladder, most-specific first. The platform-scope rows come back for every tenant via the
  //      table's own floor-plus-overlay RLS policy; this handler asks for no such thing.
  app.get(
    "/api/v1/supplies/vendor-routing-rules",
    { preHandler: [P("vendor_routing.read"), NO_OFFSET], config: NO_PHI },
    async (request) =>
      readService.listVendorRoutingRules(
        actorOf(request),
        parseQuery(ListRoutingRulesQuery, request.query),
      ),
  );

  // 29 — author a rule. `platform` scope is absent from the TypeBox union by design: a tenant may never
  //      author a platform-scope rule, and the RLS write policy would refuse it anyway (two gates).
  app.post(
    "/api/v1/supplies/vendor-routing-rules",
    { preHandler: [P("vendor_routing.write"), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(UpsertRoutingRuleBody, request.body);
      const created = await writeService.createVendorRoutingRule(writeActorOf(request), body);
      return reply.code(201).send(created);
    },
  );

  // 30 — edit a rule.
  app.put(
    "/api/v1/supplies/vendor-routing-rules/:ruleId",
    { preHandler: [P("vendor_routing.write"), IDEMPOTENT] },
    async (request) => {
      const { ruleId } = parse(RuleIdParams, request.params);
      const body = parse(UpsertRoutingRuleBody, request.body);
      return writeService.updateVendorRoutingRule(writeActorOf(request), ruleId, body);
    },
  );

  // 31 — retire a rule (see the module header: this is not a delete).
  app.delete(
    "/api/v1/supplies/vendor-routing-rules/:ruleId",
    { preHandler: [P("vendor_routing.write"), IDEMPOTENT] },
    async (request) => {
      const { ruleId } = parse(RuleIdParams, request.params);
      return writeService.retireVendorRoutingRule(writeActorOf(request), ruleId);
    },
  );

  // 32 — the hub shelf. `severity` is DERIVED per row (`ok` / `below_threshold` / `critical_low` /
  //      `depleted`), never stored: a stored severity goes stale the moment a threshold is edited, and the
  //      screen reading it would show a green shelf that is actually empty.
  app.get(
    "/api/v1/supplies/par-stock",
    { preHandler: [P("par_stock.read"), NO_OFFSET], config: NO_PHI },
    async (request) =>
      readService.listParStock(actorOf(request), parseQuery(ListParStockQuery, request.query)),
  );

  // 33 — edit the thresholds. `assertParThresholdsOrdered` mirrors the §3.1.6 CHECK at the boundary, so an
  //      inverted pair is a field-anchored 422 instead of a 500 out of PostgreSQL.
  app.put(
    "/api/v1/supplies/par-stock/:parStockId",
    { preHandler: [P("par_stock.write"), IDEMPOTENT] },
    async (request) => {
      const { parStockId } = parse(ParStockIdParams, request.params);
      const body = parse(UpdateParStockBody, request.body);
      return writeService.updateParStock(writeActorOf(request), parStockId, {
        expectedUpdatedAt: ifMatchStamp(request, true),
        ...body,
      });
    },
  );

  // 34 — record an on-hand count (see the module header for why this SETS rather than adjusts). The
  //      nightly §4.6 cron — not this route — is the canonical emitter of `m21.par.below_threshold`, so a
  //      busy Location raises one alert a night rather than one per count.
  app.post(
    "/api/v1/supplies/par-stock/observe",
    { preHandler: [P("par_stock.observe"), IDEMPOTENT] },
    async (request) => {
      const body = parse(ObserveParStockBody, request.body);
      return writeService.recordObservation(writeActorOf(request), body);
    },
  );
}
