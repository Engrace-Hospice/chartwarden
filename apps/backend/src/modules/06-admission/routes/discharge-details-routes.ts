// apps/backend/src/modules/06-admission/routes/discharge-details-routes.ts — record a claim-relevant discharge
// detail AFTER the fact. Death discharges and transfer-outs recorded before migration 0370 carry no place of death
// / receiving care setting, so M23 cannot derive the final claim's patient discharge status (40/41/42, 50/51) and
// blocks the claim. These routes complete the record:
//
//   GET  /api/v1/admissions/:id/discharge-details            what the stay-ending event has and lacks
//   POST /api/v1/discharges/:id/place-of-death               { placeOfDeath, ifVersion, correctionReason? }
//   POST /api/v1/transfers/:id/receiving-care-setting        { receivingCareSetting, ifVersion, correctionReason? }
//
// AUTHORIZATION: the SAME capability that records the fact completes it — `discharge.death` for a place of death,
// `transfer.out` for a receiving care setting — plus `admission.scope` on the OWNING admission (resolved from the
// discharge/transfer id; 404 on deny, the §2.2 existence non-leak). The read is `admission.read` + scope.
// CONCURRENCY: `ifVersion` is the row version the caller read (409 VERSION_MISMATCH when stale, the cosign
// route's convention). A first-time value needs no reason; replacing a recorded value needs `correctionReason`
// (409 DISCHARGE_DETAIL_CORRECTION_REASON_REQUIRED otherwise). Every change emits `m6.discharge.details_recorded`,
// which M23 consumes to re-validate the admission's open claims.
import { requireAbac, requirePermission } from "@wardenx/auth";
import { DegradedError, NotFoundError, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IdParamsSchema, parse } from "./admission-typebox";
import type { DischargeDetailsService } from "./discharge-details-service";
import {
  PlaceOfDeathRecordSchema,
  ReceivingCareSettingRecordSchema,
} from "./discharge-details-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DischargeDetailsRouteDeps {
  readonly service: DischargeDetailsService | undefined;
}

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const ADMISSION_READ = P("admission.read");
const DISCHARGE_DEATH = P("discharge.death");
const TRANSFER_OUT = P("transfer.out");

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const idOf = (request: FastifyRequest): string => parse(IdParamsSchema, request.params).id;

/**
 * `admission.scope` on the admission that OWNS the addressed discharge/transfer row. The owner is looked up first
 * (RLS-scoped: a cross-tenant or unknown id resolves to nothing → 404), then the scope predicate runs against it.
 */
function owningAdmissionScope(
  action: string,
  owner: (organizationId: string, id: string) => Promise<string | null>,
): PreHandler {
  return async (request, reply) => {
    const organizationId = request.context?.organizationId;
    if (!organizationId) throw new UnauthorizedError();
    const admissionId = await owner(organizationId, idOf(request));
    if (!admissionId) throw new NotFoundError("resource");
    await (
      requireAbac(action, "admission.scope", {
        notFoundOnDeny: true,
        getTarget: () => ({ id: admissionId }),
      }) as PreHandler
    )(request, reply);
  };
}

const ADMISSION_SCOPE_READ = requireAbac("admission.read", "admission.scope", {
  notFoundOnDeny: true,
}) as PreHandler;

export function registerDischargeDetailsRoutes(
  app: FastifyInstance,
  deps: DischargeDetailsRouteDeps,
): void {
  const svc = (): DischargeDetailsService => {
    if (!deps.service) {
      throw new DegradedError("m6.discharge-details", "the discharge-details service is not bound");
    }
    return deps.service;
  };

  app.get(
    "/api/v1/admissions/:id/discharge-details",
    {
      preHandler: [ADMISSION_READ, ADMISSION_SCOPE_READ],
      config: { auditRead: { resourceKind: "admission", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const id = idOf(request);
      const view = await svc().getForAdmission(organizationId, id);
      if (!view) throw new NotFoundError("admission", id);
      return view;
    },
  );

  app.post(
    "/api/v1/discharges/:id/place-of-death",
    {
      preHandler: [
        DISCHARGE_DEATH,
        owningAdmissionScope("discharge.death", (org, id) =>
          svc().admissionIdForDischarge(org, id),
        ),
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(PlaceOfDeathRecordSchema, request.body);
      return svc().recordPlaceOfDeath(
        organizationId,
        idOf(request),
        {
          value: body.placeOfDeath,
          ifVersion: body.ifVersion,
          ...(body.correctionReason !== undefined
            ? { correctionReason: body.correctionReason }
            : {}),
        },
        userId,
      );
    },
  );

  app.post(
    "/api/v1/transfers/:id/receiving-care-setting",
    {
      preHandler: [
        TRANSFER_OUT,
        owningAdmissionScope("transfer.out", (org, id) => svc().admissionIdForTransfer(org, id)),
      ],
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(ReceivingCareSettingRecordSchema, request.body);
      return svc().recordReceivingCareSetting(
        organizationId,
        idOf(request),
        {
          value: body.receivingCareSetting,
          ifVersion: body.ifVersion,
          ...(body.correctionReason !== undefined
            ? { correctionReason: body.correctionReason }
            : {}),
        },
        userId,
      );
    },
  );
}
