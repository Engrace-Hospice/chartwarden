// apps/backend/src/modules/25-remittance/routes/qic.routes.ts - M25 milestone 4 routes: the QIC reconsideration
// (cited evidence, the QIC's 60-day decision clock) and the escalation to OMHA when the QIC is late. Reads gate on
// `appeal.read`; the evidence list on `appeal.attach_document`; the QIC clock on `appeal.submit`; the escalation
// REQUEST on `appeal.submit` + step-up (the operation key is the permission key, guards.ts); confirming that the QIC
// forwarded the case on `appeal.decide`. Every change is If-Match (409 when stale) and requires an Idempotency-Key.
// Org, actor and provider-entity scope are server-derived (actor.ts). Nothing here sends anything outside WardenX.
import { Type } from "@sinclair/typebox";
import { NotFoundError, ValidationError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { QIC_ESCALATION_CHANNELS, QIC_LATE_EVIDENCE_EXTENSION_MAX_DAYS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
import { parse } from "./m25-typebox";
import type { QicService } from "./qic-service";
import { MAX_CITED_EVIDENCE_ITEMS } from "./qic-service";

export interface QicRouteDeps {
  readonly qicService: QicService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);

export const CitedEvidenceRequestSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1, maxLength: 300 }),
      /** The attached M22 document that is this item; null when it cannot be enclosed. */
      documentId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
      /** Why it is not available (at least 10 characters when there is no document). */
      notAvailableReason: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
    }),
    { maxItems: MAX_CITED_EVIDENCE_ITEMS },
  ),
  /** The attestation that the redetermination notice named no missing documentation. */
  none: Type.Boolean(),
});

/** Exactly one of the two: the date the QIC received the request, or one late-evidence extension. */
export const QicClockRequestSchema = Type.Object({
  receivedOn: Type.Optional(DAY),
  extensionDays: Type.Optional(
    Type.Integer({ minimum: 0, maximum: QIC_LATE_EVIDENCE_EXTENSION_MAX_DAYS }),
  ),
});

export const EscalationRequestSchema = Type.Object({
  channel: Type.Union(QIC_ESCALATION_CHANNELS.map((c) => Type.Literal(c))),
  /** The confirmation or tracking reference given for the escalation request. */
  confirmationRef: Type.String({ minLength: 1, maxLength: 200 }),
  /** When the request was actually sent (ISO date-time). */
  requestedAt: Type.String({ format: "date-time" }),
});

export const EscalationConfirmRequestSchema = Type.Object({
  /** The date the QIC forwarded the case to OMHA. */
  forwardedOn: DAY,
});

const EvidenceItemSchema = Type.Object({
  label: Type.String(),
  documentId: NULLABLE_STRING,
  notAvailableReason: NULLABLE_STRING,
});

export const QicViewSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("reconsideration"),
    Type.Literal("escalated_alj"),
    Type.Literal("none"),
  ]),
  tier: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  redeterminationNoticeDate: NULLABLE_STRING,
  citedEvidence: Type.Array(EvidenceItemSchema),
  citedEvidenceNone: Type.Boolean(),
  evidenceEditable: Type.Boolean(),
  clock: Type.Union([
    Type.Object({
      receivedOn: Type.String(),
      baseDays: Type.Integer(),
      extensionDays: Type.Integer(),
      extensions: Type.Array(Type.Object({ days: Type.Integer(), recordedAt: Type.String() })),
      decisionDueOn: Type.String(),
      decisionDueAt: Type.String(),
      zone: Type.String(),
      overdue: Type.Boolean(),
      daysOverdue: Type.Integer(),
    }),
    Type.Null(),
  ]),
  escalation: Type.Union([
    Type.Object({
      requestedAt: Type.String(),
      channel: Type.String(),
      confirmationRef: Type.String(),
      confirmedOn: NULLABLE_STRING,
    }),
    Type.Null(),
  ]),
  escalationEligible: Type.Boolean(),
  escalationBlockedReason: NULLABLE_STRING,
  nextAppealCaseId: NULLABLE_STRING,
  escalatedFromAppealCaseId: NULLABLE_STRING,
});

export const QicVersionedResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

export const QicEscalationConfirmedSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
  /** The ALJ case the escalation opened. */
  nextAppealCaseId: Type.String(),
});

const READ = P("appeal.read");
const ATTACH = P("appeal.attach_document");
const SUBMIT = P("appeal.submit");
const SUBMIT_STEPUP = STEP_UP("appeal.submit");
const DECIDE = P("appeal.decide");
const IDEMPOTENT = requireIdempotencyKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `:id` path param; a non-uuid can never match a row, so it is a 404 rather than a database cast error. */
const idOf = (request: { params?: unknown }): string => {
  const id = (request.params as { id: string }).id;
  if (!UUID.test(id)) throw new NotFoundError("appeal case not found");
  return id;
};

export function registerQicRoutes(app: FastifyInstance, deps: QicRouteDeps): void {
  const { qicService } = deps;

  app.get(
    "/api/v1/appeals/:id/qic",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "appeal", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const view = await qicService.getQic(actorOf(request), idOf(request));
      if (!view) throw new NotFoundError("appeal case not found");
      return reply.send(view);
    },
  );

  // The documentation the redetermination notice named. Draft only; frozen once the request is submitted.
  app.patch(
    "/api/v1/appeals/:id/cited-evidence",
    { preHandler: [ATTACH, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CitedEvidenceRequestSchema, request.body);
      return reply.send(
        await qicService.setCitedEvidence(
          writeActorOf(request),
          idOf(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.patch(
    "/api/v1/appeals/:id/qic-clock",
    { preHandler: [SUBMIT, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(QicClockRequestSchema, request.body);
      if ((body.receivedOn === undefined) === (body.extensionDays === undefined)) {
        throw new ValidationError("request validation failed", [
          {
            field: "(root)",
            code: "INVALID",
            message: "send exactly one of receivedOn or extensionDays",
          },
        ]);
      }
      const input =
        body.receivedOn !== undefined
          ? { receivedOn: body.receivedOn }
          : { extensionDays: body.extensionDays as number };
      return reply.send(
        await qicService.recordQicClock(
          writeActorOf(request),
          idOf(request),
          input,
          ifMatchVersion(request),
        ),
      );
    },
  );

  // Records an escalation request made outside WardenX: RBAC + step-up (D15), proof required, frozen once recorded.
  app.post(
    "/api/v1/appeals/:id/request-escalation",
    { preHandler: [SUBMIT, SUBMIT_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(EscalationRequestSchema, request.body);
      return reply.send(
        await qicService.requestEscalation(
          writeActorOf(request),
          idOf(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/appeals/:id/confirm-escalation",
    { preHandler: [DECIDE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(EscalationConfirmRequestSchema, request.body);
      return reply.send(
        await qicService.confirmEscalation(
          writeActorOf(request),
          idOf(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );
}
