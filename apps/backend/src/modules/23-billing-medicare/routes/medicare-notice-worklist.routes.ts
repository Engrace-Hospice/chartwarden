import { resolveActorPermissions } from "@chartwarden/auth";
import { actorOf, parse } from "@chartwarden/shared/route-kit";
import { ForbiddenError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import type { MedicareNoticeWorklistType, MedicareNoticeWorklistService } from "./medicare-notice-worklist";
import { MedicareNoticeWorklistQuerySchema, MedicareNoticeWorklistResponseSchema } from "./medicare-notice-worklist-typebox";

const permissionByType: Record<MedicareNoticeWorklistType, string> = {
  noe: "billing.noe.read", transfer: "billing.noe.read", cancellation: "billing.noe.read", notr: "billing.notr.read",
};

export function registerMedicareNoticeWorklistRoutes(app: FastifyInstance, service: MedicareNoticeWorklistService): void {
  app.get("/api/v1/billing/medicare-notice-worklist", {
    schema: { querystring: MedicareNoticeWorklistQuerySchema, response: { 200: MedicareNoticeWorklistResponseSchema } },
    config: { auditRead: { resourceKind: "medicare_notice_worklist", list: true } },
  }, async (request) => {
    const actor = actorOf(request);
    const permissions = await resolveActorPermissions(actor);
    const permittedTypes = (Object.keys(permissionByType) as MedicareNoticeWorklistType[])
      .filter((type) => permissions.has(permissionByType[type]));
    if (permittedTypes.length === 0) throw new ForbiddenError("Medicare notice read permission is required");
    const q = parse(MedicareNoticeWorklistQuerySchema, request.query);
    if (q.eventFrom && q.eventTo && q.eventFrom > q.eventTo) {
      throw new ValidationError("eventFrom must not be after eventTo", [{ code: "invalid", message: "eventFrom must not be after eventTo" }]);
    }
    const result = await service.list(actor, {
      ...(q.type ? { types: q.type } : {}),
      ...(q.providerEntityId ? { providerEntityId: q.providerEntityId } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.admissionId ? { admissionId: q.admissionId } : {}),
      ...(q.state ? { state: q.state } : {}),
      ...(q.eventFrom ? { eventFrom: q.eventFrom } : {}),
      ...(q.eventTo ? { eventTo: q.eventTo } : {}),
      ...(q.deadlineRisk ? { deadlineRisk: q.deadlineRisk } : {}),
      ...(q.readiness ? { readiness: q.readiness } : {}),
      ...(q.requiresAttention !== undefined ? { requiresAttention: q.requiresAttention } : {}),
      ...(q.exceptionReviewStatus ? { exceptionReviewStatus: q.exceptionReviewStatus } : {}),
    }, permittedTypes, q.cursor, q.limit);
    return result;
  });
}
