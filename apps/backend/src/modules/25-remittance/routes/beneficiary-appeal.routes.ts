// apps/backend/src/modules/25-remittance/routes/beneficiary-appeal.routes.ts - M25 milestone 13a routes: the BENEFICIARY APPEAL record,
// keyed on the claim. Reads gate on `beneficiary_appeal.read`, writes on `beneficiary_appeal.manage`. ChartWarden RECORDS the
// appeal; it computes no deadline for it and files nothing. Every change is If-Match (409 when stale) and every mutation requires an
// Idempotency-Key. Org, actor and provider-entity scope are server-derived; the patient comes from the claim. Every PHI read
// emits a read-audit event keyed on its own id and attributed to the patient. Deadlines typed from a notice reuse the
// recorded-deadline service under `/beneficiary-appeals/:id/recorded-deadlines`.
import { NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  BENEFICIARY_APPEAL_BOUNDS,
  BENEFICIARY_FILER_KINDS,
  BENEFICIARY_OUTCOME_LABELS,
  BENEFICIARY_TIER_LABELS,
} from "../domain";
import { actorOf, writeActorOf } from "./actor";
import type { BeneficiaryAppealService } from "./beneficiary-appeal-service";
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

export interface BeneficiaryAppealRouteDeps {
  readonly beneficiaryAppealService: BeneficiaryAppealService;
  readonly laterTierService?: LaterTierService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const optionalNullable = <T extends ReturnType<typeof Type.String>>(t: T) =>
  Type.Optional(Type.Union([t, Type.Null()]));
const NOTE = Type.String({ maxLength: BENEFICIARY_APPEAL_BOUNDS.noteMax });
const REF = Type.String({ maxLength: BENEFICIARY_APPEAL_BOUNDS.referenceMax });

export const BeneficiaryAppealIntakeRequestSchema = Type.Object({
  filerKind: literals(BENEFICIARY_FILER_KINDS),
  /** The level as the notice names it, or 'other'. */
  tierLabel: literals(BENEFICIARY_TIER_LABELS),
  /** Typed; absent = not known yet. */
  filedOn: optionalNullable(DAY),
  externalReference: optionalNullable(REF),
  /** How the hospice learned of this appeal. */
  sourceNote: Type.String({ minLength: 1, maxLength: BENEFICIARY_APPEAL_BOUNDS.noteMax }),
  /** The hospice's own denial on the SAME claim, when one is related. */
  denialCaseId: optionalNullable(Type.String({ format: "uuid" })),
  /** An appointment of the SAME patient; only for a representative filer. */
  representativeAppointmentId: optionalNullable(Type.String({ format: "uuid" })),
});

export const BeneficiaryAppealPatchRequestSchema = Type.Object({
  filerKind: Type.Optional(literals(BENEFICIARY_FILER_KINDS)),
  tierLabel: Type.Optional(literals(BENEFICIARY_TIER_LABELS)),
  filedOn: optionalNullable(DAY),
  externalReference: optionalNullable(REF),
  sourceNote: Type.Optional(
    Type.String({ minLength: 1, maxLength: BENEFICIARY_APPEAL_BOUNDS.noteMax }),
  ),
  denialCaseId: optionalNullable(Type.String({ format: "uuid" })),
  representativeAppointmentId: optionalNullable(Type.String({ format: "uuid" })),
});

export const BeneficiaryAppealMoveRequestSchema = Type.Object({
  move: Type.Union([
    Type.Literal("support"),
    Type.Literal("decide"),
    Type.Literal("close"),
    Type.Literal("withdraw"),
  ]),
  /** A label of what the notice states; never acted on. */
  outcomeLabel: Type.Optional(literals(BENEFICIARY_OUTCOME_LABELS)),
  outcomeNote: optionalNullable(NOTE),
});

export const BeneficiaryAppealDocumentRequestSchema = Type.Object({
  documentId: Type.String({ format: "uuid" }),
  documentVersionId: Type.String({ format: "uuid" }),
});

export const BeneficiaryAppealViewSchema = Type.Object({
  id: Type.String(),
  claimId: Type.String(),
  patientId: Type.String(),
  denialCaseId: NULLABLE_STRING,
  filerKind: Type.String(),
  representativeAppointmentId: NULLABLE_STRING,
  appointment: Type.Union([
    Type.Object({
      id: Type.String(),
      state: Type.String(),
      status: Type.String(),
      validThroughOn: NULLABLE_STRING,
      representativeKind: Type.String(),
    }),
    Type.Null(),
  ]),
  representativeStatus: NULLABLE_STRING,
  tierLabel: Type.String(),
  filedOn: NULLABLE_STRING,
  externalReference: NULLABLE_STRING,
  sourceNote: Type.String(),
  state: Type.String(),
  outcomeLabel: NULLABLE_STRING,
  outcomeNote: NULLABLE_STRING,
  closedAt: NULLABLE_STRING,
  version: Type.Integer(),
  documents: Type.Array(
    Type.Object({
      id: Type.String(),
      documentId: Type.String(),
      documentVersionId: Type.String(),
      attachedAt: Type.String(),
    }),
  ),
  deadlines: Type.Array(RecordedDeadlineViewSchema),
});
export const ClaimBeneficiaryAppealsSchema = Type.Object({
  claimId: Type.String(),
  patientId: Type.String(),
  items: Type.Array(BeneficiaryAppealViewSchema),
});
export const BeneficiaryAppealVersionedSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

export function registerBeneficiaryAppealRoutes(
  app: FastifyInstance,
  deps: BeneficiaryAppealRouteDeps,
): void {
  const { beneficiaryAppealService: svc, laterTierService } = deps;
  const READ = P("beneficiary_appeal.read");
  const MANAGE = P("beneficiary_appeal.manage");
  const IDEMPOTENT = requireIdempotencyKey();
  const claimId = (request: { params?: unknown }) => uuidParam(request, "claimId", "claim");
  const appealId = (request: { params?: unknown }) =>
    uuidParam(request, "id", "beneficiary appeal");

  app.get(
    "/api/v1/claims/:claimId/beneficiary-appeals",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "claim_beneficiary_appeals",
          resourceIdParam: "claimId",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) =>
      reply.send(await svc.listForClaim(actorOf(request), claimId(request))),
  );
  app.post(
    "/api/v1/claims/:claimId/beneficiary-appeals",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(BeneficiaryAppealIntakeRequestSchema, request.body);
      return reply.code(201).send(await svc.create(writeActorOf(request), claimId(request), body));
    },
  );
  app.get(
    "/api/v1/beneficiary-appeals/:id",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "beneficiary_appeal",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) => {
      const found = await svc.get(actorOf(request), appealId(request));
      if (!found) throw new NotFoundError("beneficiary appeal");
      return reply.send(found);
    },
  );
  app.patch(
    "/api/v1/beneficiary-appeals/:id",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(BeneficiaryAppealPatchRequestSchema, request.body);
      return reply.send(
        await svc.update(writeActorOf(request), appealId(request), body, ifMatchVersion(request)),
      );
    },
  );
  app.post(
    "/api/v1/beneficiary-appeals/:id/state",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const { move, ...input } = parse(BeneficiaryAppealMoveRequestSchema, request.body);
      return reply.send(
        await svc.move(
          writeActorOf(request),
          appealId(request),
          move,
          input,
          ifMatchVersion(request),
        ),
      );
    },
  );
  app.post(
    "/api/v1/beneficiary-appeals/:id/documents",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(BeneficiaryAppealDocumentRequestSchema, request.body);
      return reply
        .code(201)
        .send(
          await svc.attachDocument(
            writeActorOf(request),
            appealId(request),
            body,
            ifMatchVersion(request),
          ),
        );
    },
  );
  app.post(
    "/api/v1/beneficiary-appeals/:id/documents/:documentId/remove",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await svc.detachDocument(
          writeActorOf(request),
          appealId(request),
          uuidParam(request, "documentId", "document"),
          ifMatchVersion(request),
        ),
      ),
  );

  if (!laterTierService) return;
  const subjectOf = (request: { params?: unknown }) => ({
    kind: "beneficiary_appeal" as const,
    id: appealId(request),
  });
  const deadlineId = (request: { params?: unknown }) =>
    uuidParam(request, "deadlineId", "recorded deadline");
  app.get(
    "/api/v1/beneficiary-appeals/:id/recorded-deadlines",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          resourceKind: "beneficiary_appeal",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) =>
      reply.send(await laterTierService.listDeadlines(actorOf(request), subjectOf(request))),
  );
  app.post(
    "/api/v1/beneficiary-appeals/:id/recorded-deadlines",
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
    "/api/v1/beneficiary-appeals/:id/recorded-deadlines/:deadlineId",
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
    "/api/v1/beneficiary-appeals/:id/recorded-deadlines/:deadlineId/satisfy",
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
