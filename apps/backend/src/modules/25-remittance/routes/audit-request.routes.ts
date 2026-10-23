import { NotFoundError } from "@chartwarden/types";
// apps/backend/src/modules/25-remittance/routes/audit-request.routes.ts - M25 milestone 7a-1 routes: RAC / UPIC / SMRC
// (or other) audit request intake. Reads gate on `audit_request.read`, writes on `audit_request.manage`. Every
// request-level change is If-Match (409 when stale) and every mutation requires an Idempotency-Key. The due date is a
// recorded deadline (registered here under /audit-requests/:id/recorded-deadlines), never a column or a default.
// Org, actor and provider-entity scope are server-derived (actor.ts). Nothing is sent from here (milestone 7a-2).
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { AUDIT_AUTHORITY_KINDS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import type { AuditRequestService } from "./audit-request-service";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import type { LaterTierService } from "./later-tier-service";
import type { DeadlineSubject } from "./later-tier-service";
import {
  RecordedDeadlinePatchSchema,
  RecordedDeadlineRequestSchema,
  RecordedDeadlineSatisfyRequestSchema,
  RecordedDeadlineViewSchema,
  uuidParam,
} from "./later-tier.routes";
import { parse } from "./m25-typebox";

export interface AuditRequestRouteDeps {
  readonly auditRequestService: AuditRequestService;
  /** Recorded deadlines live in the later-tier service; the audit routes mount only with it. */
  readonly laterTierService: LaterTierService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const OPT_TEXT = (max: number) =>
  Type.Optional(Type.Union([Type.String({ maxLength: max }), Type.Null()]));
const IDEMPOTENT = requireIdempotencyKey();
const READ = P("audit_request.read");
const MANAGE = P("audit_request.manage");

export const AuditCreateRequestSchema = Type.Object({
  /** A label only (RAC, UPIC, SMRC or other): it implies no window, channel or rule. */
  authorityKind: Type.Union(AUDIT_AUTHORITY_KINDS.map((k) => Type.Literal(k))),
  /** Required when the kind is 'other'. */
  authorityName: OPT_TEXT(200),
  requestReference: OPT_TEXT(200),
  requestDatedOn: Type.Optional(Type.Union([DAY, Type.Null()])),
  receivedOn: DAY,
  scopeNote: OPT_TEXT(1000),
  /** Required only when no claim is given. */
  providerEntityId: Type.Optional(Type.String({ format: "uuid" })),
  claimIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { maxItems: 200 })),
  adrCaseId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  denialCaseId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
});

export const AuditPatchRequestSchema = Type.Object({
  authorityName: OPT_TEXT(200),
  requestReference: OPT_TEXT(200),
  requestDatedOn: Type.Optional(Type.Union([DAY, Type.Null()])),
  scopeNote: OPT_TEXT(1000),
  adrCaseId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  denialCaseId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
});

export const AuditClaimRequestSchema = Type.Object({
  claimId: Type.String({ format: "uuid" }),
  dateOfServiceNote: OPT_TEXT(200),
});

export const AuditMoveRequestSchema = Type.Object({
  to: Type.Union([
    Type.Literal("in_assembly"),
    Type.Literal("in_review"),
    Type.Literal("responded"),
    Type.Literal("closed"),
    Type.Literal("withdrawn"),
  ]),
  /** When the response was actually sent (ISO date-time); defaults to now. Only for 'responded'. */
  respondedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const AuditListQuerySchema = Type.Object({
  state: Type.Optional(Type.String()),
  limit: Type.Optional(Type.String()),
});

const AuditSummarySchema = Type.Object({
  id: Type.String(),
  authorityKind: Type.String(),
  authorityName: NULLABLE_STRING,
  requestReference: NULLABLE_STRING,
  receivedOn: Type.String(),
  state: Type.String(),
  claimCount: Type.Integer(),
  dueState: Type.Union([
    Type.Literal("no_deadline_recorded"),
    Type.Literal("open"),
    Type.Literal("past"),
    Type.Literal("not_applicable"),
  ]),
  nextDueAt: NULLABLE_STRING,
  version: Type.Integer(),
  createdAt: Type.String(),
});
export const AuditPageSchema = Type.Object({ items: Type.Array(AuditSummarySchema) });

export const AuditDetailSchema = Type.Composite([
  AuditSummarySchema,
  Type.Object({
    requestDatedOn: NULLABLE_STRING,
    scopeNote: NULLABLE_STRING,
    /** The patient when the request covers exactly one claim; null otherwise (no single patient). */
    patientId: NULLABLE_STRING,
    providerEntityId: Type.String(),
    adrCaseId: NULLABLE_STRING,
    denialCaseId: NULLABLE_STRING,
    respondedAt: NULLABLE_STRING,
    closedAt: NULLABLE_STRING,
    claims: Type.Array(
      Type.Object({
        id: Type.String(),
        claimId: Type.String(),
        dateOfServiceNote: NULLABLE_STRING,
        claimControlNumber: NULLABLE_STRING,
      }),
    ),
    deadlines: Type.Array(RecordedDeadlineViewSchema),
    events: Type.Array(
      Type.Object({ id: Type.String(), eventKind: Type.String(), occurredAt: Type.String() }),
    ),
  }),
]);
export const AuditVersionedResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

export function registerAuditRequestRoutes(
  app: FastifyInstance,
  deps: AuditRequestRouteDeps,
): void {
  const { auditRequestService: svc, laterTierService } = deps;
  const auditId = (request: { params?: unknown }) => uuidParam(request, "id", "audit request");

  app.get(
    "/api/v1/audit-requests",
    { preHandler: [READ], config: { auditRead: { resourceKind: "audit_request", list: true } } },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const state = typeof q.state === "string" && q.state.length > 0 ? q.state : undefined;
      return reply.send(
        await svc.listAuditRequests(
          actorOf(request),
          state ? { state } : {},
          clampLimit(typeof q.limit === "string" ? q.limit : undefined),
        ),
      );
    },
  );

  app.get(
    "/api/v1/audit-requests/:id",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "audit_request",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) => {
      const found = await svc.getAuditRequest(actorOf(request), auditId(request));
      if (!found) throw new NotFoundError("audit request");
      return reply.send(found);
    },
  );

  app.post(
    "/api/v1/audit-requests",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AuditCreateRequestSchema, request.body);
      return reply.code(201).send(await svc.createAuditRequest(writeActorOf(request), body));
    },
  );

  app.patch(
    "/api/v1/audit-requests/:id",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AuditPatchRequestSchema, request.body);
      return reply.send(
        await svc.updateAuditRequest(
          writeActorOf(request),
          auditId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/audit-requests/:id/claims",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AuditClaimRequestSchema, request.body);
      return reply
        .code(201)
        .send(
          await svc.addClaim(
            writeActorOf(request),
            auditId(request),
            body,
            ifMatchVersion(request),
          ),
        );
    },
  );

  app.delete(
    "/api/v1/audit-requests/:id/claims/:claimId",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await svc.removeClaim(
          writeActorOf(request),
          auditId(request),
          uuidParam(request, "claimId", "audit request claim"),
          ifMatchVersion(request),
        ),
      ),
  );

  app.post(
    "/api/v1/audit-requests/:id/state",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AuditMoveRequestSchema, request.body);
      return reply.send(
        await svc.moveAuditRequest(
          writeActorOf(request),
          auditId(request),
          body.to,
          { ...(body.respondedAt ? { respondedAt: body.respondedAt } : {}) },
          ifMatchVersion(request),
        ),
      );
    },
  );

  const subjectOf = (request: { params?: unknown }): DeadlineSubject => ({
    kind: "audit_request",
    id: uuidParam(request, "id", "audit request"),
  });
  const deadlineId = (request: { params?: unknown }) =>
    uuidParam(request, "deadlineId", "recorded deadline");
  app.get(
    "/api/v1/audit-requests/:id/recorded-deadlines",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "audit_request",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) =>
      reply.send(await laterTierService.listDeadlines(actorOf(request), subjectOf(request))),
  );
  app.post(
    "/api/v1/audit-requests/:id/recorded-deadlines",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(RecordedDeadlineRequestSchema, request.body);
      return reply
        .code(201)
        .send(
          await laterTierService.createDeadline(writeActorOf(request), subjectOf(request), body),
        );
    },
  );
  app.patch(
    "/api/v1/audit-requests/:id/recorded-deadlines/:deadlineId",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(RecordedDeadlinePatchSchema, request.body);
      return reply.send(
        await laterTierService.updateDeadline(
          writeActorOf(request),
          subjectOf(request),
          deadlineId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );
  app.post(
    "/api/v1/audit-requests/:id/recorded-deadlines/:deadlineId/satisfy",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(RecordedDeadlineSatisfyRequestSchema, request.body);
      return reply.send(
        await laterTierService.satisfyDeadline(
          writeActorOf(request),
          subjectOf(request),
          deadlineId(request),
          body.satisfiedOn,
          ifMatchVersion(request),
        ),
      );
    },
  );
}
