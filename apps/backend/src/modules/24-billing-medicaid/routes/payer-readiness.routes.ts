import { Uuid, rejectAiActor, requireIdempotencyKey } from "@chartwarden/shared/route-kit";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { m24ActorOf } from "./actor";
import { ABAC_BODY_PATIENT, ABAC_BODY_PE, P, STEP_UP } from "./guards";
import {
  RecordEnrollmentEvidenceBody,
  RecordProgramAssignmentBody,
  RevokeEnrollmentEvidenceBody,
  RevokeProgramAssignmentBody,
  VerifyEnrollmentEvidenceBody,
  VerifyProgramAssignmentBody,
  assertEffectiveRange,
  parse,
} from "./m24-typebox";
import type { M24WriteService } from "./write-service";

const AI = rejectAiActor("AI principals cannot record or verify Medicaid payer evidence (D12)");
const IDEMPOTENT = requireIdempotencyKey();
const IdParams = Type.Object({ id: Uuid() });
/** The `:id` path param, validated as a uuid so a malformed id is a 422, not a database cast error. */
const idParam = (request: { params: unknown }): string => parse(IdParams, request.params).id;

/** A record body whose `effectiveTo` may not precede `effectiveFrom`. */
function parseDatedRecord<
  T extends typeof RecordProgramAssignmentBody | typeof RecordEnrollmentEvidenceBody,
>(schema: T, raw: unknown) {
  const body = parse(schema, raw);
  assertEffectiveRange(body);
  return body;
}

export function registerPayerReadinessRoutes(
  app: FastifyInstance,
  deps: { readonly writeService: M24WriteService },
): void {
  const { writeService } = deps;

  app.post(
    "/api/v1/medicaid-program-assignments",
    {
      preHandler: [
        P("medicaid.trading_partner.admin"),
        ABAC_BODY_PE("medicaid.trading_partner.admin", "state_trading_partner_credential_admin"),
        ABAC_BODY_PATIENT("medicaid.trading_partner.admin"),
        STEP_UP("medicaid.trading_partner.admin"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await writeService.recordProgramAssignment(
            m24ActorOf(request),
            parseDatedRecord(RecordProgramAssignmentBody, request.body),
          ),
        ),
  );

  app.post(
    "/api/v1/medicaid-enrollment-evidence",
    {
      preHandler: [
        P("medicaid.trading_partner.admin"),
        ABAC_BODY_PE("medicaid.trading_partner.admin", "state_trading_partner_credential_admin"),
        STEP_UP("medicaid.trading_partner.admin"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await writeService.recordEnrollmentEvidence(
            m24ActorOf(request),
            parseDatedRecord(RecordEnrollmentEvidenceBody, request.body),
          ),
        ),
  );

  app.post(
    "/api/v1/medicaid-program-assignments/:id/verify",
    {
      preHandler: [
        P("medicaid.trading_partner.admin"),
        ABAC_BODY_PE("medicaid.trading_partner.admin", "state_trading_partner_credential_admin"),
        ABAC_BODY_PATIENT("medicaid.trading_partner.admin"),
        STEP_UP("medicaid.trading_partner.admin"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply.send(
        await writeService.verifyProgramAssignment(
          m24ActorOf(request),
          idParam(request),
          parse(VerifyProgramAssignmentBody, request.body),
        ),
      ),
  );

  app.post(
    "/api/v1/medicaid-enrollment-evidence/:id/verify",
    {
      preHandler: [
        P("medicaid.trading_partner.admin"),
        ABAC_BODY_PE("medicaid.trading_partner.admin", "state_trading_partner_credential_admin"),
        STEP_UP("medicaid.trading_partner.admin"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply.send(
        await writeService.verifyEnrollmentEvidence(
          m24ActorOf(request),
          idParam(request),
          parse(VerifyEnrollmentEvidenceBody, request.body),
        ),
      ),
  );

  app.post(
    "/api/v1/medicaid-program-assignments/:id/revoke",
    {
      preHandler: [
        P("medicaid.trading_partner.admin"),
        ABAC_BODY_PE("medicaid.trading_partner.admin", "state_trading_partner_credential_admin"),
        ABAC_BODY_PATIENT("medicaid.trading_partner.admin"),
        STEP_UP("medicaid.trading_partner.admin"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply.send(
        await writeService.revokeProgramAssignment(
          m24ActorOf(request),
          idParam(request),
          parse(RevokeProgramAssignmentBody, request.body),
        ),
      ),
  );

  app.post(
    "/api/v1/medicaid-enrollment-evidence/:id/revoke",
    {
      preHandler: [
        P("medicaid.trading_partner.admin"),
        ABAC_BODY_PE("medicaid.trading_partner.admin", "state_trading_partner_credential_admin"),
        STEP_UP("medicaid.trading_partner.admin"),
        AI,
        IDEMPOTENT,
      ],
    },
    async (request, reply) =>
      reply.send(
        await writeService.revokeEnrollmentEvidence(
          m24ActorOf(request),
          idParam(request),
          parse(RevokeEnrollmentEvidenceBody, request.body),
        ),
      ),
  );
}
