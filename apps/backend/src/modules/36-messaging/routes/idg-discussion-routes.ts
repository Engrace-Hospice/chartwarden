// apps/backend/src/modules/36-messaging/routes/idg-discussion-routes.ts - WP 3.6 IDG discussions (READ ONLY).
//
//   GET /api/v1/messaging/channels/:id/idg-discussions?limit=
//
// Guards are EXACTLY the pin list's (`messaging.read` + `channel_visibility` on `:id`), so a non-member, a removed member,
// another organisation and a Part 2 denial all get the 404 a random id gets. The route returns hydrated messages (no
// patient labels), so no `patient.read` re-check is needed beyond what the care-team channel rule already enforces.
// Flag off => 200 { enabled:false }; the web reads that `enabled` (the web feature-flag hook is not wired, never use it).
// The list is a decrypted-body read, so it is read-audited as one aggregate list event carrying the channel's patient.
// Nothing here writes, publishes or reads a header; a message never marks an IDG meeting complete or changes a plan.
import type { ResolvedMessage } from "@chartwarden/messaging";
import { NotFoundError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdgDiscussionStore } from "../idg/idg-discussion-store-db";
import { IdgDiscussionQuerySchema } from "./idg-discussion-typebox";
import { ChannelParamsSchema, parse } from "./messaging-typebox";
import { requireUuidParams } from "./uuid-params";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const IDG_DISCUSSION_DEFAULT_LIMIT = 50;

export interface IdgDiscussionRouteDeps {
  /** `messaging.idg` AND `messaging.clinical_links`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly store: IdgDiscussionStore;
  readonly canViewChannel: (
    organizationId: string,
    userId: string,
    channelId: string,
  ) => Promise<boolean>;
}

export interface IdgDiscussionResponse {
  readonly enabled: boolean;
  readonly discussions: readonly ResolvedMessage[];
  readonly patientId: string | null;
}

/** Used when the boot supplies none: the flag reads off. */
export const DISABLED_IDG_DISCUSSIONS: IdgDiscussionRouteDeps = {
  isEnabled: async () => false,
  store: { list: async () => ({ discussions: [], patientId: null }) },
  canViewChannel: async () => false,
};

export function registerIdgDiscussionRoutes(
  app: FastifyInstance,
  guards: { readonly read: PreHandler; readonly viewChannel: PreHandler },
  deps: IdgDiscussionRouteDeps,
): void {
  app.get(
    "/api/v1/messaging/channels/:id/idg-discussions",
    {
      preHandler: [requireUuidParams("id"), guards.read, guards.viewChannel],
      config: {
        auditRead: { resourceKind: "message", list: true, patientIdPayloadPath: "patientId" },
      },
    },
    async (request): Promise<IdgDiscussionResponse> => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const { organizationId, userId } = ctx;
      const { id } = parse(ChannelParamsSchema, request.params);
      const limit =
        parse(IdgDiscussionQuerySchema, request.query).limit ?? IDG_DISCUSSION_DEFAULT_LIMIT;
      const enabled = await deps.isEnabled(organizationId).catch(() => false);
      if (!enabled) return { enabled: false, discussions: [], patientId: null };
      // Defence in depth: the guard already ran the same rule; re-run it so the route is correct without the guard.
      if (!(await deps.canViewChannel(organizationId, userId, id))) {
        throw new NotFoundError("channel", id);
      }
      const { discussions, patientId } = await deps.store.list(organizationId, {
        userId,
        channelId: id,
        limit,
      });
      return { enabled: true, discussions, patientId };
    },
  );
}
