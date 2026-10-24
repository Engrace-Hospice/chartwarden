// apps/backend/src/modules/36-messaging/routes/external-share-routes.ts - WP 6.6 (ADR-0096, PROPOSED): external partner share.
//
// STAFF (a workforce session; messaging.share.manage):
//   POST   /api/v1/messaging/external-shares        create  (permission + the tenant flag + a fresh step-up); the invite token and the code are returned ONCE
//   GET    /api/v1/messaging/external-shares        list    (permission; never depends on the flag)
//   DELETE /api/v1/messaging/external-shares/:id    revoke  (permission + a fresh step-up; never depends on the flag); the partner's next request is a 404
//
// PARTNER (NOT a user session: a bearer minted by redeeming a one-time invitation; ADR-0096 D5). Every route answers the uniform 404 when the
// flag is off, the bearer is unknown/expired/revoked, or the share id is not the bearer's own. These routes read the Authorization header, which is a
// SERVER-minted, hash-checked single-share token, never a claim (arch:request-header-auth: verified).
//   POST /api/v1/messaging/partner/redeem                       invitation -> enrolment-stage bearer (single use; budgeted per client address)
//   GET  /api/v1/messaging/partner/shares/:shareId              state (enrolment or active)
//   POST /api/v1/messaging/partner/shares/:shareId/verify       the out-of-band 8-digit code -> active (5 attempts per share)
//   GET  /api/v1/messaging/partner/shares/:shareId/messages     the shared conversation, oldest first, active stage only; every read leaves a trail row
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import {
  EXTERNAL_SHARE_MANAGE_PERMISSION,
  EXTERNAL_SHARE_MANAGE_STEP_UP_KEY,
  NotFoundError,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ExternalShareService } from "../external-share/external-share-service";
import {
  CreateExternalShareBodySchema,
  CreatedExternalShareResponseSchema,
  ExternalShareIdParamsSchema,
  ExternalShareListResponseSchema,
  ExternalShareResponseSchema,
  PartnerMessagesResponseSchema,
  PartnerRedeemBodySchema,
  PartnerRedeemResponseSchema,
  PartnerShareParamsSchema,
  PartnerStateResponseSchema,
  PartnerVerifiedResponseSchema,
} from "./external-share-typebox";
import { parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MANAGE = requirePermission(EXTERNAL_SHARE_MANAGE_PERMISSION) as PreHandler;
const MANAGE_STEP_UP = requireStepUp(EXTERNAL_SHARE_MANAGE_STEP_UP_KEY) as PreHandler;

export interface ExternalShareRouteDeps {
  readonly service: ExternalShareService;
  /**
   * D17: false => the PARTNER routes are not mounted (they answer the framework's 404) because per-address budgets would be keyed on a proxy address.
   * Staff create, list, reissue and revoke are always mounted. Default true.
   */
  readonly partnerRoutes?: boolean | undefined;
}

function staffOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** `Authorization: Bearer <orgId>.<token>`; anything else is "no bearer" (the service answers the uniform 404). */
function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/** A malformed share id is the same 404 a random one gets, BEFORE the schema can answer 422 (no id-shape oracle on the partner surface). */
const SHARE_ID_OK: PreHandler = async (request) => {
  const id = (request.params as { shareId?: unknown } | undefined)?.shareId;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new NotFoundError("share");
  }
};

export function registerExternalShareRoutes(
  app: FastifyInstance,
  deps: ExternalShareRouteDeps,
): void {
  const { service } = deps;
  const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");

  /** Off => the uniform 404, before the step-up is asked for. */
  const FLAG_ON: PreHandler = async (request) => {
    if (!(await service.isEnabled(staffOf(request).organizationId)))
      throw new NotFoundError("conversation");
  };

  app.post(
    "/api/v1/messaging/external-shares",
    {
      preHandler: [MANAGE, FLAG_ON, MANAGE_STEP_UP],
      schema: { response: { 201: CreatedExternalShareResponseSchema } },
    },
    async (request, reply) => {
      const body = parse(CreateExternalShareBodySchema, request.body);
      return noStore(reply)
        .code(201)
        .send(await service.create(staffOf(request), body));
    },
  );

  app.get(
    "/api/v1/messaging/external-shares",
    {
      preHandler: [MANAGE],
      schema: { response: { 200: ExternalShareListResponseSchema } },
      config: {
        auditRead: {
          none: "Share rows: ids, a partner label, a closed kind and status, the conversation title and instants. No message, no token, no code, no BAA reference",
        },
      },
    },
    async (request, reply) => noStore(reply).send({ shares: await service.list(staffOf(request)) }),
  );

  app.delete(
    "/api/v1/messaging/external-shares/:id",
    {
      preHandler: [requireUuidParams("id"), MANAGE, MANAGE_STEP_UP],
      schema: { response: { 200: ExternalShareResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(ExternalShareIdParamsSchema, request.params);
      return noStore(reply).send(await service.revoke(staffOf(request), id));
    },
  );

  app.post(
    "/api/v1/messaging/external-shares/:id/reissue",
    {
      preHandler: [requireUuidParams("id"), MANAGE, FLAG_ON, MANAGE_STEP_UP],
      schema: { response: { 200: CreatedExternalShareResponseSchema } },
    },
    async (request, reply) => {
      const { id } = parse(ExternalShareIdParamsSchema, request.params);
      return noStore(reply).send(await service.reissue(staffOf(request), id));
    },
  );

  if (deps.partnerRoutes === false) return;

  // ADR-0096 D23: EVERY partner response is uncacheable, refusals included. The handlers set no-store on success, but a thrown 404/422/429 is built by
  // the error handler, and a 404 is heuristically cacheable by a browser or a shared proxy. The path test keeps the hook off every other route.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1/messaging/partner/"))
      reply.header("Cache-Control", "no-store");
    return payload;
  });

  // ── partner surface ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/messaging/partner/redeem",
    { schema: { response: { 200: PartnerRedeemResponseSchema } } },
    async (request, reply) => {
      const body = parse(PartnerRedeemBodySchema, request.body);
      const redeemed = await service.redeem(body, { ip: request.ip || "unknown" });
      return noStore(reply).send(redeemed);
    },
  );

  app.get(
    "/api/v1/messaging/partner/shares/:shareId",
    {
      preHandler: [SHARE_ID_OK],
      schema: { response: { 200: PartnerStateResponseSchema } },
      config: {
        auditRead: {
          none: "The partner's own share state: an id, a stage, the partner label and an expiry. No message and no staff identity; the principal is a partner bearer, not a user",
        },
      },
    },
    async (request, reply) => {
      const { shareId } = parse(PartnerShareParamsSchema, request.params);
      return noStore(reply).send(
        await service.state(bearerOf(request), shareId, { ip: request.ip || "unknown" }),
      );
    },
  );

  app.post(
    "/api/v1/messaging/partner/shares/:shareId/verify",
    { preHandler: [SHARE_ID_OK], schema: { response: { 200: PartnerVerifiedResponseSchema } } },
    async (request, reply) => {
      const { shareId } = parse(PartnerShareParamsSchema, request.params);
      return noStore(reply).send(
        await service.verify(bearerOf(request), shareId, request.body, {
          ip: request.ip || "unknown",
        }),
      );
    },
  );

  app.get(
    "/api/v1/messaging/partner/shares/:shareId/messages",
    {
      preHandler: [SHARE_ID_OK],
      schema: { response: { 200: PartnerMessagesResponseSchema } },
      config: {
        auditRead: {
          none: "Records its OWN per-read trail row (message_external_share_read, audited by trigger) in the same transaction, fail closed; the principal is a partner bearer, not a user",
        },
      },
    },
    async (request, reply) => {
      const { shareId } = parse(PartnerShareParamsSchema, request.params);
      return noStore(reply)
        .header("X-Content-Type-Options", "nosniff")
        .send(
          await service.messages(bearerOf(request), shareId, request.query, {
            ip: request.ip || "unknown",
          }),
        );
    },
  );
}
