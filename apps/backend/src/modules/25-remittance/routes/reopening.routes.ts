// apps/backend/src/modules/25-remittance/routes/reopening.routes.ts — M25 milestone 3 routes: the MAC reopening
// of a denial and the routing rules that decide a denial is reopened rather than appealed. Reads gate on
// `reopening.read`, case writes on `reopening.manage`, the filing on `reopening.submit` + step-up, and the
// organization's routing rules on `denial_route.manage`. Every change is If-Match (409 when stale) and every
// mutation requires an Idempotency-Key. Org, actor and provider-entity scope are server-derived (actor.ts).
import { Type } from "@sinclair/typebox";
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { REOPENING_FILING_CHANNELS, REOPENING_OUTCOMES } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import type { DenialRouteService } from "./denial-route-service";
import { ASSIGNED_TO_ACTOR, P, STEP_UP } from "./guards";
import { parse } from "./m25-typebox";
import type { ReopeningService } from "./reopening-service";

export interface ReopeningRouteDeps {
  readonly reopeningService: ReopeningService;
  readonly denialRouteService: DenialRouteService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);

export const ReopeningCreateRequestSchema = Type.Object({
  denialCaseId: Type.String({ format: "uuid" }),
  /** The ADR the MAC never got an answer to; supplies the MAC name and is closed as a non-response. */
  adrCaseId: Type.Optional(Type.String({ format: "uuid" })),
  /** Required when no ADR is given. */
  macName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
});

export const ReopeningDueRequestSchema = Type.Object({
  /** The deadline the MAC gave for the request (ISO date-time), or null to clear it. */
  dueAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

export const ReopeningSubmitRequestSchema = Type.Object({
  formName: Type.String({ minLength: 1, maxLength: 200 }),
  channel: Type.Union(REOPENING_FILING_CHANNELS.map((c) => Type.Literal(c))),
  /** The confirmation or tracking reference the MAC (or carrier) gave for the request. */
  confirmationRef: Type.String({ minLength: 1, maxLength: 200 }),
  /** When the request was actually sent (ISO date-time). */
  filedAt: Type.String({ format: "date-time" }),
});

export const ReopeningDecideRequestSchema = Type.Object({
  outcome: Type.Union(REOPENING_OUTCOMES.map((o) => Type.Literal(o))),
});

export const MacReasonCodeRequestSchema = Type.Object({
  /** The MAC's own reason code (for example 56900), or null to clear it. */
  code: Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
});

export const RouteRuleRequestSchema = Type.Object({
  /** Omit for a rule that applies to every MAC. */
  macName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  codeKind: Type.Union([Type.Literal("mac_reason"), Type.Literal("rarc"), Type.Literal("carc")]),
  code: Type.String({ minLength: 1, maxLength: 16 }),
  route: Type.Union([Type.Literal("appeal"), Type.Literal("reopening")]),
  sourceNote: Type.Optional(Type.String({ maxLength: 500 })),
  verifiedOn: Type.Optional(DAY),
  effectiveFrom: Type.Optional(DAY),
});

const ReopeningSummarySchema = Type.Object({
  id: Type.String(),
  claimId: Type.String(),
  denialCaseId: Type.String(),
  adrCaseId: NULLABLE_STRING,
  macName: Type.String(),
  state: Type.String(),
  formName: NULLABLE_STRING,
  filingChannel: NULLABLE_STRING,
  filedAt: NULLABLE_STRING,
  dueAt: NULLABLE_STRING,
  outcome: NULLABLE_STRING,
  decidedAt: NULLABLE_STRING,
  version: Type.Integer(),
});
export const ReopeningPageSchema = Type.Object({ items: Type.Array(ReopeningSummarySchema) });
export const ReopeningListQuerySchema = Type.Object({
  state: Type.Optional(Type.String()),
  /** Only the reopenings of this denial (the denial panel uses it to find the live one). */
  denialCaseId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.String()),
});
export const ReopeningDetailSchema = Type.Composite([
  ReopeningSummarySchema,
  Type.Object({
    filingConfirmationRef: NULLABLE_STRING,
    events: Type.Array(
      Type.Object({ id: Type.String(), eventKind: Type.String(), occurredAt: Type.String() }),
    ),
  }),
]);
export const ReopeningVersionedResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});
export const DenialRouteSchema = Type.Object({
  route: Type.Union([
    Type.Literal("appeal"),
    Type.Literal("reopening"),
    Type.Literal("undetermined"),
  ]),
  unverified: Type.Boolean(),
  rule: Type.Union([
    Type.Object({
      id: Type.String(),
      origin: Type.Union([Type.Literal("org"), Type.Literal("platform")]),
      macName: NULLABLE_STRING,
      codeKind: Type.String(),
      code: Type.String(),
      route: Type.String(),
      verifiedOn: NULLABLE_STRING,
      sourceNote: NULLABLE_STRING,
    }),
    Type.Null(),
  ]),
  macReasonCode: NULLABLE_STRING,
  macName: NULLABLE_STRING,
});
export const RouteRulePageSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      macName: NULLABLE_STRING,
      codeKind: Type.String(),
      code: Type.String(),
      route: Type.String(),
      sourceNote: NULLABLE_STRING,
      verifiedOn: NULLABLE_STRING,
      effectiveFrom: Type.String(),
      version: Type.Integer(),
    }),
  ),
});

const READ = P("reopening.read");
const MANAGE = P("reopening.manage");
const ADR_MANAGE = P("adr.manage");
const SUBMIT = P("reopening.submit");
const SUBMIT_STEPUP = STEP_UP("reopening.submit");
const RULES = P("denial_route.manage");
const DENIAL_READ = P("denial.read");
const DENIAL_READ_ABAC = ASSIGNED_TO_ACTOR("denial.read");
const IDEMPOTENT = requireIdempotencyKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `:id` path param; a non-uuid can never match a row, so it is a 404 rather than a database cast error. */
const idOf = (request: { params?: unknown }, what: string): string => {
  const id = (request.params as { id: string }).id;
  if (!UUID.test(id)) throw new NotFoundError(what);
  return id;
};

export function registerReopeningRoutes(app: FastifyInstance, deps: ReopeningRouteDeps): void {
  const { reopeningService, denialRouteService } = deps;
  const reopeningId = (request: { params?: unknown }) => idOf(request, "reopening case");

  app.get(
    "/api/v1/reopenings",
    { preHandler: [READ], config: { auditRead: { resourceKind: "reopening_case", list: true } } },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const state = typeof q.state === "string" && q.state.length > 0 ? q.state : undefined;
      const denialCaseId =
        typeof q.denialCaseId === "string" && q.denialCaseId.length > 0
          ? q.denialCaseId
          : undefined;
      // A non-uuid can never match a row, so it is an empty list rather than a database cast error.
      if (denialCaseId !== undefined && !UUID.test(denialCaseId)) return reply.send({ items: [] });
      return reply.send(
        await reopeningService.listReopenings(
          actorOf(request),
          { ...(state ? { state } : {}), ...(denialCaseId ? { denialCaseId } : {}) },
          clampLimit(typeof q.limit === "string" ? q.limit : undefined),
        ),
      );
    },
  );

  app.get(
    "/api/v1/reopenings/:id",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "reopening_case", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const found = await reopeningService.getReopening(actorOf(request), reopeningId(request));
      if (!found) throw new NotFoundError("reopening case");
      return reply.send(found);
    },
  );

  // Opening a reopening against an ADR closes that ADR as a non-response, so it also needs the ADR key.
  app.post(
    "/api/v1/reopenings",
    { preHandler: [MANAGE, ADR_MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(ReopeningCreateRequestSchema, request.body);
      return reply
        .code(201)
        .send(await reopeningService.createReopening(writeActorOf(request), body));
    },
  );

  app.put(
    "/api/v1/reopenings/:id/due",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(ReopeningDueRequestSchema, request.body);
      return reply.send(
        await reopeningService.setDue(
          writeActorOf(request),
          reopeningId(request),
          body.dueAt,
          ifMatchVersion(request),
        ),
      );
    },
  );

  // Records a request filed outside WardenX: RBAC + step-up (D15), proof required, frozen once recorded.
  app.post(
    "/api/v1/reopenings/:id/submit",
    { preHandler: [SUBMIT, SUBMIT_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(ReopeningSubmitRequestSchema, request.body);
      return reply.send(
        await reopeningService.submitReopening(
          writeActorOf(request),
          reopeningId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/reopenings/:id/decide",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(ReopeningDecideRequestSchema, request.body);
      return reply.send(
        await reopeningService.decideReopening(
          writeActorOf(request),
          reopeningId(request),
          body.outcome,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/reopenings/:id/withdraw",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await reopeningService.withdrawReopening(
          writeActorOf(request),
          reopeningId(request),
          ifMatchVersion(request),
        ),
      ),
  );

  app.post(
    "/api/v1/reopenings/:id/close",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await reopeningService.closeReopening(
          writeActorOf(request),
          reopeningId(request),
          ifMatchVersion(request),
        ),
      ),
  );

  // Which path this denial takes (computed from the routing rules, never stored).
  app.get(
    "/api/v1/denials/:id/route",
    {
      preHandler: [DENIAL_READ, DENIAL_READ_ABAC],
      config: { auditRead: { resourceKind: "denial_case", resourceIdParam: "id" } },
    },
    async (request, reply) =>
      reply.send(await denialRouteService.getRoute(actorOf(request), idOf(request, "denial case"))),
  );

  // The MAC's own reason code (for example 56900), entered until an 835 mapping is confirmed.
  app.put(
    "/api/v1/denials/:id/mac-reason-code",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(MacReasonCodeRequestSchema, request.body);
      return reply.send(
        await denialRouteService.setMacReasonCode(
          writeActorOf(request),
          idOf(request, "denial case"),
          body.code,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.get("/api/v1/denial-route-rules", { preHandler: [READ] }, async (request, reply) =>
    reply.send(await denialRouteService.listRules(actorOf(request))),
  );

  app.put(
    "/api/v1/denial-route-rules",
    { preHandler: [RULES, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(RouteRuleRequestSchema, request.body);
      return reply.send(await denialRouteService.upsertRule(writeActorOf(request), body));
    },
  );
}
