// apps/backend/src/modules/33-reporting/routes/messaging-response-analytics.routes.ts - M33 serving M36 WP 6.2 (ADR-0092).
//
//   GET /api/v1/messaging/analytics/response?from&to&groupBy=class|discipline   (messaging.analytics.read)
// The window is snapped server-side to COMPLETED whole UTC days (analytics-window.ts): sub-day input cannot isolate a few requests and
// the current, still-growing day is never served.
//
// The numbers come from M36 over its published `MessagingResponseAnalyticsReader` seam (no import edge, no cross-module table read);
// this route only gates, bounds the window and hands the answer back. AGGREGATES ONLY: the contract has no person, patient or content
// field, and small groups are held back by the reader. Org and actor are the server-side request context, never the query.
// Tenant flag `messaging.response_analytics` off (or absent) is a uniform 404, the same answer for any unknown route: it is checked BEFORE
// the query is parsed, so an invalid query cannot tell a flag-off tenant from a flag-on one. Responses are `Cache-Control: no-store`.
// An optional per-route rate limit (a modest per-user/per-org cap, see ANALYTICS_RESPONSE_ROUTE_RATE_LIMIT) runs after the permission.
import { requirePermission } from "@chartwarden/auth";
import {
  ANALYTICS_MIN_COHORT,
  NotFoundError,
  RESPONSE_ANALYTICS_PERMISSION,
} from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { type PreHandler, actorOf } from "./actor";
import { resolveAnalyticsWindow } from "./analytics-window";
import { ResponseAnalyticsQuerySchema } from "./messaging-response-analytics-typebox";
import { parse } from "./reporting-typebox";

const READ = requirePermission(RESPONSE_ANALYTICS_PERMISSION) as PreHandler;

export function registerMessagingResponseAnalyticsRoutes(
  app: FastifyInstance,
  opts: { readonly rateLimit?: PreHandler } = {},
): void {
  app.get(
    "/api/v1/messaging/analytics/response",
    {
      preHandler: [READ, ...(opts.rateLimit ? [opts.rateLimit] : [])],
      config: {
        auditRead: {
          none: "aggregate counts, rates and durations only: no patient, no person, no message content; groups under the minimum cohort are withheld",
        },
      },
    },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const reader = getSeam("MessagingResponseAnalyticsReader");
      if (!(await reader.enabled(organizationId))) throw new NotFoundError("Not found");
      const q = parse(ResponseAnalyticsQuerySchema, request.query);
      void reply.header("Cache-Control", "no-store");
      const window = resolveAnalyticsWindow(q, new Date());
      // No completed UTC day in the window (only today, or the future): nothing is served, the same answer as too little data.
      if (!window) return { status: "insufficient_data", minCohort: ANALYTICS_MIN_COHORT };
      return reader.report(organizationId, { ...window, groupBy: q.groupBy ?? "class" });
    },
  );
}
