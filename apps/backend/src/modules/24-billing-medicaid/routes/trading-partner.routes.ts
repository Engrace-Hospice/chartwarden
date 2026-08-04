// apps/backend/src/modules/24-billing-medicaid/routes/trading-partner.routes.ts — M24 (§4.1) the per-PE
// trading-partner credential surface (routes 32–34). The upsert composes the §4.8
// `state_trading_partner_credential_admin` ABAC over the body PE + §D12 step-up; every secret is KMS-wrapped
// (the route returns only masked presence flags, §8.7). Reads/list gate on RBAC + RLS (the per-PE scope is
// enforced by the medicaid trading-partner RLS policy). The sandbox test adapter is deferred (§4.5).
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_BODY_PE, P, STEP_UP } from "./guards";
import { ProviderEntityQuery, UpsertCredentialBody, parse, parseQuery } from "./m24-typebox";
import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

export interface TradingPartnerRouteDeps {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}

const AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerTradingPartnerRoutes(
  app: FastifyInstance,
  deps: TradingPartnerRouteDeps,
): void {
  const { readService, writeService } = deps;

  // 32 — list credentials per PE (secrets masked)
  app.get(
    "/api/v1/state-medicaid-trading-partner-credentials",
    {
      preHandler: [P("medicaid.trading_partner.read")],
      config: {
        auditRead: {
          none: "state trading-partner credential metadata (never the secret) — no patient data",
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await readService.listTradingPartnerCredentials(
          actorOf(request),
          parseQuery(ProviderEntityQuery, request.query).providerEntityId,
        ),
      ),
  );

  // 33 — upsert credentials (step-up)
  app.post(
    "/api/v1/state-medicaid-trading-partner-credentials",
    {
      preHandler: [
        P("medicaid.trading_partner.admin"),
        ABAC_BODY_PE("medicaid.trading_partner.admin", "state_trading_partner_credential_admin"),
        STEP_UP("medicaid.trading_partner.admin"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await writeService.upsertCredential(
            writeActorOf(request),
            parse(UpsertCredentialBody, request.body),
          ),
        ),
  );

  // 34 — round-trip a sandbox test (adapter deferred)
  app.post(
    "/api/v1/state-medicaid-trading-partner-credentials/:id/test",
    { preHandler: [P("medicaid.trading_partner.admin"), AI, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(await writeService.testCredential(writeActorOf(request), pParam(request, "id"))),
  );
}
