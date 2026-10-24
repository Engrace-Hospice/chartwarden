// apps/backend/src/modules/25-remittance/routes/later-tier.routes.ts - M25 milestone 7a-1 routes: ALJ / Council /
// federal-court record-keeping and the RECORDED DEADLINES typed from a notice (for an appeal case here; the audit
// request routes reuse `registerDeadlineRoutes`). Reads gate on `appeal.read`, writes on `appeal.tier_record`. Every
// change is If-Match (409 when stale) and every mutation requires an Idempotency-Key. Org, actor and provider-entity
// scope are server-derived (actor.ts). Nothing here computes a CMS date: a recorded deadline is the user's own.
import { NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { DISPOSITION_KINDS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import type { DeadlineSubject, LaterTierService } from "./later-tier-service";
import { parse } from "./m25-typebox";

export interface LaterTierRouteDeps {
  readonly laterTierService: LaterTierService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const IDEMPOTENT = requireIdempotencyKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TierDetailRequestSchema = Type.Object({
  /** The OMHA / DAB / docket reference exactly as printed. */
  authorityReference: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  /** Stored only: never compared to any threshold. Whole cents. */
  amountInControversyCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  hearingOn: Type.Optional(Type.Union([DAY, Type.Null()])),
  hearingFormatNote: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  /** A label only; the appeal outcome and next-tier logic are unchanged. */
  dispositionKind: Type.Optional(
    Type.Union([...DISPOSITION_KINDS.map((k) => Type.Literal(k)), Type.Null()]),
  ),
  dispositionNote: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  /** Federal court only: counsel filed; WardenX files nothing. */
  filedByCounselOn: Type.Optional(Type.Union([DAY, Type.Null()])),
  docketReference: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
});

export const RecordedDeadlineRequestSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 120 }),
  /** The due date exactly as printed on the notice. */
  dueOn: DAY,
  /** Where the date came from (the notice, page, paragraph). Required. */
  sourceNote: Type.String({ minLength: 1, maxLength: 500 }),
  noticeDocumentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  /** An audit request covering several claims: the claim whose patient owns the notice document. */
  noticeClaimId: Type.Optional(Type.String({ format: "uuid" })),
});

export const RecordedDeadlinePatchSchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  dueOn: Type.Optional(DAY),
  sourceNote: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  noticeDocumentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  /** An audit request covering several claims: the claim whose patient owns the notice document. */
  noticeClaimId: Type.Optional(Type.String({ format: "uuid" })),
});

export const RecordedDeadlineSatisfyRequestSchema = Type.Object({
  satisfiedOn: Type.Optional(DAY),
});

export const RecordedDeadlineViewSchema = Type.Object({
  id: Type.String(),
  subjectKind: Type.Union([
    Type.Literal("appeal"),
    Type.Literal("audit_request"),
    Type.Literal("payer_appeal"),
  ]),
  subjectId: Type.String(),
  label: Type.String(),
  dueOn: Type.String(),
  zone: Type.String(),
  dueAt: Type.String(),
  sourceNote: Type.String(),
  noticeDocumentId: NULLABLE_STRING,
  satisfiedOn: NULLABLE_STRING,
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("due_soon"),
    Type.Literal("past"),
    Type.Literal("satisfied"),
  ]),
  version: Type.Integer(),
});
export const RecordedDeadlinePageSchema = Type.Object({
  patientId: NULLABLE_STRING,
  items: Type.Array(RecordedDeadlineViewSchema),
});
export const RecordedDeadlineResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

export const LaterTierViewSchema = Type.Object({
  appealCaseId: Type.String(),
  claimId: Type.String(),
  patientId: NULLABLE_STRING,
  tier: Type.String(),
  state: Type.String(),
  filedByEscalation: Type.Boolean(),
  windowUnconfirmed: Type.Boolean(),
  canPacketRender: Type.Boolean(),
  needsManualReview: Type.Boolean(),
  detail: Type.Union([
    Type.Object({
      id: Type.String(),
      authorityReference: NULLABLE_STRING,
      amountInControversyCents: Type.Union([Type.Integer(), Type.Null()]),
      hearingOn: NULLABLE_STRING,
      hearingFormatNote: NULLABLE_STRING,
      dispositionKind: NULLABLE_STRING,
      dispositionNote: NULLABLE_STRING,
      filedByCounselOn: NULLABLE_STRING,
      docketReference: NULLABLE_STRING,
      version: Type.Integer(),
    }),
    Type.Null(),
  ]),
  deadlines: Type.Array(RecordedDeadlineViewSchema),
});

/** The `:id` path param; a non-uuid can never match a row, so it is a 404 rather than a database cast error. */
export const uuidParam = (request: { params?: unknown }, name: string, what: string): string => {
  const value = (request.params as Record<string, string>)[name] as string;
  if (!UUID.test(value)) throw new NotFoundError(what);
  return value;
};

export function registerLaterTierRoutes(app: FastifyInstance, deps: LaterTierRouteDeps): void {
  const { laterTierService } = deps;
  const READ = P("appeal.read");
  const RECORD = P("appeal.tier_record");

  app.get(
    "/api/v1/appeals/:id/later-tier",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "appeal_case",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) => {
      const found = await laterTierService.getLaterTier(
        actorOf(request),
        uuidParam(request, "id", "appeal case"),
      );
      if (!found) throw new NotFoundError("later-tier appeal case");
      return reply.send(found);
    },
  );

  // Upsert: If-Match 0 creates the detail, a later version updates it.
  app.put(
    "/api/v1/appeals/:id/later-tier/detail",
    { preHandler: [RECORD, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(TierDetailRequestSchema, request.body);
      return reply.send(
        await laterTierService.putTierDetail(
          writeActorOf(request),
          uuidParam(request, "id", "appeal case"),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  const subjectOf = (request: { params?: unknown }): DeadlineSubject => ({
    kind: "appeal",
    id: uuidParam(request, "id", "appeal case"),
  });
  const deadlineId = (request: { params?: unknown }) =>
    uuidParam(request, "deadlineId", "recorded deadline");
  app.get(
    "/api/v1/appeals/:id/recorded-deadlines",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "appeal_case",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) =>
      reply.send(await laterTierService.listDeadlines(actorOf(request), subjectOf(request))),
  );
  app.post(
    "/api/v1/appeals/:id/recorded-deadlines",
    { preHandler: [RECORD, IDEMPOTENT] },
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
    "/api/v1/appeals/:id/recorded-deadlines/:deadlineId",
    { preHandler: [RECORD, IDEMPOTENT] },
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
    "/api/v1/appeals/:id/recorded-deadlines/:deadlineId/satisfy",
    { preHandler: [RECORD, IDEMPOTENT] },
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
