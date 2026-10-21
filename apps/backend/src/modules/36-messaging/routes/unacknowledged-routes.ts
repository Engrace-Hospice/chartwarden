// apps/backend/src/modules/36-messaging/routes/unacknowledged-routes.ts - WP 4.9 (ADR-0076).
//
//   GET /api/v1/messaging/escalations/unacknowledged?status&overdue&cursor&limit
//       the supervisor's queue of every acknowledgment request that still waits for a human (messaging.read + messaging.review)
//
// Read-only: no write, no event, nothing is acknowledged by looking. The default view is everything in the organisation; the only
// filters narrow by a field every row shows, and the response states the unfiltered total and whether the list is complete. A request
// the viewer may not see is a `restricted` row with no ids. A holder of messaging.read without messaging.review gets the contract's 403.
// Read-audit: one accounting event per distinct patient the page discloses (the list is a multi-patient single read), exactly as the
// lifecycle review queue, recorded against `audit_request_id` (the first request shown in full: a restricted row has no id, so
// "items.0.id" would be empty whenever the oldest request is one). A page that shows no request in full discloses nobody and emits
// nothing. No request header is read here.
import { requirePermission } from "@chartwarden/auth";
import { type AckQueueStatus, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UnacknowledgedService } from "../ack-requests/unacknowledged-service";
import { parse } from "./messaging-typebox";
import { UnacknowledgedQuerySchema, UnacknowledgedResponseSchema } from "./unacknowledged-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface UnacknowledgedRouteDeps {
  readonly service: UnacknowledgedService;
}

/** Used when the boot supplies none: nothing is waiting. */
export const DISABLED_UNACKNOWLEDGED: UnacknowledgedRouteDeps = {
  service: {
    list: async () => ({
      items: [],
      next_cursor: null,
      audit_request_id: null,
      complete: true,
      filtered: false,
      counts: { unfiltered: 0, matching: 0, overdue: 0, failed_unreachable: 0 },
    }),
  },
};

export function registerUnacknowledgedRoutes(
  app: FastifyInstance,
  deps: UnacknowledgedRouteDeps,
  guards: { readonly read: PreHandler },
): void {
  const REVIEW = requirePermission("messaging.review") as PreHandler;
  app.get(
    "/api/v1/messaging/escalations/unacknowledged",
    {
      preHandler: [guards.read, REVIEW],
      schema: { response: { 200: UnacknowledgedResponseSchema } },
      config: {
        auditRead: {
          resourceKind: "message_acknowledgment_request",
          resourceIdPayloadPath: "audit_request_id",
          patientIdsPayload: { path: "items", key: "patient_id" },
        },
      },
    },
    async (request) => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const q = parse(UnacknowledgedQuerySchema, request.query);
      // The schema admits only the three queue statuses; the typebox union is widened to string by its helper.
      return deps.service.list(
        { orgId: ctx.organizationId, userId: ctx.userId },
        { ...q, status: q.status as AckQueueStatus | undefined },
      );
    },
  );
}
