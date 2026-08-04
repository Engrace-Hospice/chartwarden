// apps/backend/src/modules/29-external-interfaces/routes/message.routes.ts — §4.1.3 HL7 message search /
// replay / retry / decrypt.
//
// Search + single-read surface the stored HL7 wire metadata (NEVER the raw payload — that is the dedicated
// step-up decrypt route). Replay re-enqueues a parse_error/rejected inbound message; retry re-queues a
// failed/dlq outbound message (D9). The compliance decrypt of a stored payload needs the per-tenant DEK,
// which no module binds in Phase 1, so it fails closed with a typed 501 (honest "not yet", not a 404).
import type { FastifyInstance } from "fastify";

import { actorOf, writeActorOf } from "./actor";
import { ABAC_IN_ORG, P, STEP_UP } from "./guards";
import { InboundMessageListQuery, OutboundMessageListQuery, parseQuery } from "./m29-typebox";
import { type M29Store, M29StoreError } from "./store";

export interface MessageRouteDeps {
  readonly store: M29Store;
}

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  const { store } = deps;

  // GET /messages/inbound — search inbound messages (metadata only).
  app.get(
    "/api/admin/external-interfaces/messages/inbound",
    {
      preHandler: [
        P("external_interfaces.message.read"),
        ABAC_IN_ORG("external_interfaces.message.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parseQuery(InboundMessageListQuery, request.query);
      return store.listInboundMessages(actor.organizationId, {
        feedId: q.feedId,
        messageType: q.messageType,
        messageControlId: q.messageControlId,
        parseStatus: q.parseStatus,
        limit: q.limit,
        cursor: q.cursor,
      });
    },
  );

  // GET /messages/inbound/:messageId — single inbound message (metadata only).
  app.get(
    "/api/admin/external-interfaces/messages/inbound/:messageId",
    {
      preHandler: [
        P("external_interfaces.message.read"),
        ABAC_IN_ORG("external_interfaces.message.read"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { messageId } = request.params as { messageId: string };
      const message = await store.getInboundMessage(actor.organizationId, messageId);
      if (!message)
        return reply.code(404).send({ code: "NOT_FOUND", message: "message not found" });
      return { message };
    },
  );

  // POST /messages/inbound/:messageId/decrypt — server-side plaintext for review (step-up; disclosure).
  app.post(
    "/api/admin/external-interfaces/messages/inbound/:messageId/decrypt",
    {
      preHandler: [
        P("external_interfaces.message.read_plaintext"),
        STEP_UP("external_interfaces.message.read_plaintext"),
        ABAC_IN_ORG("external_interfaces.message.read_plaintext"),
      ],
    },
    async (request) => {
      // Establish the accountable actor + message before failing closed (the disclosure audit anchors here).
      const actor = writeActorOf(request);
      const { messageId } = request.params as { messageId: string };
      const message = await store.getInboundMessage(actor.organizationId, messageId);
      if (!message) {
        throw new M29StoreError(`hl7_message_inbound ${messageId} not found`, 404);
      }
      throw new M29StoreError(
        "server-side HL7 payload decryption requires the per-tenant DEK envelope, unbound in Phase 1",
      );
    },
  );

  // POST /messages/inbound/:messageId/replay — re-enqueue a parse_error/rejected message (step-up).
  app.post(
    "/api/admin/external-interfaces/messages/inbound/:messageId/replay",
    {
      preHandler: [
        P("external_interfaces.message.replay"),
        STEP_UP("external_interfaces.message.replay"),
        ABAC_IN_ORG("external_interfaces.message.replay"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { messageId } = request.params as { messageId: string };
      const message = await store.replayInboundMessage(
        actor.organizationId,
        actor.membershipId,
        messageId,
      );
      return { message };
    },
  );

  // GET /messages/outbound — search outbound messages.
  app.get(
    "/api/admin/external-interfaces/messages/outbound",
    {
      preHandler: [
        P("external_interfaces.message.read"),
        ABAC_IN_ORG("external_interfaces.message.read"),
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parseQuery(OutboundMessageListQuery, request.query);
      return store.listOutboundMessages(actor.organizationId, {
        feedId: q.feedId,
        placerOrderNumber: q.placerOrderNumber,
        status: q.status,
        limit: q.limit,
        cursor: q.cursor,
      });
    },
  );

  // GET /messages/outbound/:messageId — single outbound message (incl. ACK/NACK chain).
  app.get(
    "/api/admin/external-interfaces/messages/outbound/:messageId",
    {
      preHandler: [
        P("external_interfaces.message.read"),
        ABAC_IN_ORG("external_interfaces.message.read"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { messageId } = request.params as { messageId: string };
      const message = await store.getOutboundMessage(actor.organizationId, messageId);
      if (!message)
        return reply.code(404).send({ code: "NOT_FOUND", message: "message not found" });
      return { message };
    },
  );

  // POST /messages/outbound/:messageId/retry — manual retry after a DLQ landing (step-up).
  app.post(
    "/api/admin/external-interfaces/messages/outbound/:messageId/retry",
    {
      preHandler: [
        P("external_interfaces.message.retry"),
        STEP_UP("external_interfaces.message.retry"),
        ABAC_IN_ORG("external_interfaces.message.retry"),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { messageId } = request.params as { messageId: string };
      const message = await store.retryOutboundMessage(
        actor.organizationId,
        actor.membershipId,
        messageId,
      );
      return { message };
    },
  );
}
