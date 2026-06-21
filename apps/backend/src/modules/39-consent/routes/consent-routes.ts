// apps/backend/src/modules/39-consent/routes/consent-routes.ts — M39-T07 the consent route inventory
// (M39 spec §4.1–4.2; the §4.7 permission handshake; §4.11 ABAC; §4.12 cursor pagination).
//
// A representative slice of the §4.1 inventory over the injected `ConsentRouteService` (in-memory in
// the slice; Drizzle in prod, T09). Every route is gated by the REAL Authorization Contract
// (`requirePermission` from @wardenx/auth, M3) on the §4.7 keys M39 registers into M3's catalog
// (M39_CONTRIBUTED_PERMISSIONS); the sign/supersede/revoke/overlay/admin routes additionally
// STEP-UP re-auth (`requireStepUp`, the `consent_management` profile, §4.1). Org binding is always
// server-side (`request.context`, never the body). The eval-audit query is CURSOR-paginated (§4.12 —
// opaque cursor, never offset; consent_eval_audit is monthly-partitioned and can be O(10M) rows).
import type {
  ConsentCaptureMethod,
  ConsentGrantorKind,
  ConsentRouteService,
  RevokeConsentInput,
} from "@wardenx/consent";
import { ConsentRouteError } from "@wardenx/consent";
import { requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ConsentIdParamsSchema,
  CreateDraftBodySchema,
  EvalAuditQuerySchema,
  PatientIdParamsSchema,
  RevokeBodySchema,
  parse,
} from "./consent-typebox";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface ConsentRouteDeps {
  service: ConsentRouteService;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const READ_CATALOG = requirePermission("consent.read_catalog") as PreHandler;
const READ = requirePermission("consent.read") as PreHandler;
const READ_EVAL_AUDIT = requirePermission("consent.read_eval_audit") as PreHandler;
const AUTHOR = requirePermission("consent.author") as PreHandler;
const SIGN = requirePermission("consent.sign") as PreHandler;
const REVOKE = requirePermission("consent.revoke") as PreHandler;
const SIGN_STEP_UP = requireStepUp("consent.sign") as PreHandler;
const REVOKE_STEP_UP = requireStepUp("consent.revoke") as PreHandler;

function mapError(e: unknown): never {
  if (e instanceof ConsentRouteError) {
    if (e.code === "not_found") throw new WardenXError("NOT_FOUND", e.message, 404);
    if (e.code === "validation") throw new WardenXError("VALIDATION_FAILED", e.message, 422);
    throw new WardenXError("CONFLICT", e.message, 409);
  }
  throw e;
}

export function registerConsentRoutes(app: FastifyInstance, deps: ConsentRouteDeps): void {
  const { service } = deps;

  // 1. GET /api/v1/consent-types — catalog + applicable tenant overlay (every role).
  app.get("/api/v1/consent-types", { preHandler: [READ_CATALOG] }, async (request) => {
    const { organizationId } = actorOf(request);
    return { data: await service.readCatalog(organizationId) };
  });

  // 3. GET /api/v1/patients/:patientId/consents — active consents (consent.read + caseload §4.11).
  app.get("/api/v1/patients/:patientId/consents", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { patientId } = parse(PatientIdParamsSchema, request.params);
    return { data: await service.listConsentsForPatient(organizationId, patientId) };
  });

  // 4. GET /api/v1/consents/:consentId — full record (consent.read).
  app.get("/api/v1/consents/:consentId", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    const record = await service.getConsent(organizationId, consentId);
    if (!record) throw new WardenXError("NOT_FOUND", "consent not found", 404);
    return { data: record };
  });

  // 6. POST /api/v1/patients/:patientId/consents — create a DRAFT (no step-up; not yet signed).
  app.post("/api/v1/patients/:patientId/consents", { preHandler: [AUTHOR] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { patientId } = parse(PatientIdParamsSchema, request.params);
    const body = parse(CreateDraftBodySchema, request.body);
    const draft = await service.createDraft(organizationId, {
      patientId,
      typeKey: body.typeKey,
      // The TypeBox union validated these at runtime; the cast re-applies the literal types.
      grantorKind: body.grantorKind as ConsentGrantorKind,
      captureMethod: body.captureMethod as ConsentCaptureMethod,
      scopeDescriptor: body.scopeDescriptor,
      createdById: userId,
    });
    reply.code(201);
    return { data: draft };
  });

  // 8. POST /api/v1/consents/:consentId/sign — sign (consent.sign + STEP-UP, §4.1). Emits m39.consent.signed (T08).
  app.post("/api/v1/consents/:consentId/sign", { preHandler: [SIGN, SIGN_STEP_UP] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    try {
      return { data: await service.signConsent(organizationId, consentId, userId, new Date().toISOString()) };
    } catch (e) {
      mapError(e);
    }
  });

  // 10. POST /api/v1/consents/:consentId/revoke — revoke (consent.revoke + STEP-UP for staff, §4.1).
  app.post("/api/v1/consents/:consentId/revoke", { preHandler: [REVOKE, REVOKE_STEP_UP] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    const body = parse(RevokeBodySchema, request.body);
    try {
      return {
        data: await service.revokeConsent(
          organizationId,
          consentId,
          {
            actorIsStaff: body.revokedByKind === "staff",
            revokedByKind: body.revokedByKind as RevokeConsentInput["revokedByKind"],
            reasonText: body.reasonText,
            evidenceDocumentId: body.evidenceDocumentId ?? null,
            revokedById: userId,
          },
          new Date().toISOString(),
        ),
      };
    } catch (e) {
      mapError(e);
    }
  });

  // 23. GET /api/v1/consents/eval-audit/by-patient — the consent-DECISION audit, CURSOR-paginated
  // (§4.12; NOT the §164.528 disclosure sink — that is M4's, ADR-0013).
  app.get("/api/v1/consents/eval-audit/by-patient", { preHandler: [READ_EVAL_AUDIT] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(EvalAuditQuerySchema, request.query);
    const page = await service.listEvalAudit(
      organizationId,
      { patientId: q.patientId },
      { cursor: q.cursor, pageSize: q.pageSize ?? 50 },
    );
    return { data: page.rows, nextCursor: page.nextCursor };
  });
}
