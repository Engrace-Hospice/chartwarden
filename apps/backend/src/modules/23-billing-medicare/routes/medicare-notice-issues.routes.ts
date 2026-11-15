import { resolveActorPermissions } from "@chartwarden/auth";
import {
  type PreHandler,
  actorOf,
  parse,
  rejectAiActor,
  requireIdempotencyKey,
} from "@chartwarden/shared/route-kit";
import { ForbiddenError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type {
  MedicareNoticeIssueType,
  MedicareNoticeOperationalIssueService,
} from "../services/medicare-notice-operational-issues";
import { writeActorOf } from "./actor";
import {
  MedicareNoticeIssueAssignBody,
  MedicareNoticeIssueHistoryResponse,
  MedicareNoticeIssueListQuery,
  MedicareNoticeIssueParams,
  MedicareNoticeIssueResponse,
  MedicareNoticeIssueVersionBody,
} from "./medicare-notice-issues-typebox";

const PERMISSION: Record<MedicareNoticeIssueType, string> = {
  noe: "billing.noe.read",
  notr: "billing.notr.read",
  transfer: "billing.noe.read",
  cancellation: "billing.noe.read",
};
const ACTION_PERMISSION: Record<MedicareNoticeIssueType, string> = {
  noe: "billing.noe.submit",
  notr: "billing.notr.submit",
  transfer: "billing.noe.submit",
  cancellation: "billing.noe.submit",
};
const typesFor = async (
  actor: Pick<ReturnType<typeof actorOf>, "organizationId" | "userId">,
  action = false,
): Promise<MedicareNoticeIssueType[]> => {
  const permissions = await resolveActorPermissions(actor);
  return (Object.keys(PERMISSION) as MedicareNoticeIssueType[]).filter((type) =>
    permissions.has(action ? ACTION_PERMISSION[type] : PERMISSION[type]),
  );
};
const NO_AI: PreHandler = rejectAiActor();
const IDEMPOTENT: PreHandler = requireIdempotencyKey();

export function registerMedicareNoticeIssueRoutes(
  app: FastifyInstance,
  service: MedicareNoticeOperationalIssueService,
): void {
  app.get(
    "/api/v1/billing/medicare-notice-issues",
    {
      schema: {
        querystring: MedicareNoticeIssueListQuery,
        response: { 200: Type.Array(MedicareNoticeIssueResponse) },
      },
      config: { auditRead: { resourceKind: "medicare_notice_operational_issue", list: true } },
    },
    async (request) => {
      const actor = actorOf(request);
      const noticeTypes = await typesFor(actor);
      if (!noticeTypes.length)
        throw new ForbiddenError("Medicare notice read permission is required");
      const query = parse(MedicareNoticeIssueListQuery, request.query);
      return service.list(actor, { status: query.status, limit: query.limit, noticeTypes });
    },
  );

  app.get(
    "/api/v1/billing/medicare-notice-issues/:id/history",
    {
      schema: {
        params: MedicareNoticeIssueParams,
        response: { 200: MedicareNoticeIssueHistoryResponse },
      },
      config: {
        auditRead: {
          resourceKind: "medicare_notice_operational_issue_event",
          resourceIdParam: "id",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const params = parse(MedicareNoticeIssueParams, request.params);
      const types = await typesFor(actor);
      if (!types.length) throw new ForbiddenError("Medicare notice read permission is required");
      return service.history(actor, params.id, types);
    },
  );

  app.post(
    "/api/v1/billing/medicare-notice-issues/:id/assign",
    {
      schema: {
        params: MedicareNoticeIssueParams,
        body: MedicareNoticeIssueAssignBody,
        response: { 200: MedicareNoticeIssueResponse },
      },
      preHandler: [NO_AI, IDEMPOTENT],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const params = parse(MedicareNoticeIssueParams, request.params);
      const body = parse(MedicareNoticeIssueAssignBody, request.body);
      const types = await typesFor(actor, true);
      if (!types.length)
        throw new ForbiddenError("Medicare notice work assignment permission is required");
      return service.assign(
        actor,
        params.id,
        body.assignedMembershipId,
        body.expectedVersion,
        types,
      );
    },
  );

  app.post(
    "/api/v1/billing/medicare-notice-issues/:id/acknowledge",
    {
      schema: {
        params: MedicareNoticeIssueParams,
        body: MedicareNoticeIssueVersionBody,
        response: { 200: MedicareNoticeIssueResponse },
      },
      preHandler: [NO_AI, IDEMPOTENT],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const params = parse(MedicareNoticeIssueParams, request.params);
      const body = parse(MedicareNoticeIssueVersionBody, request.body);
      const types = await typesFor(actor, true);
      if (!types.length) throw new ForbiddenError("Medicare notice work permission is required");
      return service.acknowledge(actor, params.id, body.expectedVersion, types);
    },
  );
}
