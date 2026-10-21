// apps/backend/src/bootstrap/plugins/request-context.ts — M1 request-context middleware
// (spec §4.5; M1-T10).
//
// Opens a per-request `request.context` carrying the correlation id (echoed in the error
// envelope + every log line) and the request envelope (ip / user-agent / start time). The
// tenant/actor fields start empty here; M2's auth plugin fills userId / organizationId /
// roles AFTER this hook runs (spec §4.5). The HttpRequestContext type is the shared
// `@chartwarden/types` leaf shape, so every module's routes read `request.context` without a
// cross-module edge.
//
// Applied directly to the root instance (app.addHook), NOT registered as an encapsulated
// plugin — without `fastify-plugin` a registered plugin's hooks would not see routes in
// the parent scope. Applying on the root keeps the hook global.
import { randomUUID } from "node:crypto";
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { HttpRequestContext } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Per-request context (set by applyRequestContext's onRequest hook). */
    context: HttpRequestContext;
  }
}

export function applyRequestContext(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const headerCorrelation = request.headers["x-correlation-id"];
    const correlationId =
      typeof headerCorrelation === "string" && headerCorrelation.length > 0
        ? headerCorrelation
        : randomUUID();

    request.context = {
      correlationId,
      userId: "",
      organizationId: "",
      providerEntityIds: [],
      locationIds: [],
      roles: [],
      attributes: {},
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? "",
      startTime: Date.now(),
    };

    request.log = request.log.child({ correlationId, requestId: request.id });
  });

  // Make `request.context` the AMBIENT request context (AsyncLocalStorage) for the rest of the
  // request — authenticate (a later onRequest hook) mutates it in place with the tenant/actor, and
  // because the SAME object is stored, store reads via `withOrgContextFromRequest` see the live
  // org/user at query time. The callback (`done`) form keeps the context active across the async
  // continuation (subsequent hooks + the handler). Must run after the context-creation hook above.
  app.addHook("onRequest", (request, _reply, done) => {
    runWithRequestContext(request.context, () => done());
  });
}
