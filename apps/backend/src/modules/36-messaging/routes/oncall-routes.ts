// apps/backend/src/modules/36-messaging/routes/oncall-routes.ts - WP 4.12 (ADR-0080).
//
//   GET /api/v1/messaging/oncall/coverage?role&patient_id   who is covering now for a role (read-only; messaging.read + messaging.oncall.read)
//
// Read-only: nothing is paged, sent or written. The org and the caller come from the request context, never the query. The tenant flag
// `messaging.oncall_directory` off is the uniform 404 (decided in the service, before any router call). Responses are never cached
// (who is covering changes at a shift boundary).
import { requirePermission } from "@wardenx/auth";
import { NotFoundError, type OnCallDirectoryRole, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OnCallCoverageService } from "../oncall-directory/oncall-coverage-service";
import { parse } from "./messaging-typebox";
import { OnCallCoverageQuerySchema, OnCallCoverageResponseSchema } from "./oncall-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OnCallRouteDeps {
  readonly service: OnCallCoverageService;
}

/** Used when the boot supplies none: the uniform 404. */
export const DISABLED_ONCALL: OnCallRouteDeps = {
  service: {
    get: async () => {
      throw new NotFoundError("oncall directory");
    },
  },
};

export function registerOnCallRoutes(
  app: FastifyInstance,
  deps: OnCallRouteDeps,
  guards: { readonly read: PreHandler },
): void {
  const ONCALL = requirePermission("messaging.oncall.read") as PreHandler;
  app.get(
    "/api/v1/messaging/oncall/coverage",
    {
      preHandler: [guards.read, ONCALL],
      schema: { response: { 200: OnCallCoverageResponseSchema } },
      config: {
        auditRead: {
          none: "staff names and roles on a roster; no patient data is read or returned (the patient id only selects the team)",
        },
      },
    },
    async (request, reply) => {
      const ctx = request.context;
      if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
      const q = parse(OnCallCoverageQuerySchema, request.query);
      const out = await deps.service.get(
        { orgId: ctx.organizationId },
        { role: q.role as OnCallDirectoryRole, patientId: q.patient_id },
      );
      return reply.header("Cache-Control", "no-store").send(out);
    },
  );
}
