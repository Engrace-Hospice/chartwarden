// apps/backend/src/modules/25-remittance/routes/submission.routes.ts - M25 milestone 6a routes: the submission attempt of
// an ADR response, an appeal (incl. a QIC escalation request) and a reopening request. Reading gates on each subject's
// own read key; recording a receipt gates on the subject's submit key + step-up (the operation key is the permission
// key, guards.ts); cancelling gates on the submit key. No new permission keys. Every change is If-Match (409 when
// stale) and requires an Idempotency-Key. Org, actor and provider-entity scope are server-derived (actor.ts).
// Nothing here sends anything outside ChartWarden: there is no send route in 6a.
import { Type } from "@sinclair/typebox";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
import { parse } from "./m25-typebox";
import type { SubmissionService, SubmissionSubjectKind } from "./submission-service";

export interface SubmissionRouteDeps {
  readonly submissionService: SubmissionService;
}

const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);

export const SubmissionReceiptRequestSchema = Type.Object({
  attemptId: Type.String({ format: "uuid" }),
  /** The confirmation or tracking reference exactly as the channel shows it. Never a Medicare number. */
  confirmationRef: Type.String({ minLength: 1, maxLength: 200 }),
  /** When the channel says it received the filing (ISO date-time). */
  receiptAt: Type.String({ format: "date-time" }),
  /** A retained copy of the receipt (an M22 document of the claim's patient). */
  receiptDocumentId: Type.Optional(Type.String({ format: "uuid" })),
});

export const SubmissionCancelRequestSchema = Type.Object({
  attemptId: Type.String({ format: "uuid" }),
  /** Why the attempt is cancelled (at least 10 characters). */
  reason: Type.String({ minLength: 10, maxLength: 500 }),
});

export const SubmissionReceiptResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
  /** True when the receipt was already recorded and this call appended a correction. */
  amended: Type.Boolean(),
});
export const SubmissionVersionedResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

const AttemptSchema = Type.Object({
  id: Type.String(),
  purpose: Type.String(),
  attemptNo: Type.Integer(),
  channel: NULLABLE_STRING,
  adapter: Type.String(),
  status: Type.String(),
  needsManualReason: NULLABLE_STRING,
  confirmationRef: NULLABLE_STRING,
  receiptAt: NULLABLE_STRING,
  receiptDocumentId: NULLABLE_STRING,
  receiptSource: NULLABLE_STRING,
  amendments: Type.Array(
    Type.Object({
      recordedAt: Type.String(),
      confirmationRef: Type.String(),
      receiptAt: Type.String(),
      receiptDocumentId: NULLABLE_STRING,
    }),
  ),
  approvedAt: NULLABLE_STRING,
  createdAt: Type.String(),
  version: Type.Integer(),
  proofMissing: Type.Boolean(),
});

export const SubmissionViewSchema = Type.Object({
  subjectKind: Type.String(),
  subjectId: Type.String(),
  patientId: NULLABLE_STRING,
  attempts: Type.Array(AttemptSchema),
  proofMissing: Type.Boolean(),
  noAttemptRecord: Type.Boolean(),
  adapters: Type.Array(
    Type.Object({
      kind: Type.String(),
      mode: Type.String(),
      bound: Type.Boolean(),
      reason: Type.String(),
    }),
  ),
  checklist: Type.Array(Type.Object({ key: Type.String(), text: Type.String() })),
});

const IDEMPOTENT = requireIdempotencyKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
/** The route passes `request.body` in itself, so the registration is where the body is visibly read. */
type BodyHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
) => Promise<unknown>;

/** The three handlers one subject kind shares; the registrars below keep every path and permission key literal. */
function handlersFor(svc: SubmissionService, kind: SubmissionSubjectKind, what: string) {
  const idOf = (request: { params?: unknown }): string => {
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id)) throw new NotFoundError(what);
    return id;
  };
  const get: Handler = async (request, reply) =>
    reply.send(await svc.getSubmission(actorOf(request), kind, idOf(request)));
  const receipt: BodyHandler = async (request, reply, rawBody) => {
    const body = parse(SubmissionReceiptRequestSchema, rawBody);
    return reply.send(
      await svc.recordReceipt(
        writeActorOf(request),
        kind,
        idOf(request),
        body,
        ifMatchVersion(request),
      ),
    );
  };
  const cancel: BodyHandler = async (request, reply, rawBody) => {
    const body = parse(SubmissionCancelRequestSchema, rawBody);
    return reply.send(
      await svc.cancelAttempt(
        writeActorOf(request),
        kind,
        idOf(request),
        body.attemptId,
        body.reason,
        ifMatchVersion(request),
      ),
    );
  };
  return { get, receipt, cancel };
}

// The cancel routes are deliberate 6b scaffolding: in 6a every attempt is acknowledged or needs_manual, and a
// needs_manual attempt on a filed case is never cancellable (PROOF_ONLY_PATH), so nothing calls them yet.
export function registerAdrSubmissionRoutes(app: FastifyInstance, deps: SubmissionRouteDeps): void {
  const h = handlersFor(deps.submissionService, "adr", "ADR case");
  const submit = P("adr.submit");
  app.get(
    "/api/v1/adrs/:id/submission",
    {
      preHandler: [P("adr.read")],
      config: {
        auditRead: {
          resourceKind: "adr_case",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    h.get,
  );
  app.post(
    "/api/v1/adrs/:id/submission-receipt",
    { preHandler: [submit, STEP_UP("adr.submit"), IDEMPOTENT] },
    (request, reply) => h.receipt(request, reply, request.body),
  );
  app.post(
    "/api/v1/adrs/:id/submission-cancel",
    { preHandler: [submit, STEP_UP("adr.submit"), IDEMPOTENT] },
    (request, reply) => h.cancel(request, reply, request.body),
  );
}

export function registerAppealSubmissionRoutes(
  app: FastifyInstance,
  deps: SubmissionRouteDeps,
): void {
  const h = handlersFor(deps.submissionService, "appeal", "appeal case");
  const submit = P("appeal.submit");
  app.get(
    "/api/v1/appeals/:id/submission",
    {
      preHandler: [P("appeal.read")],
      config: {
        auditRead: {
          resourceKind: "appeal",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    h.get,
  );
  app.post(
    "/api/v1/appeals/:id/submission-receipt",
    { preHandler: [submit, STEP_UP("appeal.submit"), IDEMPOTENT] },
    (request, reply) => h.receipt(request, reply, request.body),
  );
  app.post(
    "/api/v1/appeals/:id/submission-cancel",
    { preHandler: [submit, STEP_UP("appeal.submit"), IDEMPOTENT] },
    (request, reply) => h.cancel(request, reply, request.body),
  );
}

export function registerReopeningSubmissionRoutes(
  app: FastifyInstance,
  deps: SubmissionRouteDeps,
): void {
  const h = handlersFor(deps.submissionService, "reopening", "reopening case");
  const submit = P("reopening.submit");
  app.get(
    "/api/v1/reopenings/:id/submission",
    {
      preHandler: [P("reopening.read")],
      config: {
        auditRead: {
          resourceKind: "reopening_case",
          resourceIdParam: "id",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    h.get,
  );
  app.post(
    "/api/v1/reopenings/:id/submission-receipt",
    { preHandler: [submit, STEP_UP("reopening.submit"), IDEMPOTENT] },
    (request, reply) => h.receipt(request, reply, request.body),
  );
  app.post(
    "/api/v1/reopenings/:id/submission-cancel",
    { preHandler: [submit, STEP_UP("reopening.submit"), IDEMPOTENT] },
    (request, reply) => h.cancel(request, reply, request.body),
  );
}

/** Mount the three subjects' submission routes. */
export function registerSubmissionRoutes(app: FastifyInstance, deps: SubmissionRouteDeps): void {
  registerAdrSubmissionRoutes(app, deps);
  registerAppealSubmissionRoutes(app, deps);
  registerReopeningSubmissionRoutes(app, deps);
}
