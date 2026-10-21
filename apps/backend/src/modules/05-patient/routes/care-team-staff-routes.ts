// apps/backend/src/modules/05-patient/routes/care-team-staff-routes.ts — the narrow, read-only staff
// lookup the care-team assign dialog needs (demo finding 2).
//
//   GET /api/v1/orgs/:id/care-team-staff   patient.assign | idg.read   (org-bound; ?q=<name>&limit=<1..200>)
//
// Gated by `patient.assign` — exactly the permission `POST /patients/:id/assignments` requires — OR
// `idg.read`, so the IDG screens can name attendees and pick an action-item assignee without
// `member.manage` (demo M4, items 18/19). Nobody else can reach it. It returns an allowlist (user /
// membership id, display name, role labels); `/orgs/:id/members` keeps its `member.manage` gate and its
// email / username / login fields. Not a PHI read (staff directory, no patient id), so no read-audit
// config; the bound org is asserted before any query.
import { resolveActorPermissions } from "@wardenx/auth";
import { ForbiddenError, UnauthorizedError, ChartWardenError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CareTeamStaffPort } from "../care-team-staff";
import {
  CareTeamStaffListResponseSchema,
  CareTeamStaffParamsSchema,
  CareTeamStaffQuerySchema,
} from "./care-team-staff-typebox";
import { parse } from "./patient-typebox";

const DEFAULT_LIMIT = 25;

/** Permissions that may read the name-only staff directory: assigning a care team, or attending IDG. */
const STAFF_DIRECTORY_PERMISSIONS = ["patient.assign", "idg.read"] as const;

async function requireStaffDirectoryAccess(request: FastifyRequest): Promise<void> {
  const ctx = request.context;
  if (!ctx?.organizationId) throw new UnauthorizedError();
  const granted = await resolveActorPermissions(ctx);
  if (!STAFF_DIRECTORY_PERMISSIONS.some((key) => granted.has(key))) {
    throw new ForbiddenError(`requires permission '${STAFF_DIRECTORY_PERMISSIONS.join("' or '")}'`);
  }
}

function boundOrg(request: FastifyRequest, pathOrgId: string): void {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  if (ctx.organizationId !== pathOrgId) {
    throw new ChartWardenError("FORBIDDEN", "care-team lookups are scoped to the bound org", 403);
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
    { preHandler: [requireStaffDirectoryAccess as never] },
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
