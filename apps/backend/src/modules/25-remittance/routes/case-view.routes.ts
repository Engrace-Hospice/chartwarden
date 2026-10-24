// apps/backend/src/modules/25-remittance/routes/case-view.routes.ts - M25 milestone 7a-1: the one case view,
// `GET /api/v1/claims/:claimId/case-view`. Read-only. Gated on `appeal.read`; the ADR, reopening and audit sections are
// included only when the actor also holds the matching read key (resolved through the same RBAC resolver the gates use),
// so the view never widens what a role can see. Auditor sessions never reach it (not on the enrolment allowlist). Every
// read emits a read-audit event keyed on the claim id. Org, actor and provider-entity scope are server-derived.
import { resolveActorPermissions } from "@chartwarden/auth";
import { NotFoundError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { actorOf } from "./actor";
import type { CaseViewService } from "./case-view-service";
import { P } from "./guards";

export interface CaseViewRouteDeps {
  readonly caseViewService: CaseViewService;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);

const TimelineItemSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("appeal"),
    Type.Literal("adr"),
    Type.Literal("reopening"),
    Type.Literal("recorded_deadline"),
    Type.Literal("audit_request"),
    Type.Literal("submission"),
    Type.Literal("payer_appeal"),
  ]),
  at: Type.String(),
  label: Type.String(),
  state: Type.String(),
  tier: NULLABLE_STRING,
  relatedId: Type.Optional(NULLABLE_STRING),
  deadlineAt: NULLABLE_STRING,
  deadlineSource: Type.Union([Type.Literal("computed"), Type.Literal("recorded"), Type.Null()]),
  windowConfirmed: Type.Boolean(),
});

export const CaseViewSchema = Type.Object({
  claimId: Type.String(),
  patientId: NULLABLE_STRING,
  generatedAt: Type.String(),
  nextDeadline: Type.Union([TimelineItemSchema, Type.Null()]),
  items: Type.Array(TimelineItemSchema),
  truncated: Type.Boolean(),
});

export const DenialCaseViewSchema = Type.Object({
  denialCaseId: Type.String(),
  claimId: NULLABLE_STRING,
  patientId: NULLABLE_STRING,
  generatedAt: Type.String(),
  nextDeadline: Type.Union([TimelineItemSchema, Type.Null()]),
  items: Type.Array(TimelineItemSchema),
  truncated: Type.Boolean(),
});

export function registerCaseViewRoutes(app: FastifyInstance, deps: CaseViewRouteDeps): void {
  app.get(
    "/api/v1/claims/:claimId/case-view",
    {
      preHandler: [P("appeal.read")],
      config: {
        auditRead: {
          resourceKind: "claim_case_view",
          resourceIdParam: "claimId",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) => {
      const claimId = (request.params as { claimId: string }).claimId;
      if (!UUID.test(claimId)) throw new NotFoundError("claim");
      const ctx = request.context;
      const granted = await resolveActorPermissions({
        organizationId: ctx?.organizationId as string,
        userId: ctx?.userId as string,
      });
      return reply.send(
        await deps.caseViewService.getCaseView(actorOf(request), claimId, {
          includeAdr: granted.has("adr.read"),
          includeReopening: granted.has("reopening.read"),
          includeAudits: granted.has("audit_request.read"),
          includePayerAppeals: granted.has("payer_appeal.read"),
        }),
      );
    },
  );

  // Milestone 12a-1: the same view keyed on the DENIAL, so a commercial denial (no claim) has one too.
  app.get(
    "/api/v1/denials/:denialCaseId/case-view",
    {
      preHandler: [P("appeal.read")],
      config: {
        auditRead: {
          resourceKind: "denial_case_view",
          resourceIdParam: "denialCaseId",
          patientIdPayloadPath: "patientId",
        },
      },
    },
    async (request, reply) => {
      const denialCaseId = (request.params as { denialCaseId: string }).denialCaseId;
      if (!UUID.test(denialCaseId)) throw new NotFoundError("denial case");
      const ctx = request.context;
      const granted = await resolveActorPermissions({
        organizationId: ctx?.organizationId as string,
        userId: ctx?.userId as string,
      });
      return reply.send(
        await deps.caseViewService.getDenialCaseView(actorOf(request), denialCaseId, {
          includeAdr: granted.has("adr.read"),
          includeReopening: granted.has("reopening.read"),
          includeAudits: granted.has("audit_request.read"),
          includePayerAppeals: granted.has("payer_appeal.read"),
        }),
      );
    },
  );
}
