// apps/backend/src/modules/33-reporting/routes/messaging-response-analytics.routes.ts - M33 serving M36 WP 6.2 (ADR-0110).
//
//   GET /api/v1/messaging/analytics/response?from&to&groupBy=class|discipline   (messaging.analytics.read)
// The window is snapped server-side to whole UTC days (analytics-window.ts) so sub-day input cannot isolate a few requests.
//
// The numbers come from M36 over its published `MessagingResponseAnalyticsReader` seam (no import edge, no cross-module table read);
// this route only gates, bounds the window and hands the answer back. AGGREGATES ONLY: the contract has no person, patient or content
// field, and small groups are held back by the reader. Org and actor are the server-side request context, never the query.
// Tenant flag `messaging.response_analytics` off (or absent) is a uniform 404, the same answer for any unknown route.
import { requirePermission } from "@chartwarden/auth";
import { NotFoundError, RESPONSE_ANALYTICS_PERMISSION } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../../bootstrap/index";
import { type PreHandler, actorOf } from "./actor";
import { resolveAnalyticsWindow } from "./analytics-window";
import { ResponseAnalyticsQuerySchema } from "./messaging-response-analytics-typebox";
import { parse } from "./reporting-typebox";

const READ = requirePermission(RESPONSE_ANALYTICS_PERMISSION) as PreHandler;

export function registerMessagingResponseAnalyticsRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/messaging/analytics/response",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          none: "aggregate counts, rates and durations only: no patient, no person, no message content; groups under the minimum cohort are withheld",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(ResponseAnalyticsQuerySchema, request.query);
      const reader = getSeam("MessagingResponseAnalyticsReader");
      if (!(await reader.enabled(organizationId))) throw new NotFoundError("Not found");
      const { from, to } = resolveAnalyticsWindow(q, new Date());
      return reader.report(organizationId, { from, to, groupBy: q.groupBy ?? "class" });
    },
  );
}
