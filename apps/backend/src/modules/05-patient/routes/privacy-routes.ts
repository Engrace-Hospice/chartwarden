// apps/backend/src/modules/05-patient/routes/privacy-routes.ts — the Privacy Officer surface (M5 §4.2,
// §4.7, §5.1 "Privacy flags", §6 "Resync privacy flags").
//
//   GET  /api/v1/patients/:id/privacy               one patient's restrictions, their origin, the M39 Part 2
//                                                   consent state, the DocLens detections holding a flag,
//                                                   the snapshot's change timeline, and any drift
//   POST /api/v1/patients/:id/privacy-flags/resync  M5 §4.2 verbatim: `privacy.admin`, ABAC none, "force
//                                                   re-read from M39; admin-only"
//   GET  /api/v1/privacy/restricted-patients        the officer's work queue (patients with a restriction),
//                                                   filterable by origin (e.g. an unreviewed detection)
//
// All three are `privacy.admin` (§4.7: "Privacy Officer, Compliance Officer · abac none · resync snapshot,
// etc."). ABAC is `none` by the catalog — the officer is an org-wide records role, not a caseload role — so
// RLS (org) is the scope and another tenant's patient is a 404.
//
// The officer does NOT confirm or reject a DocLens SUD detection here: M22 §7.4 step 6 gives that to the
// licensed reviewer in the intake review (`intake.review`, RN or above). The page links to that review.
//
// Reads are §2.5 read-audited (Part 2 facts — flag set, origin, consent state — are themselves sensitive);
// the resync is write-audited by the M4 trigger on `patient_privacy_flag_snapshot` (as the acting user).
import { requirePermission } from "@wardenx/auth";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrivacyOfficerService } from "../privacy/officer-db";
import { LooseIdParamsSchema, parse } from "./patient-typebox";
import { RestrictedPatientsQuerySchema } from "./privacy-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface PatientPrivacyRouteDeps {
  service: PrivacyOfficerService;
}

const PRIVACY_ADMIN = requirePermission("privacy.admin") as PreHandler;

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const notFound = () => new WardenXError("NOT_FOUND", "patient not found", 404);

export function registerPatientPrivacyRoutes(
  app: FastifyInstance,
  deps: PatientPrivacyRouteDeps,
): void {
  const { service } = deps;

  app.get(
    "/api/v1/patients/:id/privacy",
    {
      preHandler: [PRIVACY_ADMIN],
      config: {
        auditRead: {
          resourceKind: "patient_privacy",
          patientIdParam: "id",
          fields: [
            "privacy_flags",
            "privacy_flag_origin",
            "part2_consent_state",
            "intake_sud_detections",
            "privacy_flag_history",
          ],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const view = await service.getPatientPrivacy(organizationId, id);
      if (view === null) throw notFound();
      return view;
    },
  );

  app.post(
    "/api/v1/patients/:id/privacy-flags/resync",
    { preHandler: [PRIVACY_ADMIN] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(LooseIdParamsSchema, request.params);
      const out = await service.resync(organizationId, id, userId);
      if (out === null) throw notFound();
      return out;
    },
  );

  app.get(
    "/api/v1/privacy/restricted-patients",
    {
      preHandler: [PRIVACY_ADMIN],
      config: {
        auditRead: {
          resourceKind: "patient_privacy",
          list: true,
          fields: ["patient_name", "mrn", "privacy_flags", "privacy_flag_origin"],
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const query = parse(RestrictedPatientsQuerySchema, request.query);
      return service.listRestricted(organizationId, query);
    },
  );
}
