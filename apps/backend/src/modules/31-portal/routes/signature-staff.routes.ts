// M31 ADR-0107 (PROPOSED) — the STAFF side of admission-document signing:
//   POST /api/v1/admin/portal-signature-requests              send a patient a request (one open per patient and document kind)
//   GET  /api/v1/admin/portal-signature-requests?patientId=   a patient's requests, newest first (read-audited list)
//   POST /api/v1/admin/portal-signature-requests/:id/void     withdraw an OPEN request, with a coded reason
// Each route gates on the permission AND on `caseload_or_scope` over the patient the request concerns (the invitation-scope convention), so a
// holder of the key cannot reach a patient off their caseload. For void the patient is read from the request row server-side, never the body.
// Template key and version are stamped from the server registry. An M06 document must name the M06 record it will sign into, checked here so a
// mistaken target fails at send time, not when the patient tries to sign.
import { ChartWardenError, ConflictError, NotFoundError } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { M06_DOC_KINDS, SIGNATURE_TEMPLATES } from "../signature-templates";
import { actorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import type { PortalRouteDeps } from "./index";
import { invitationPatientScope } from "./invitation-scope";
import { StaffSignatureRequestCreate, StaffSignatureRequestVoid, parse } from "./portal-typebox";
import type { PortalStaffSigningDeps } from "./signature-deps";

const IDEMPOTENT = requireIdempotencyKey();

function staffOf(deps: PortalRouteDeps): PortalStaffSigningDeps {
  if (!deps.signing?.staff) {
    throw new ChartWardenError(
      "PORTAL_SIGNING_UNAVAILABLE",
      "Signature requests are not available right now.",
      503,
    );
  }
  return deps.signing.staff;
}

const patientFromQuery = async (request: FastifyRequest): Promise<readonly string[]> => {
  const patientId = (request.query as { patientId?: unknown } | undefined)?.patientId;
  return typeof patientId === "string" && patientId ? [patientId] : [];
};
const patientFromBody = async (request: FastifyRequest): Promise<readonly string[]> => {
  const patientId = (request.body as { patientId?: unknown } | undefined)?.patientId;
  return typeof patientId === "string" && patientId ? [patientId] : [];
};

export function registerPortalSignatureStaffRoutes(
  app: FastifyInstance,
  deps: PortalRouteDeps,
): void {
  const createScope = invitationPatientScope("portal.signature_request.create", patientFromBody);
  const readScope = invitationPatientScope("portal.signature_request.read", patientFromQuery);
  // The patient behind a request id comes from the request's own row (RLS-scoped); an unknown id has no patient and is refused the same way.
  const voidScope = invitationPatientScope("portal.signature_request.void", async (request) => {
    const { requestId } = request.params as { requestId: string };
    const row = await staffOf(deps).store.get(actorOf(request).organizationId, requestId);
    return row ? [row.patientId] : [];
  });

  app.post(
    "/api/v1/admin/portal-signature-requests",
    { preHandler: [P("portal.signature_request.create"), createScope, IDEMPOTENT] },
    async (request, reply) => {
      await createScope(request, reply);
      const staff = staffOf(deps);
      const actor = actorOf(request);
      const body = parse(StaffSignatureRequestCreate, request.body);

      const targetRequired = M06_DOC_KINDS.has(body.docKind);
      if (targetRequired !== (body.targetRef !== undefined)) {
        throw new ChartWardenError(
          "SIGNATURE_TARGET_INVALID",
          targetRequired
            ? "This document must name the record it is signed into."
            : "This document does not take a target record.",
          422,
        );
      }
      if (targetRequired && body.targetRef !== undefined) {
        const signable = await staff.m06TargetIsSignable({
          organizationId: actor.organizationId,
          docKind: body.docKind as "election_statement" | "notice_of_patient_rights",
          patientId: body.patientId,
          targetRef: body.targetRef,
        });
        // One answer for absent, another patient's, and already signed: nothing about the other record leaks.
        if (!signable) {
          throw new ChartWardenError(
            "SIGNATURE_TARGET_INVALID",
            "That record cannot be sent for signature for this patient.",
            422,
          );
        }
      }

      const site = await staff.patientSite(actor.organizationId, body.patientId);
      if (!site) throw new NotFoundError("patient", body.patientId);
      const template = SIGNATURE_TEMPLATES[body.docKind];
      const outcome = await staff.store.create(actor.organizationId, {
        patientId: body.patientId,
        providerEntityId: site.providerEntityId,
        locationId: site.locationId,
        docKind: body.docKind,
        templateKey: template.key,
        templateVersion: template.version,
        targetRef: body.targetRef ?? null,
        requestedBy: actor.userId,
      });
      if (!outcome.created) {
        // The open request is found by listing; its id is not echoed so the 409 carries nothing beyond the fact.
        throw new ChartWardenError(
          "SIGNATURE_REQUEST_ALREADY_OPEN",
          "A request for this document is already open for this patient.",
          409,
        );
      }
      reply.status(201);
      return outcome.request;
    },
  );

  app.get(
    "/api/v1/admin/portal-signature-requests",
    {
      preHandler: [P("portal.signature_request.read"), readScope],
      config: { auditRead: { resourceKind: "portal_signature_request", list: true } },
    },
    async (request, reply) => {
      await readScope(request, reply);
      const [patientId] = await patientFromQuery(request);
      const items = await staffOf(deps).store.listForPatient(
        actorOf(request).organizationId,
        patientId as string,
      );
      return { items };
    },
  );

  app.post(
    "/api/v1/admin/portal-signature-requests/:requestId/void",
    { preHandler: [P("portal.signature_request.void"), voidScope, IDEMPOTENT] },
    async (request, reply) => {
      await voidScope(request, reply);
      const actor = actorOf(request);
      const { requestId } = request.params as { requestId: string };
      const { reason } = parse(StaffSignatureRequestVoid, request.body);
      const outcome = await staffOf(deps).store.voidOpen(
        actor.organizationId,
        requestId,
        actor.userId,
        reason,
      );
      if (!outcome.voided) {
        if (outcome.reason === "not_found") throw new NotFoundError("signature request", requestId);
        throw new ConflictError("Only an open request can be voided.");
      }
      return outcome.request;
    },
  );
}
