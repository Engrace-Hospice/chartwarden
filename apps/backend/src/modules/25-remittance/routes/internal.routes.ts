// apps/backend/src/modules/25-remittance/routes/internal.routes.ts — M25 (§4.1 routes 29-31) the internal
// reader-seam endpoints reached only by the `m25.system_principal` (architecture §17 service-to-service
// token), NOT the user-facing gateway. They back the RemittanceReader / DenialMetricsProvider /
// PatientResponsibilityReader seams other modules (M26/M27/M30/M33) consume. Gated by the §4.6 internal
// permission key PLUS a server-side principal-kind assertion — `actorKind === "system"`, which only the
// verified `INTERNAL_SERVICE_TOKEN` branch of the authenticate hook can set, so a request-borne actor is
// refused. It asserted a `systemPrincipal` attribute until F-030; nothing ever wrote that name, so these
// three endpoints refused every caller including the seam consumers they exist for.
import { ForbiddenError } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { M25IngestService } from "../ingest/service";
import { actorOf } from "./actor";
import type { PreHandler } from "./actor";
import { P } from "./guards";
import { ReceiveAdviceRequestSchema, parse } from "./m25-typebox";
import type { M25ReadService } from "./read-service";

export interface InternalRouteDeps {
  readonly readService: M25ReadService;
  /** WX-PR-012 — the 835 receive route (#32) mounts only when a real ingest service is supplied. */
  readonly ingestService?: M25IngestService;
}

/**
 * Refuse any caller that is not a server-assembled system principal (§17).
 *
 * Gates on `actorKind`, which the authenticate hook stamps and which only the verified shared-secret
 * branch can set to `"system"` — never on a request header. It used to gate on a `systemPrincipal`
 * attribute nothing has ever written (F-030), so these internal seam routes refused EVERY caller,
 * including the M23 service-to-service calls they exist for. Fail-closed, but permanently.
 */
const SYSTEM_PRINCIPAL: PreHandler = async (request: FastifyRequest) => {
  if (request.context?.attributes?.actorKind !== "system") {
    throw new ForbiddenError("internal seam endpoints require a system principal");
  }
};

function qStr(q: unknown, key: string): string | undefined {
  const v = (q as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalRouteDeps): void {
  const { readService, ingestService } = deps;

  app.get(
    "/api/v1/internal/remittance/reader",
    {
      preHandler: [P("remittance.read_internal"), SYSTEM_PRINCIPAL],
      config: { auditRead: { resourceKind: "remittance_advice", list: true } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const id = qStr(request.query, "adviceId");
      if (!id) return reply.send({ advice: null });
      return reply.send({ advice: await readService.getAdvice(actor, id) });
    },
  );

  app.get(
    "/api/v1/internal/denials/metrics",
    {
      preHandler: [P("denial.read_internal"), SYSTEM_PRINCIPAL],
      config: {
        auditRead: { none: "denial-rate metrics by CARC — aggregate, no patient identity" },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send(await readService.denialMetrics(actor));
    },
  );

  app.get(
    "/api/v1/internal/patient-responsibility",
    {
      preHandler: [P("pr.read_internal"), SYSTEM_PRINCIPAL],
      config: { auditRead: { resourceKind: "remittance_line", list: true } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      return reply.send({
        items: await readService.prLedger(actor, qStr(request.query, "patientId")),
      });
    },
  );

  // WX-PR-012 (route #32) — receive a raw 835 already staged in MinIO by the (unbuilt) clearinghouse-pull
  // transport. Only mounted when a real ingest service is supplied (M25RouteServices.ingestService) —
  // never a deny-stub 501, simply absent, matching the "not wired yet" posture the rest of the module
  // already documents for its other unwired forward seams.
  if (ingestService) {
    app.post(
      "/api/v1/internal/remittance/advices",
      {
        preHandler: [P("remittance.ingest_internal"), SYSTEM_PRINCIPAL],
        config: { auditRead: { none: "envelope receive — no line/claim detail read here" } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const body = parse(ReceiveAdviceRequestSchema, request.body);
        const result = await ingestService.receiveAdvice(
          { organizationId: actor.organizationId },
          body,
        );
        if (result.outcome === "malformed") {
          return reply.code(422).send({ outcome: result.outcome, reason: result.reason });
        }
        if (result.outcome === "duplicate") {
          return reply
            .code(409)
            .send({ outcome: result.outcome, existingAdviceId: result.existingAdviceId });
        }
        return reply.code(202).send({ outcome: result.outcome, adviceId: result.adviceId });
      },
    );
  }
}
