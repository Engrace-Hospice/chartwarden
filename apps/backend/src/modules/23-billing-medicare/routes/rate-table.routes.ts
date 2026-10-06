// apps/backend/src/modules/23-billing-medicare/routes/rate-table.routes.ts — M23 (F-210).
//
// The TENANT-ENTERED hospice per-diem rate table `POST /claims/assemble` prices from: create a rate-table version for a
// fiscal year, list / get / look up the version effective on a date, and SUPERSEDE a version (append-only correction).
// Reads gate `billing.rate_table.read`; writes gate `billing.rate_table.admin` (a financial input — administrators only;
// the catalog sync + migration 0279 grant it to `administrator`/`org_admin`). Both compose the §4.7
// `provider_entity_billing_scope` predicate over the ProviderEntity (query/body — the by-id routes carry it too and the
// service 404s a mismatch) + the §D13 AI-block + `Idempotency-Key` on mutations. NO PHI. Org/actor/membership binding is
// ALWAYS server-side.
import { nationalRateReferenceFor } from "@wardenx/billing";
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, targetProviderFromBody, targetProviderFromQuery } from "./guards";
import type { RateTableRouteService } from "./rate-table-service";
import {
  CreateRateTableBodySchema,
  RateTableEffectiveQuerySchema,
  RateTableGetQuerySchema,
  RateTableIdParamsSchema,
  RateTableListQuerySchema,
  RateTableNationalReferenceQuerySchema,
  type RateTableNationalReferenceResponse,
  SupersedeRateTableBodySchema,
  assertWholeCents,
  parse,
} from "./rate-table-typebox";

export interface RateTableRouteDeps {
  readonly rateTableService: RateTableRouteService;
}

const READ = P("billing.rate_table.read");
const READ_ABAC = PROVIDER_SCOPE("billing.rate_table.read", targetProviderFromQuery);
const ADMIN = P("billing.rate_table.admin");
const ADMIN_ABAC = PROVIDER_SCOPE("billing.rate_table.admin", targetProviderFromBody);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const AUDIT_READ = {
  auditRead: { none: "hospice per-diem rate table — payment policy data, no patient data" },
} as const;

export function registerRateTableRoutes(app: FastifyInstance, deps: RateTableRouteDeps): void {
  const { rateTableService } = deps;

  // GET /billing/rate-tables?providerEntityId=&includeSuperseded= — versions, newest window first.
  app.get(
    "/api/v1/billing/rate-tables",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(RateTableListQuerySchema, request.query);
      return {
        rateTables: await rateTableService.listRateTables(actor, q.providerEntityId, {
          includeSuperseded: q.includeSuperseded === true,
        }),
      };
    },
  );

  // GET /billing/rate-tables/effective?providerEntityId=&onDate= — the live version claim assembly would use (or null).
  app.get(
    "/api/v1/billing/rate-tables/effective",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(RateTableEffectiveQuerySchema, request.query);
      return rateTableService.effectiveRateTable(actor, q.providerEntityId, q.onDate);
    },
  );

  // GET /billing/rate-tables/national-reference?providerEntityId=&fiscalYearStarting= — the CMS NATIONAL base rates
  // for a fiscal year (both HQRP columns, with Federal Register sources), or `reference: null` when none is on file.
  // Platform reference data the entry screen prefills / sanity-checks from (FY2027 workstream E); pricing still
  // reads only the tenant-entered table. Gated like the other reads (the provider scope keeps the gate uniform).
  app.get(
    "/api/v1/billing/rate-tables/national-reference",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request): Promise<RateTableNationalReferenceResponse> => {
      const q = parse(RateTableNationalReferenceQuerySchema, request.query);
      const ref = nationalRateReferenceFor(q.fiscalYearStarting);
      return { reference: ref === null ? null : { ...ref, sources: [...ref.sources] } };
    },
  );

  // GET /billing/rate-tables/:id?providerEntityId=
  app.get(
    "/api/v1/billing/rate-tables/:id",
    { preHandler: [READ, READ_ABAC], config: AUDIT_READ },
    async (request) => {
      const actor = actorOf(request);
      const { id } = parse(RateTableIdParamsSchema, request.params);
      const q = parse(RateTableGetQuerySchema, request.query);
      return rateTableService.getRateTable(actor, q.providerEntityId, id);
    },
  );

  // POST /billing/rate-tables — enter a new rate-table version (201).
  app.post(
    "/api/v1/billing/rate-tables",
    { preHandler: [ADMIN, ADMIN_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      assertWholeCents(request.body);
      const body = parse(CreateRateTableBodySchema, request.body);
      return reply.code(201).send(await rateTableService.createRateTable(actor, body));
    },
  );

  // POST /billing/rate-tables/:id/supersede — replace a live version with a corrected one (201; the old row is kept).
  app.post(
    "/api/v1/billing/rate-tables/:id/supersede",
    { preHandler: [ADMIN, ADMIN_ABAC, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(RateTableIdParamsSchema, request.params);
      assertWholeCents(request.body);
      const body = parse(SupersedeRateTableBodySchema, request.body);
      return reply.code(201).send(await rateTableService.supersedeRateTable(actor, id, body));
    },
  );
}
