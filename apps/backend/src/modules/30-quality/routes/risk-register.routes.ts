// apps/backend/src/modules/30-quality/routes/risk-register.routes.ts — M30 (§4.1 R-95..R-96).
//
// The unified risk-register surface: read the cross-source `risk_register_view` materialized view (R-95,
// filter by source/severity; aggregate-only, projected from the four open-risk source tables per D13) and
// force an MV refresh (R-96 → 202 onto `m30.risk_register_refresh`). Both rows are aggregate-only (no
// patient PHI), so the §4.6 `inOrg` scope — already enforced by `requirePermission` (org presence) + the
// org RLS predicate the P2c read/write service runs each method under inside ONE `withOrgContext(org, …)`
// transaction — is the full gate; no patient-scope guard is layered here.
//
// R-96 is EXEMPT from `Idempotency-Key` (§4.1.1: idempotent by materialized-view-refresh semantics — a
// redelivered refresh is a no-op), so no idempotency guard is layered. Org/actor binding is ALWAYS
// server-side (request.context, never the body): R-95 binds the read actor, R-96 the write actor (+ its
// active membership id). Mirrors the M33 routes/bases-metrics.routes.ts shape.
import { requirePermission } from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, writeActorOf } from "./actor";
import { RiskRegisterListQuerySchema, parse } from "./quality-typebox";
import type { M30ReadRouteService } from "./read-service";
import type { M30WriteRouteService } from "./write-service";

export interface RiskRegisterRouteDeps {
  readonly readService: M30ReadRouteService;
  readonly writeService: M30WriteRouteService;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const RISK_READ = P("risk.read");
const RISK_ADMIN = P("risk.admin");

/** Register the §4.1 risk-register routes (R-95..R-96). */
export function registerRiskRegisterRoutes(
  app: FastifyInstance,
  deps: RiskRegisterRouteDeps,
): void {
  const { readService, writeService } = deps;

  // R-95 — the unified risk view (filter by source/severity; cursor-paginated). §4.1.
  app.get(
    "/api/v1/quality/risk-register",
    {
      preHandler: [RISK_READ],
      config: {
        auditRead: { none: "org risk register entries — operational risk, no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(RiskRegisterListQuerySchema, request.query);
      return readService.listRiskRegister(
        actor,
        { source: q.source, severity: q.severity },
        q.cursor,
        q.limit,
      );
    },
  );

  // R-96 — force a `risk_register_view` MV refresh (202 accepted; idempotency-exempt). §4.1.
  app.post(
    "/api/v1/quality/risk-register/refresh",
    { preHandler: [RISK_ADMIN] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const res = await writeService.refreshRiskRegister(actor);
      return reply.code(202).send(res);
    },
  );
}
