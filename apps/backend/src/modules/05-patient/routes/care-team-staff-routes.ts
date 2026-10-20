// apps/backend/src/modules/05-patient/routes/care-team-staff-routes.ts — the narrow, read-only staff
// lookup the care-team assign dialog needs (demo finding 2).
//
//   GET /api/v1/orgs/:id/care-team-staff   patient.assign   (org-bound; ?q=<name>&limit=<1..200>)
//
// Gated by `patient.assign` — exactly the permission `POST /patients/:id/assignments` requires — so it is
// reachable by the roles that can already assign and by nobody else. It returns an allowlist (user /
// membership id, display name, role labels); `/orgs/:id/members` keeps its `member.manage` gate and its
// email / username / login fields. Not a PHI read (staff directory, no patient id), so no read-audit
// config; the bound org is asserted before any query.
import { requirePermission } from "@wardenx/auth";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CareTeamStaffPort } from "../care-team-staff";
import {
  CareTeamStaffListResponseSchema,
  CareTeamStaffParamsSchema,
  CareTeamStaffQuerySchema,
} from "./care-team-staff-typebox";
import { parse } from "./patient-typebox";

const DEFAULT_LIMIT = 25;

function boundOrg(request: FastifyRequest, pathOrgId: string): void {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  if (ctx.organizationId !== pathOrgId) {
    throw new WardenXError("FORBIDDEN", "care-team lookups are scoped to the bound org", 403);
  }
}

export interface CareTeamStaffRouteDeps {
  readonly staff: CareTeamStaffPort;
}

export function registerCareTeamStaffRoutes(
  app: FastifyInstance,
  deps: CareTeamStaffRouteDeps,
): void {
  app.get(
    "/api/v1/orgs/:id/care-team-staff",
    { preHandler: [requirePermission("patient.assign") as never] },
    async (request) => {
      const { id } = parse(CareTeamStaffParamsSchema, request.params);
      boundOrg(request, id);
      const query = parse(CareTeamStaffQuerySchema, request.query);
      const q = query.q?.trim() || undefined;
      const rows = await deps.staff.search(id, { q, limit: query.limit ?? DEFAULT_LIMIT });
      // Re-project to the allowlist so a future adapter cannot widen the wire shape by accident.
      const body = {
        staff: rows.map((r) => ({
          userId: r.userId,
          membershipId: r.membershipId,
          displayName: r.displayName,
          roleLabels: [...r.roleLabels],
        })),
      };
      return parse(CareTeamStaffListResponseSchema, body);
    },
  );
}
