// apps/backend/src/modules/25-remittance/routes/internal.routes.ts — M25 (§4.1 routes 29-31) the internal
// reader-seam endpoints reached only by the `m25.system_principal` (architecture §17 service-to-service
// token), NOT the user-facing gateway. They back the RemittanceReader / DenialMetricsProvider /
// PatientResponsibilityReader seams other modules (M26/M27/M30/M33) consume. Gated by the §4.6 internal
// permission key PLUS a server-side `systemPrincipal` attribute assertion (a request-borne actor is refused).
import { ForbiddenError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorOf } from "./actor";
import { type PreHandler } from "./actor";
import { P } from "./guards";
import type { M25ReadService } from "./read-service";

export interface InternalRouteDeps {
  readonly readService: M25ReadService;
}

/** Refuse any caller that is not a server-assembled system principal (§17). */
const SYSTEM_PRINCIPAL: PreHandler = async (request: FastifyRequest) => {
  if (request.context?.attributes?.systemPrincipal !== true) {
    throw new ForbiddenError("internal seam endpoints require a system principal");
  }
};

function qStr(q: unknown, key: string): string | undefined {
  const v = (q as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalRouteDeps): void {
  const { readService } = deps;

  app.get(
    "/api/v1/internal/remittance/reader",
    { preHandler: [P("remittance.read_internal"), SYSTEM_PRINCIPAL] },
    async (request, reply) => {
      const actor = actorOf(request);
      const id = qStr(request.query, "adviceId");
      if (!id) return reply.send({ advice: null });
      return reply.send({ advice: await readService.getAdvice(actor, id) });
    },
  );

  app.get(
    "/api/v1/internal/denials/metrics",
    { preHandler: [P("denial.read_internal"), SYSTEM_PRINCIPAL] },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(await readService.denialMetrics(actor));
    },
  );

  app.get(
    "/api/v1/internal/patient-responsibility",
    { preHandler: [P("pr.read_internal"), SYSTEM_PRINCIPAL] },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({ items: await readService.prLedger(actor, qStr(request.query, "patientId")) });
    },
  );
}
