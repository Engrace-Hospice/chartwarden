// apps/backend/src/modules/25-remittance/routes/audit-response.routes.ts - M25 milestone 7a-2 routes: the audit response
// packet. Typing the checklist, attaching documents and the none-stated attestation gate on `audit_request.manage`;
// sign-off on `audit_request.review` + step-up (a person who did not prepare the packet); recording the filing on
// `audit_request.submit` + step-up (the operation key is the permission key, guards.ts). Each packet change is If-Match
// so a sign-off is always on the version the reviewer saw, and every mutation requires an Idempotency-Key. Org, actor
// and provider-entity scope are server-derived (actor.ts). Nothing here sends anything outside ChartWarden.
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { AUDIT_FILING_CHANNELS, AUDIT_RESPONSE_ITEM_STATES } from "../domain";
import { writeActorOf } from "./actor";
import type { AuditResponseOps } from "./audit-response-service";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
import { uuidParam } from "./later-tier.routes";
import { parse } from "./m25-typebox";

export interface AuditResponseRouteDeps {
  readonly auditResponse: AuditResponseOps;
}

export const AuditResponseItemsRequestSchema = Type.Object({
  /** The checklist as typed from the request letter; the whole list is replaced. */
  items: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1, maxLength: 200 }),
      state: Type.Union(AUDIT_RESPONSE_ITEM_STATES.map((s) => Type.Literal(s))),
    }),
    { maxItems: 50 },
  ),
});

export const AuditAttachDocumentRequestSchema = Type.Object({
  /** One of the request's live claims; the document must belong to that claim's patient. */
  claimId: Type.String({ format: "uuid" }),
  documentId: Type.String({ format: "uuid" }),
});

export const AuditSubmitRequestSchema = Type.Object({
  channel: Type.Union(AUDIT_FILING_CHANNELS.map((c) => Type.Literal(c))),
  /** The confirmation or tracking reference the channel gave for the response. */
  confirmationRef: Type.String({ minLength: 1, maxLength: 200 }),
  /** When the response was actually sent (ISO date-time). */
  filedAt: Type.String({ format: "date-time" }),
  lateAcknowledged: Type.Optional(Type.Boolean()),
  receiptDocumentId: Type.Optional(Type.String({ format: "uuid" })),
  /** The claim whose patient owns the receipt document; optional when the request covers exactly one claim. */
  receiptClaimId: Type.Optional(Type.String({ format: "uuid" })),
});

export const AuditResponseVersionedResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

const IDEMPOTENT = requireIdempotencyKey();
const MANAGE = P("audit_request.manage");
const REVIEW = P("audit_request.review");
const REVIEW_STEPUP = STEP_UP("audit_request.review");
const SUBMIT = P("audit_request.submit");
const SUBMIT_STEPUP = STEP_UP("audit_request.submit");

export function registerAuditResponseRoutes(
  app: FastifyInstance,
  deps: AuditResponseRouteDeps,
): void {
  const { auditResponse: ops } = deps;
  const auditId = (request: { params?: unknown }) => uuidParam(request, "id", "audit request");

  app.put(
    "/api/v1/audit-requests/:id/response-items",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AuditResponseItemsRequestSchema, request.body);
      return reply.send(
        await ops.setResponseItems(
          writeActorOf(request),
          auditId(request),
          body.items,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/audit-requests/:id/documents",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AuditAttachDocumentRequestSchema, request.body);
      return reply.send(
        await ops.attachAuditDocument(
          writeActorOf(request),
          auditId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.delete(
    "/api/v1/audit-requests/:id/documents/:documentId",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await ops.detachAuditDocument(
          writeActorOf(request),
          auditId(request),
          uuidParam(request, "documentId", "attached document"),
          ifMatchVersion(request),
        ),
      ),
  );

  // The explicit "the request letter states no due date" attestation (the cited_evidence_none pattern).
  app.post(
    "/api/v1/audit-requests/:id/deadline-none-stated",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await ops.attestNoDeadlineStated(
          writeActorOf(request),
          auditId(request),
          ifMatchVersion(request),
        ),
      ),
  );

  app.post(
    "/api/v1/audit-requests/:id/sign-off",
    { preHandler: [REVIEW, REVIEW_STEPUP, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await ops.signOffAudit(writeActorOf(request), auditId(request), ifMatchVersion(request)),
      ),
  );

  // Records a response filed outside ChartWarden: RBAC + step-up (D15), proof required, frozen manifest, retained PDF.
  app.post(
    "/api/v1/audit-requests/:id/submit",
    { preHandler: [SUBMIT, SUBMIT_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AuditSubmitRequestSchema, request.body);
      return reply.send(
        await ops.submitAuditResponse(
          writeActorOf(request),
          auditId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );
}
