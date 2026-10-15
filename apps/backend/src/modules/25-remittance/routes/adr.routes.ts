// apps/backend/src/modules/25-remittance/routes/adr.routes.ts — M25 ADR routes (hospice ADR/TPE/QIC PRD
// milestone 2a): the ADR worklist and detail, log an ADR, move it through assembly / review / closure, and the
// organization's MAC response-window rules. Reads gate on `adr.read`, case writes on `adr.manage`, rule edits
// on `mac_rule.manage`. PATCH-style transitions are optimistic-concurrency (If-Match -> 409 when stale); every
// mutation requires an Idempotency-Key. Org, actor and provider-entity scope are server-derived (actor.ts).
// There is no submit route in 2a: filing waits for the reviewed packet and proof of submission (2b).
import { Type } from "@sinclair/typebox";
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import type { AdrManualTarget, AdrService } from "./adr-service";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import { parse } from "./m25-typebox";

export interface AdrRouteDeps {
  readonly adrService: AdrService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const REVIEW_TYPE = Type.Union([Type.Literal("adr"), Type.Literal("re_adr")]);

export const AdrCreateRequestSchema = Type.Object({
  claimId: Type.String({ format: "uuid" }),
  macName: Type.String({ minLength: 1, maxLength: 120 }),
  reviewType: REVIEW_TYPE,
  /** The date on the ADR letter that the MAC's rule anchors the response window on (YYYY-MM-DD). */
  requestedOn: DAY,
  adrReference: Type.Optional(Type.String({ maxLength: 120 })),
  denialCaseId: Type.Optional(Type.String({ format: "uuid" })),
});

export const AdrTransitionRequestSchema = Type.Object({
  to: Type.Union([
    Type.Literal("in_assembly"),
    Type.Literal("in_review"),
    Type.Literal("denied_no_response"),
    Type.Literal("withdrawn"),
  ]),
});

export const MacRuleRequestSchema = Type.Object({
  macName: Type.String({ minLength: 1, maxLength: 120 }),
  reviewType: REVIEW_TYPE,
  responseDays: Type.Integer({ minimum: 1, maximum: 365 }),
  sourceNote: Type.Optional(Type.String({ maxLength: 500 })),
  verifiedOn: Type.Optional(DAY),
  effectiveFrom: Type.Optional(DAY),
});

const AdrSummarySchema = Type.Object({
  id: Type.String(),
  claimId: Type.String(),
  denialCaseId: Type.Union([Type.String(), Type.Null()]),
  macName: Type.String(),
  reviewType: Type.String(),
  state: Type.String(),
  adrReference: Type.Union([Type.String(), Type.Null()]),
  requestedOn: Type.String(),
  windowDays: Type.Integer(),
  windowSource: Type.String(),
  windowVerified: Type.Boolean(),
  responseDueAt: Type.String(),
  dueDay: Type.String(),
  version: Type.Integer(),
});
export const AdrPageSchema = Type.Object({ items: Type.Array(AdrSummarySchema) });
export const AdrDetailSchema = Type.Composite([
  AdrSummarySchema,
  Type.Object({
    calendarDueDay: Type.String(),
    events: Type.Array(
      Type.Object({ id: Type.String(), eventKind: Type.String(), occurredAt: Type.String() }),
    ),
  }),
]);
export const AdrVersionedResultSchema = Type.Object({ id: Type.String(), version: Type.Integer() });
export const MacRulePageSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      macName: Type.String(),
      reviewType: Type.String(),
      responseDays: Type.Integer(),
      sourceNote: Type.Union([Type.String(), Type.Null()]),
      verifiedOn: Type.Union([Type.String(), Type.Null()]),
      effectiveFrom: Type.String(),
      version: Type.Integer(),
    }),
  ),
});

const READ = P("adr.read");
const MANAGE = P("adr.manage");
const RULES = P("mac_rule.manage");
const IDEMPOTENT = requireIdempotencyKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The `:id` path param; a non-uuid can never match a row, so it is a 404 rather than a database cast error. */
const idOf = (request: { params?: unknown }): string => {
  const id = (request.params as { id: string }).id;
  if (!UUID.test(id)) throw new NotFoundError("ADR case not found");
  return id;
};

export function registerAdrRoutes(app: FastifyInstance, deps: AdrRouteDeps): void {
  const { adrService } = deps;

  app.get(
    "/api/v1/adrs",
    { preHandler: [READ], config: { auditRead: { resourceKind: "adr_case", list: true } } },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const state = typeof q.state === "string" && q.state.length > 0 ? q.state : undefined;
      return reply.send(
        await adrService.listAdrs(
          actorOf(request),
          state ? { state } : {},
          clampLimit(typeof q.limit === "string" ? q.limit : undefined),
        ),
      );
    },
  );

  app.get(
    "/api/v1/adrs/:id",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "adr_case", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const adr = await adrService.getAdr(actorOf(request), idOf(request));
      if (!adr) throw new NotFoundError("ADR case not found");
      return reply.send(adr);
    },
  );

  app.post("/api/v1/adrs", { preHandler: [MANAGE, IDEMPOTENT] }, async (request, reply) => {
    const body = parse(AdrCreateRequestSchema, request.body);
    const created = await adrService.createAdr(writeActorOf(request), body);
    return reply.code(201).send(created);
  });

  app.post(
    "/api/v1/adrs/:id/transition",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AdrTransitionRequestSchema, request.body);
      return reply.send(
        await adrService.transitionAdr(
          writeActorOf(request),
          idOf(request),
          body.to as AdrManualTarget,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.get("/api/v1/mac-rules", { preHandler: [READ] }, async (request, reply) =>
    reply.send(await adrService.listMacRules(actorOf(request))),
  );

  app.put("/api/v1/mac-rules", { preHandler: [RULES, IDEMPOTENT] }, async (request, reply) => {
    const body = parse(MacRuleRequestSchema, request.body);
    return reply.send(await adrService.upsertMacRule(writeActorOf(request), body));
  });
}
