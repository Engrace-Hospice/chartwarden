// apps/backend/src/modules/36-messaging/routes/handoff-routes.ts - WP 3.5 clinical handoffs (ADR-0062).
//
//   GET    /api/v1/messaging/handoffs?scope&state&limit            my handoffs (incoming|outgoing)        (messaging.read)
//   GET    /api/v1/messaging/handoffs/caseload                     my caseload patients to hand off      (messaging.read + patient.read)
//   POST   /api/v1/messaging/handoffs/prefill                      open work for chosen patients (read)  (messaging.send + patient.read)
//   POST   /api/v1/messaging/handoffs                              offer a handoff                       (messaging.send + patient.read)
//   GET    /api/v1/messaging/handoffs/policy                       the effective expiry policy           (messaging.send)
//   GET    /api/v1/messaging/handoffs/:handoffId                   one handoff with its items            (messaging.read + patient.read)
//   POST   /api/v1/messaging/handoffs/:handoffId/{accept,decline,cancel}                                 (messaging.send + patient.read)
//   PUT|DELETE /api/v1/messaging/template-admin/handoff-policy     tighten-only tenant expiry            (messaging.template.manage)
//
// The tenant flag `messaging.handoffs` gates every route: off => the uniform 404 on every single-resource, write, caseload,
// prefill and policy-read route, and the list answers 200 `{enabled:false,handoffs:[]}` so the web can hide the UI. Org and
// actor are always the request context. Participant rules (sender or recipient only) live in the service: a missing handoff
// and a non-participant are ONE 404. No `Idempotency-Key`: idempotency is the partial unique index (one open offer per
// sender and receiver), so no request header is read here.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HandoffActorRef, HandoffService } from "../handoffs/handoff-service";
import {
  AcceptHandoffBodySchema,
  DeclineHandoffBodySchema,
  HandoffParamsSchema,
  ListHandoffsQuerySchema,
  OfferHandoffBodySchema,
  PrefillBodySchema,
  PutHandoffPolicyBodySchema,
} from "./handoff-typebox";
import { parse } from "./messaging-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const HANDOFF_LIST_DEFAULTS = { scope: "incoming", state: "active", limit: 50 } as const;

export interface HandoffRouteDeps {
  /** The tenant flag `messaging.handoffs`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: HandoffService;
}

/** The channel guards `registerMessagingRoutes` already built (passed in to avoid an import cycle). */
export interface HandoffRouteGuards {
  readonly read: PreHandler;
  readonly send: PreHandler;
}

const OFF = async (): Promise<never> => {
  throw new Error("handoffs are not bound");
};

/** Used when the boot supplies none: flag off, so every route 404s and the list answers disabled. */
export const DISABLED_HANDOFFS: HandoffRouteDeps = {
  isEnabled: async () => false,
  service: {
    caseload: OFF,
    prefill: OFF,
    offer: OFF,
    get: OFF,
    list: OFF,
    accept: OFF,
    decline: OFF,
    cancel: OFF,
    policy: OFF,
    setPolicy: OFF,
    clearPolicy: OFF,
  },
};

const notFound = (): NotFoundError => new NotFoundError("clinical_handoff");

function actorOf(request: FastifyRequest): HandoffActorRef {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { orgId: ctx.organizationId, userId: ctx.userId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed handoff id is the same 404 a missing handoff gets (never a uuid-cast 500). */
const handoffIdParam: PreHandler = async (request) => {
  const handoffId = (request.params as { handoffId?: unknown } | undefined)?.handoffId;
  if (typeof handoffId !== "string" || !UUID.test(handoffId)) throw notFound();
};

export function registerHandoffRoutes(
  app: FastifyInstance,
  deps: HandoffRouteDeps,
  guards: HandoffRouteGuards,
): void {
  const { service } = deps;
  const PATIENT_READ = requirePermission("patient.read") as PreHandler;
  const MANAGE = requirePermission("messaging.template.manage") as PreHandler;
  const flagOn = (orgId: string): Promise<boolean> => deps.isEnabled(orgId).catch(() => false);
  const requireFlag = async (actor: HandoffActorRef): Promise<void> => {
    if (!(await flagOn(actor.orgId))) throw notFound();
  };
  // Every route that answers patient labels re-checks `patient.read` (a viewer who lost it must not read the handoff).
  const readOne = [handoffIdParam, guards.read, PATIENT_READ];
  const writeOne = [handoffIdParam, guards.send, PATIENT_READ];
  // POST replies carry patient labels too and the read-audit plugin emits on any route that declares this config (it only
  // GOVERNS GET/HEAD): one event per distinct patient disclosed, against the handoff the reply is about.
  const postAudit = {
    auditRead: {
      resourceKind: "clinical_handoff",
      resourceIdPayloadPath: "handoff.id",
      patientIdsPayload: { path: "handoff.items", key: "patient_id" },
    },
  } as const;

  app.get(
    "/api/v1/messaging/handoffs",
    {
      preHandler: [guards.read],
      config: { auditRead: { resourceKind: "clinical_handoff", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      if (!(await flagOn(actor.orgId))) return { enabled: false, handoffs: [] };
      const q = parse(ListHandoffsQuerySchema, request.query);
      const handoffs = await service.list(actor, {
        scope: q.scope ?? HANDOFF_LIST_DEFAULTS.scope,
        state: q.state ?? HANDOFF_LIST_DEFAULTS.state,
        limit: q.limit ?? HANDOFF_LIST_DEFAULTS.limit,
      });
      return { enabled: true, handoffs };
    },
  );

  // Static paths are registered before `/handoffs/:handoffId`.
  app.get(
    "/api/v1/messaging/handoffs/caseload",
    {
      preHandler: [guards.read, PATIENT_READ],
      config: { auditRead: { resourceKind: "clinical_handoff_caseload", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      return { patients: await service.caseload(actor) };
    },
  );

  app.post(
    "/api/v1/messaging/handoffs/prefill",
    {
      preHandler: [guards.send, PATIENT_READ],
      config: {
        auditRead: {
          resourceKind: "clinical_handoff_prefill",
          patientIdPayloadPath: "patients.0.patient_id",
          patientIdsPayload: { path: "patients", key: "patient_id" },
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const body = parse(PrefillBodySchema, request.body);
      return service.prefill(actor, body.patient_ids);
    },
  );

  app.post(
    "/api/v1/messaging/handoffs",
    { preHandler: [guards.send, PATIENT_READ], config: postAudit },
    async (request, reply) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const body = parse(OfferHandoffBodySchema, request.body);
      const result = await service.offer(actor, { toUserId: body.to_user_id, items: body.items });
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.get(
    "/api/v1/messaging/handoffs/policy",
    {
      preHandler: [guards.send],
      config: {
        auditRead: { none: "Handoff policy is organisation configuration: no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      return service.policy(actor);
    },
  );

  app.get(
    "/api/v1/messaging/handoffs/:handoffId",
    {
      preHandler: readOne,
      config: {
        // A handoff discloses up to 50 patients: the read is accounted against EACH of them (one event per patient).
        auditRead: {
          resourceKind: "clinical_handoff",
          resourceIdParam: "handoffId",
          patientIdsPayload: { path: "handoff.items", key: "patient_id" },
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { handoffId } = parse(HandoffParamsSchema, request.params);
      return { handoff: await service.get(actor, handoffId) };
    },
  );

  app.post(
    "/api/v1/messaging/handoffs/:handoffId/accept",
    { preHandler: writeOne, config: postAudit },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { handoffId } = parse(HandoffParamsSchema, request.params);
      const body = parse(AcceptHandoffBodySchema, request.body);
      return { handoff: await service.accept(actor, handoffId, body.item_ids) };
    },
  );

  app.post(
    "/api/v1/messaging/handoffs/:handoffId/decline",
    { preHandler: writeOne, config: postAudit },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { handoffId } = parse(HandoffParamsSchema, request.params);
      const body = parse(DeclineHandoffBodySchema, request.body ?? {});
      return { handoff: await service.decline(actor, handoffId, body.item_ids) };
    },
  );

  app.post(
    "/api/v1/messaging/handoffs/:handoffId/cancel",
    { preHandler: writeOne, config: postAudit },
    async (request) => {
      const actor = actorOf(request);
      await requireFlag(actor);
      const { handoffId } = parse(HandoffParamsSchema, request.params);
      return { handoff: await service.cancel(actor, handoffId) };
    },
  );

  app.put(
    "/api/v1/messaging/template-admin/handoff-policy",
    { preHandler: [MANAGE] },
    async (request) => {
      const body = parse(PutHandoffPolicyBodySchema, request.body);
      return service.setPolicy(actorOf(request), body.expiry_minutes);
    },
  );

  app.delete(
    "/api/v1/messaging/template-admin/handoff-policy",
    { preHandler: [MANAGE] },
    async (request) => service.clearPolicy(actorOf(request)),
  );
}
