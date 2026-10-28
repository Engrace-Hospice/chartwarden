import { NotFoundError } from "@chartwarden/types";
// apps/backend/src/modules/25-remittance/routes/adr.routes.ts — M25 ADR routes (hospice ADR/TPE/QIC PRD
// milestone 2a): the ADR worklist and detail, log an ADR, move it through assembly / review / closure, and the
// organization's MAC response-window rules. Reads gate on `adr.read`, case writes on `adr.manage`, rule edits
// on `mac_rule.manage`. PATCH-style transitions are optimistic-concurrency (If-Match -> 409 when stale); every
// mutation requires an Idempotency-Key. Org, actor and provider-entity scope are server-derived (actor.ts).
// Milestone 2b adds the response packet: attach / detach documents and tick the checklist (`adr.manage`), sign off
// (`adr.review`, a different person from whoever sent it to review) and record the filing (`adr.submit` + step-up).
// Each packet change is If-Match so a sign-off is always on the version the reviewer saw.
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { ADR_CHECKLIST_KEYS, ADR_FILING_CHANNELS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import type { AdrManualTarget, AdrService } from "./adr-service";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P, STEP_UP } from "./guards";
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

const CHECKLIST_KEY = Type.Union(ADR_CHECKLIST_KEYS.map((k) => Type.Literal(k)));

export const AdrAttachDocumentRequestSchema = Type.Object({
  documentId: Type.String({ format: "uuid" }),
  checklistKey: Type.Optional(CHECKLIST_KEY),
});

export const AdrChecklistRequestSchema = Type.Object({
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("ready"),
    Type.Literal("not_applicable"),
  ]),
});

export const AdrSubmitRequestSchema = Type.Object({
  channel: Type.Union(ADR_FILING_CHANNELS.map((c) => Type.Literal(c))),
  /** The confirmation or tracking reference the MAC (or carrier) gave for the response. */
  confirmationRef: Type.String({ minLength: 1, maxLength: 200 }),
  /** When the response was actually sent (ISO date-time). */
  filedAt: Type.String({ format: "date-time" }),
  lateAcknowledged: Type.Optional(Type.Boolean()),
  receiptDocumentId: Type.Optional(Type.String({ format: "uuid" })),
});

export const MacRuleRequestSchema = Type.Object({
  macName: Type.String({ minLength: 1, maxLength: 120 }),
  reviewType: REVIEW_TYPE,
  responseDays: Type.Integer({ minimum: 1, maximum: 365 }),
  sourceNote: Type.Optional(Type.String({ maxLength: 500 })),
  verifiedOn: Type.Optional(DAY),
  effectiveFrom: Type.Optional(DAY),
});

const AdrPacketSchema = Type.Object({
  documents: Type.Array(
    Type.Object({
      id: Type.String(),
      documentId: Type.String(),
      checklistKey: Type.Union([Type.String(), Type.Null()]),
      attachedAt: Type.String(),
    }),
  ),
  checklist: Type.Array(Type.Object({ key: Type.String(), state: Type.String() })),
  sentToReviewByMembershipId: Type.Union([Type.String(), Type.Null()]),
  reviewedByMembershipId: Type.Union([Type.String(), Type.Null()]),
  reviewedAt: Type.Union([Type.String(), Type.Null()]),
  filing: Type.Union([
    Type.Object({
      channel: Type.String(),
      confirmationRef: Type.String(),
      filedAt: Type.String(),
      filedLate: Type.Boolean(),
      receiptDocumentId: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
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
    packet: AdrPacketSchema,
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
const REVIEW = P("adr.review");
const SUBMIT = P("adr.submit");
const SUBMIT_STEPUP = STEP_UP("adr.submit");
const IDEMPOTENT = requireIdempotencyKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The `:id` path param; a non-uuid can never match a row, so it is a 404 rather than a database cast error. */
const idOf = (request: { params?: unknown }): string => {
  const id = (request.params as { id: string }).id;
  if (!UUID.test(id)) throw new NotFoundError("ADR case");
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
      if (!adr) throw new NotFoundError("ADR case");
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

  app.post(
    "/api/v1/adrs/:id/documents",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AdrAttachDocumentRequestSchema, request.body);
      return reply.send(
        await adrService.attachAdrDocument(
          writeActorOf(request),
          idOf(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.delete(
    "/api/v1/adrs/:id/documents/:documentId",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const documentId = (request.params as { documentId: string }).documentId;
      if (!UUID.test(documentId)) throw new NotFoundError("attached document");
      return reply.send(
        await adrService.detachAdrDocument(
          writeActorOf(request),
          idOf(request),
          documentId,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.put(
    "/api/v1/adrs/:id/checklist/:key",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AdrChecklistRequestSchema, request.body);
      return reply.send(
        await adrService.setAdrChecklistItem(
          writeActorOf(request),
          idOf(request),
          (request.params as { key: string }).key,
          body.state,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/adrs/:id/sign-off",
    { preHandler: [REVIEW, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await adrService.signOffAdr(writeActorOf(request), idOf(request), ifMatchVersion(request)),
      ),
  );

  // Records a response filed outside ChartWarden: RBAC + step-up (D15), proof required, frozen manifest, retained PDF.
  app.post(
    "/api/v1/adrs/:id/submit",
    { preHandler: [SUBMIT, SUBMIT_STEPUP, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(AdrSubmitRequestSchema, request.body);
      return reply.send(
        await adrService.submitAdr(
          writeActorOf(request),
          idOf(request),
          body,
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
