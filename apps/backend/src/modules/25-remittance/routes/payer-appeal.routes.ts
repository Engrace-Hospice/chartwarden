// apps/backend/src/modules/25-remittance/routes/payer-appeal.routes.ts - M25 milestone 12a-1 routes: the payer appeal CASE,
// keyed on the denial. Reads gate on `payer_appeal.read`, writes on `payer_appeal.manage`. A payer appeal REFUSES a Medicare
// denial. Every change is If-Match (409 when stale) and every mutation requires an Idempotency-Key. Org, actor and
// provider-entity scope are server-derived. Nothing is filed or sent: a person records what happened outside ChartWarden.
// Deadlines typed from a notice reuse the recorded-deadline service under `/payer-appeals/:id/recorded-deadlines`.
import { NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { DISPOSITION_KINDS, LEVEL_KINDS, PAYER_DECISION_OUTCOMES, PAYER_PROGRAMS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import type { LaterTierService } from "./later-tier-service";
import {
  RecordedDeadlinePatchSchema,
  RecordedDeadlineRequestSchema,
  RecordedDeadlineSatisfyRequestSchema,
  RecordedDeadlineViewSchema,
  uuidParam,
} from "./later-tier.routes";
import { parse } from "./m25-typebox";
import type { PayerAppealService } from "./payer-appeal-service";

export interface PayerAppealRouteDeps {
  readonly payerAppealService: PayerAppealService;
  readonly laterTierService?: LaterTierService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const NULLABLE_INT = Type.Union([Type.Integer(), Type.Null()]);
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const PayerAppealOpenRequestSchema = Type.Object({
  program: Type.Optional(literals(PAYER_PROGRAMS)),
  contractLabel: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
  /** A level of the recorded path; omit for the first level (or the one after the prior level). */
  levelOrdinal: Type.Optional(Type.Integer({ minimum: 1 })),
  /** With no recorded path (or no such level) the person names the level. */
  levelLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  levelKind: Type.Optional(literals(LEVEL_KINDS)),
  /** The date printed on the notice this level's clock runs from, typed. */
  noticeDate: Type.Optional(DAY),
  priorLevelCaseId: Type.Optional(Type.String({ format: "uuid" })),
});

export const PayerAppealNoticeRequestSchema = Type.Object({ noticeDate: DAY });

export const PayerAppealMoveRequestSchema = Type.Object({
  move: Type.Union([
    Type.Literal("submit"),
    Type.Literal("begin_review"),
    Type.Literal("decide"),
    Type.Literal("close"),
    Type.Literal("withdraw"),
  ]),
  payerReference: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  externalReviewerName: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  outcome: Type.Optional(literals(PAYER_DECISION_OUTCOMES)),
  dispositionKind: Type.Optional(
    Type.Union([...DISPOSITION_KINDS.map((k) => Type.Literal(k)), Type.Null()]),
  ),
  dispositionNote: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
});

export const PayerAppealOpenedSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
  deadlineSource: Type.String(),
});
export const PayerAppealVersionedSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

const PatientAttributionSchema = Type.Union([Type.Literal("claim"), Type.Literal("unattributed")]);

export const PayerAppealCaseViewSchema = Type.Object({
  id: Type.String(),
  denialCaseId: Type.String(),
  claimId: NULLABLE_STRING,
  payerId: Type.String(),
  program: Type.String(),
  pathId: NULLABLE_STRING,
  pathRevision: NULLABLE_INT,
  levelOrdinal: NULLABLE_INT,
  levelKind: Type.String(),
  levelLabel: Type.String(),
  priorLevelCaseId: NULLABLE_STRING,
  state: Type.String(),
  noticeDatedOn: NULLABLE_STRING,
  deadlineAt: NULLABLE_STRING,
  deadlineZone: NULLABLE_STRING,
  deadlineSource: Type.String(),
  deadlineState: Type.Union([
    Type.Literal("computed"),
    Type.Literal("recorded"),
    Type.Literal("none"),
  ]),
  windowVerified: Type.Boolean(),
  derivation: Type.Union([
    Type.Object({
      presumedReceiptOn: NULLABLE_STRING,
      calendarLastDay: Type.String(),
      lastFilingDay: Type.String(),
    }),
    Type.Null(),
  ]),
  prompt: NULLABLE_STRING,
  pathAwaitingVerification: Type.Boolean(),
  patientId: NULLABLE_STRING,
  patientAttribution: PatientAttributionSchema,
  payerReference: NULLABLE_STRING,
  externalReviewerName: NULLABLE_STRING,
  decisionOutcome: NULLABLE_STRING,
  dispositionKind: NULLABLE_STRING,
  dispositionNote: NULLABLE_STRING,
  needsManualReview: Type.Boolean(),
  decisionOverdue: Type.Boolean(),
  submittedAt: NULLABLE_STRING,
  decidedAt: NULLABLE_STRING,
  closedAt: NULLABLE_STRING,
  version: Type.Integer(),
  deadlines: Type.Array(RecordedDeadlineViewSchema),
});

export const PayerAppealDenialViewSchema = Type.Object({
  denialCaseId: Type.String(),
  payerId: NULLABLE_STRING,
  payerName: NULLABLE_STRING,
  payerKind: NULLABLE_STRING,
  adviceKind: NULLABLE_STRING,
  refusal: Type.Union([
    Type.Literal("MEDICARE_PAYER"),
    Type.Literal("MEDICAID_PAYER"),
    Type.Literal("NO_PAYER_ADVICE"),
    Type.Null(),
  ]),
  maHint: Type.Boolean(),
  payerUnresolved: Type.Boolean(),
  patientId: NULLABLE_STRING,
  patientAttribution: PatientAttributionSchema,
  path: Type.Union([
    Type.Object({
      id: Type.String(),
      status: Type.String(),
      verified: Type.Boolean(),
      revision: Type.Integer(),
      program: Type.String(),
      levels: Type.Array(
        Type.Object({
          ordinal: Type.Integer(),
          levelKind: Type.String(),
          levelLabel: Type.String(),
          whoFiles: Type.String(),
          windowComplete: Type.Boolean(),
        }),
      ),
    }),
    Type.Null(),
  ]),
  pathPrompt: NULLABLE_STRING,
  cases: Type.Array(PayerAppealCaseViewSchema),
});

export function registerPayerAppealRoutes(app: FastifyInstance, deps: PayerAppealRouteDeps): void {
  const { payerAppealService: svc, laterTierService } = deps;
  const READ = P("payer_appeal.read");
  const MANAGE = P("payer_appeal.manage");
  const IDEMPOTENT = requireIdempotencyKey();
  const denialId = (request: { params?: unknown }) =>
    uuidParam(request, "denialCaseId", "denial case");
  const caseId = (request: { params?: unknown }) => uuidParam(request, "id", "payer appeal case");

  app.get(
    "/api/v1/denials/:denialCaseId/payer-appeals",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "denial_case",
          resourceIdParam: "denialCaseId",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) =>
      reply.send(await svc.getForDenial(actorOf(request), denialId(request))),
  );

  app.post(
    "/api/v1/denials/:denialCaseId/payer-appeals",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(PayerAppealOpenRequestSchema, request.body);
      return reply.code(201).send(await svc.open(writeActorOf(request), denialId(request), body));
    },
  );

  app.get(
    "/api/v1/payer-appeals/:id",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "payer_appeal_case",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) => {
      const found = await svc.getCase(actorOf(request), caseId(request));
      if (!found) throw new NotFoundError("payer appeal case");
      return reply.send(found);
    },
  );

  app.put(
    "/api/v1/payer-appeals/:id/notice",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(PayerAppealNoticeRequestSchema, request.body);
      return reply.send(
        await svc.recordNotice(
          writeActorOf(request),
          caseId(request),
          body.noticeDate,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/payer-appeals/:id/state",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const { move, ...input } = parse(PayerAppealMoveRequestSchema, request.body);
      return reply.send(
        await svc.move(
          writeActorOf(request),
          caseId(request),
          move,
          input,
          ifMatchVersion(request),
        ),
      );
    },
  );

  if (!laterTierService) return;
  const subjectOf = (request: { params?: unknown }) => ({
    kind: "payer_appeal" as const,
    id: caseId(request),
  });
  const deadlineId = (request: { params?: unknown }) =>
    uuidParam(request, "deadlineId", "recorded deadline");
  app.get(
    "/api/v1/payer-appeals/:id/recorded-deadlines",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "payer_appeal_case",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) =>
      reply.send(await laterTierService.listDeadlines(actorOf(request), subjectOf(request))),
  );
  app.post(
    "/api/v1/payer-appeals/:id/recorded-deadlines",
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
    "/api/v1/payer-appeals/:id/recorded-deadlines/:deadlineId",
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
    "/api/v1/payer-appeals/:id/recorded-deadlines/:deadlineId/satisfy",
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
