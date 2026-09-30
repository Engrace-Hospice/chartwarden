// apps/backend/src/modules/23-billing-medicare/routes/wage-index.routes.ts — M23 (F-211).
//
// The TENANT-ENTERED CMS hospice wage index `POST /claims/assemble` prices from, per CCN + federal fiscal year: create, list /
// get / live-lookup, and SUPERSEDE (append-only correction). Reads gate `billing.wage_index.read`; writes gate
// `billing.wage_index.admin` (a financial input — administrators only; the catalog sync + migration 0280 grant it to
// `administrator`/`org_admin`) plus the §D13 AI-block + `Idempotency-Key`. The value is ORG-SCOPED (it never touches the
// platform-shared `wage_index_factor`), so the permission alone (org-scoped by RLS) is the gate. NO PHI. Org/actor/membership
// binding is ALWAYS server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import type { WageIndexRouteService } from "./wage-index-service";
import {
  CreateWageIndexBodySchema,
  SupersedeWageIndexBodySchema,
  WageIndexEffectiveQuerySchema,
  WageIndexIdParamsSchema,
  WageIndexListQuerySchema,
  assertFactorIsString,
  parse,
} from "./wage-index-typebox";

export interface WageIndexRouteDeps {
  readonly wageIndexService: WageIndexRouteService;
}

const READ = P("billing.wage_index.read");
const ADMIN = P("billing.wage_index.admin");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const AUDIT_READ = {
  auditRead: {
    none: "hospice wage index — public CMS reference data keyed by the tenant, no patient data",
  },
} as const;

export function registerWageIndexRoutes(app: FastifyInstance, deps: WageIndexRouteDeps): void {
  const { wageIndexService } = deps;

  // GET /billing/wage-indexes?ccn=&fiscalYearStarting=&includeSuperseded= — newest fiscal year first.
  app.get(
    "/api/v1/billing/wage-indexes",
    { preHandler: [READ], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(WageIndexListQuerySchema, request.query);
      return {
        wageIndexes: await wageIndexService.listWageIndexes(actor, {
          ...(q.ccn !== undefined ? { ccn: q.ccn } : {}),
          ...(q.fiscalYearStarting !== undefined
            ? { fiscalYearStarting: q.fiscalYearStarting }
            : {}),
          includeSuperseded: q.includeSuperseded === true,
        }),
      };
    },
  );

  // GET /billing/wage-indexes/effective?ccn=&fiscalYearStarting= — the live tenant value (or null).
  app.get(
    "/api/v1/billing/wage-indexes/effective",
    { preHandler: [READ], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(WageIndexEffectiveQuerySchema, request.query);
      return wageIndexService.liveWageIndex(actor, q.ccn, q.fiscalYearStarting);
    },
  );

  // GET /billing/wage-indexes/:id
  app.get(
    "/api/v1/billing/wage-indexes/:id",
    { preHandler: [READ], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(WageIndexIdParamsSchema, request.params);
      return wageIndexService.getWageIndex(actor, id);
    },
  );

  // POST /billing/wage-indexes — enter the wage index for a CCN + fiscal year (201).
  app.post(
    "/api/v1/billing/wage-indexes",
    { preHandler: [ADMIN, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      assertFactorIsString(request.body);
      const body = parse(CreateWageIndexBodySchema, request.body);
      return reply.code(201).send(await wageIndexService.createWageIndex(actor, body));
    },
  );

  // POST /billing/wage-indexes/:id/supersede — replace a live value with a corrected one (201; the old row is kept).
  app.post(
    "/api/v1/billing/wage-indexes/:id/supersede",
    { preHandler: [ADMIN, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(WageIndexIdParamsSchema, request.params);
      assertFactorIsString(request.body);
      const body = parse(SupersedeWageIndexBodySchema, request.body);
      return reply.code(201).send(await wageIndexService.supersedeWageIndex(actor, id, body));
    },
  );
}
