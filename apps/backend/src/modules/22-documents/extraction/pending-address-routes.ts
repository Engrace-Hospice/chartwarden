import { type Static, Type } from "@sinclair/typebox";
// apps/backend/src/modules/22-documents/extraction/pending-address-routes.ts — F-238:
//
//   GET /api/v1/patients/:patientId/intake-pending-address
//        the patient's open intake batches holding an extracted residence address that has not reached the
//        chart yet (undecided, or approved in a review not completed) — newest first, at most 3, with
//        COUNTS and batch ids/status only. Never a value: the admission screen links to the review.
//
// Authorization: a CHART read (`patient.read` + `caseload_or_scope`, 404 outside scope — the same gate as
// `/intake-summaries`) AND `intake.read`, since the answer says which intake batches exist for the patient
// (the same permission the intake queue and the referral's Records tab need). A caller without `intake.read`
// gets a plain 403 and the screen shows nothing.
import { type GuardRequest, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse } from "../routes/documents-typebox";
import type { PendingAddressService } from "./pending-address-db";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const PendingAddressResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      batchId: Type.String({ format: "uuid" }),
      batchStatus: Type.String(),
      uploadedAt: Type.String(),
      reviewStatus: Type.Union([Type.Literal("not_started"), Type.Literal("in_progress")]),
      pendingCount: Type.Integer({ minimum: 0 }),
      approvedCount: Type.Integer({ minimum: 0 }),
    }),
  ),
  totalBatches: Type.Integer({ minimum: 0 }),
});

// Compile-time pin: the published schema matches what the service returns.
type Conforms<T extends V, V> = T;
type _Pending = Conforms<
  Static<typeof PendingAddressResponseSchema>,
  Awaited<ReturnType<PendingAddressService["pendingForPatient"]>>
>;

const PatientParams = Type.Object({ patientId: Type.String({ format: "uuid" }) });
const PATIENT_READ = requirePermission("patient.read") as PreHandler;
const INTAKE_READ = requirePermission("intake.read") as PreHandler;
const PATIENT_SCOPE = requireAbac("patient.read", "caseload_or_scope", {
  getTarget: (request: GuardRequest) => ({
    patientId: (request.params as { patientId?: unknown } | undefined)?.patientId,
  }),
  notFoundOnDeny: true,
}) as PreHandler;

export function registerDocLensPendingAddressRoutes(
  app: FastifyInstance,
  service: PendingAddressService,
): void {
  app.get(
    "/api/v1/patients/:patientId/intake-pending-address",
    {
      preHandler: [PATIENT_READ, INTAKE_READ, PATIENT_SCOPE],
      config: { auditRead: { resourceKind: "intake_batch", patientIdParam: "patientId" } },
    },
    async (request) => {
      const ctx = request.context;
      if (!ctx?.organizationId || typeof ctx.userId !== "string" || ctx.userId.length === 0) {
        throw new UnauthorizedError();
      }
      const { patientId } = parse(PatientParams, request.params);
      return service.pendingForPatient(ctx.organizationId, patientId);
    },
  );
}
