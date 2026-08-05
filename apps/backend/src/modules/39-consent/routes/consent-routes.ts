import { requirePermission, requireStepUp } from "@wardenx/auth";
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
  AddDpoaAgentInput,
  AddRecipientInput,
  ConsentCaptureMethod,
  ConsentGrantorKind,
  ConsentRouteService,
  RenewConsentInput,
  RevokeConsentInput,
  SupersedeConsentInput,
  UpdateConsentDraftInput,
  UpdateDpoaAgentInput,
  UpsertConsentOverlayInput,
} from "@wardenx/consent";
import { ConsentRouteError } from "@wardenx/consent";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AddDpoaAgentBodySchema,
  AddRecipientBodySchema,
  BereavementOutreachBodySchema,
  ConsentEvalAuditQuerySchema,
  ConsentIdParamsSchema,
  CreateDraftBodySchema,
  DpoaAgentIdParamsSchema,
  EvalAuditQuerySchema,
  ExpiringConsentsQuerySchema,
  PatientIdParamsSchema,
  RecipientIdParamsSchema,
  RemoveRecipientBodySchema,
  RenewBodySchema,
  RevokeBodySchema,
  SignConsentBodySchema,
  SupersedeBodySchema,
  UpdateDpoaAgentBodySchema,
  UpdateDraftBodySchema,
  UpsertOverlayBodySchema,
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

/** Server-authenticated command provenance. Body fields can never forge these identifiers. */
function commandContextOf(request: FastifyRequest): {
  stepUpSessionId?: string;
  membershipId?: string;
} {
  const attrs = request.context?.attributes ?? {};
  return {
    ...(typeof attrs.sessionId === "string" ? { stepUpSessionId: attrs.sessionId } : {}),
    ...(typeof attrs.membershipId === "string" ? { membershipId: attrs.membershipId } : {}),
  };
}

const READ_CATALOG = requirePermission("consent.read_catalog") as PreHandler;
const READ = requirePermission("consent.read") as PreHandler;
const READ_HISTORY = requirePermission("consent.read_history") as PreHandler;
const READ_EVAL_AUDIT = requirePermission("consent.read_eval_audit") as PreHandler;
const AUTHOR = requirePermission("consent.author") as PreHandler;
const SIGN = requirePermission("consent.sign") as PreHandler;
const REVOKE = requirePermission("consent.revoke") as PreHandler;
const MANAGE_OVERLAY = requirePermission("consent.manage_overlay") as PreHandler;
const ADMIN_RE_RENDER = requirePermission("consent.admin_re_render") as PreHandler;
const CASCADE_ADMIN = requirePermission("consent.cascade_admin") as PreHandler;
const BEREAVEMENT_AUTHOR = requirePermission("consent.bereavement_outreach_author") as PreHandler;
const SIGN_STEP_UP = requireStepUp("consent.sign") as PreHandler;
const REVOKE_STEP_UP = requireStepUp("consent.revoke") as PreHandler;
const AUTHOR_STEP_UP = requireStepUp("consent.author") as PreHandler;
const OVERLAY_STEP_UP = requireStepUp("consent.manage_overlay") as PreHandler;
const RE_RENDER_STEP_UP = requireStepUp("consent.admin_re_render") as PreHandler;
const CASCADE_STEP_UP = requireStepUp("consent.cascade_admin") as PreHandler;
const BEREAVEMENT_STEP_UP = requireStepUp("consent.bereavement_outreach_author") as PreHandler;

/** The wall clock every lifecycle write stamps with (one read per request, so a single handler's
 *  transitions share an instant — never two clocks inside one state change). */
const nowIso = (): string => new Date().toISOString();

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

  // 2. POST /api/v1/consent-types/overlay — publish a TIGHTEN-ONLY tenant overlay (§7.6 + STEP-UP).
  // A loosen attempt is refused by the pure `validateConsentOverlay` and surfaces as a 422.
  app.post(
    "/api/v1/consent-types/overlay",
    { preHandler: [MANAGE_OVERLAY, OVERLAY_STEP_UP] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(UpsertOverlayBodySchema, request.body);
      try {
        const overlay = await service.upsertTenantOverlay(
          organizationId,
          { ...body, publishedById: userId } as UpsertConsentOverlayInput,
          nowIso(),
        );
        reply.code(201);
        return { data: overlay };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 3. GET /api/v1/patients/:patientId/consents — active consents (consent.read + caseload §4.11).
  app.get(
    "/api/v1/patients/:patientId/consents",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "consent", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return { data: await service.listConsentsForPatient(organizationId, patientId) };
    },
  );

  // 4. GET /api/v1/consents/:consentId — full record (consent.read).
  app.get("/api/v1/consents/:consentId", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    const record = await service.getConsent(organizationId, consentId);
    if (!record) throw new WardenXError("NOT_FOUND", "consent not found", 404);
    return { data: record };
  });

  // 5. GET /api/v1/consents/:consentId/version-chain — both ancestor chains (D1 supersession +
  // D13 renewal), gated on the distinct `consent.read_history` key (§4.1).
  app.get(
    "/api/v1/consents/:consentId/version-chain",
    { preHandler: [READ_HISTORY] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      try {
        return { data: await service.getVersionChain(organizationId, consentId) };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 6. POST /api/v1/patients/:patientId/consents — create a DRAFT (no step-up; not yet signed).
  app.post(
    "/api/v1/patients/:patientId/consents",
    { preHandler: [AUTHOR] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      const body = parse(CreateDraftBodySchema, request.body);
      const draft = await service.createDraft(organizationId, {
        ...body,
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
    },
  );

  // 7. PATCH /api/v1/consents/:consentId — edit a DRAFT only (D1: an edit to a signed consent is a
  // supersession, route 9 — the service refuses a non-draft with a 409).
  app.patch("/api/v1/consents/:consentId", { preHandler: [AUTHOR] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    const body = parse(UpdateDraftBodySchema, request.body);
    try {
      return {
        data: await service.updateDraft(organizationId, consentId, body as UpdateConsentDraftInput),
      };
    } catch (e) {
      mapError(e);
    }
  });

  // 8. POST /api/v1/consents/:consentId/sign — sign (consent.sign + STEP-UP, §4.1). Emits m39.consent.signed (T08).
  app.post(
    "/api/v1/consents/:consentId/sign",
    { preHandler: [SIGN, SIGN_STEP_UP] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      const body = parse(SignConsentBodySchema, request.body);
      try {
        return {
          data: await service.signConsent(
            organizationId,
            consentId,
            userId,
            nowIso(),
            body.captureEvidence,
            commandContextOf(request),
          ),
        };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 9. POST /api/v1/consents/:consentId/supersede — the D1 append-only "edit": a NEW active row
  // pointing at this one, which flips to `superseded`. Never an in-place mutation.
  app.post(
    "/api/v1/consents/:consentId/supersede",
    { preHandler: [SIGN, SIGN_STEP_UP] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      const body = parse(SupersedeBodySchema, request.body);
      try {
        const next = await service.supersedeConsent(
          organizationId,
          consentId,
          { ...body, createdById: userId } as SupersedeConsentInput,
          nowIso(),
          commandContextOf(request),
        );
        reply.code(201);
        return { data: next };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 10. POST /api/v1/consents/:consentId/revoke — revoke (consent.revoke + STEP-UP for staff, §4.1).
  app.post(
    "/api/v1/consents/:consentId/revoke",
    { preHandler: [REVOKE, REVOKE_STEP_UP] },
    async (request) => {
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
            nowIso(),
            commandContextOf(request),
          ),
        };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // ── §2.3 D6 named recipients (11–13). A recipient row is only legal on a per-recipient type;
  // the service refuses the rest. Add/remove carry STEP-UP: each one widens or narrows a live
  // disclosure scope (W-CON-02 adds a recipient to an already-signed 42 CFR Part 2 release).
  // 11. GET /api/v1/consents/:consentId/recipients — active + historical.
  app.get("/api/v1/consents/:consentId/recipients", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    try {
      return { data: await service.listRecipients(organizationId, consentId, nowIso()) };
    } catch (e) {
      mapError(e);
    }
  });

  // 12. POST /api/v1/consents/:consentId/recipients — add a named recipient (STEP-UP).
  app.post(
    "/api/v1/consents/:consentId/recipients",
    { preHandler: [AUTHOR, AUTHOR_STEP_UP] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      const body = parse(AddRecipientBodySchema, request.body);
      try {
        const row = await service.addRecipient(
          organizationId,
          consentId,
          {
            ...body,
            recipientEntityId: body.recipientEntityId ?? null,
            recipientFreeText: body.recipientFreeText ?? null,
            addedById: userId,
          } as AddRecipientInput,
          nowIso(),
        );
        reply.code(201);
        return { data: row };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 13. DELETE /api/v1/consents/:consentId/recipients/:recipientId — flips removed_at (STEP-UP).
  // The row is never deleted: a disclosure target that WAS authorized stays in the record.
  app.delete(
    "/api/v1/consents/:consentId/recipients/:recipientId",
    { preHandler: [AUTHOR, AUTHOR_STEP_UP] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId, recipientId } = parse(RecipientIdParamsSchema, request.params);
      const body = parse(RemoveRecipientBodySchema, request.body);
      try {
        return {
          data: await service.removeRecipient(
            organizationId,
            consentId,
            recipientId,
            { removedById: userId, removedReasonText: body.removedReasonText },
            nowIso(),
          ),
        };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // ── §2.3 D5 named DPOA agents (14–17). Only legal on a per-named-agent type; ≤1 active agent
  // per kind, and a DPOA consent cannot be signed without exactly one active primary.
  // 14. GET /api/v1/consents/:consentId/dpoa-agents — active + historical.
  app.get("/api/v1/consents/:consentId/dpoa-agents", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    try {
      return { data: await service.listDpoaAgents(organizationId, consentId, nowIso()) };
    } catch (e) {
      mapError(e);
    }
  });

  // 15. POST /api/v1/consents/:consentId/dpoa-agents — name an agent (STEP-UP).
  app.post(
    "/api/v1/consents/:consentId/dpoa-agents",
    { preHandler: [AUTHOR, AUTHOR_STEP_UP] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      const body = parse(AddDpoaAgentBodySchema, request.body);
      try {
        const row = await service.addDpoaAgent(
          organizationId,
          consentId,
          { ...body, addedById: userId } as AddDpoaAgentInput,
          nowIso(),
        );
        reply.code(201);
        return { data: row };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 16. PATCH /api/v1/consents/:consentId/dpoa-agents/:agentId — mutate scope / activation / term,
  // or retire the agent (`remove: true`). STEP-UP: this changes who may decide for the patient.
  app.patch(
    "/api/v1/consents/:consentId/dpoa-agents/:agentId",
    { preHandler: [AUTHOR, AUTHOR_STEP_UP] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId, agentId } = parse(DpoaAgentIdParamsSchema, request.params);
      const body = parse(UpdateDpoaAgentBodySchema, request.body);
      try {
        return {
          data: await service.updateDpoaAgent(
            organizationId,
            consentId,
            agentId,
            { ...body, removedById: userId } as UpdateDpoaAgentInput,
            nowIso(),
          ),
        };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 17. GET /api/v1/patients/:patientId/dpoa/active-primary — the read M7/M11/M14 consume to
  // resolve "who may consent for this patient right now". Null when no active primary exists.
  app.get(
    "/api/v1/patients/:patientId/dpoa/active-primary",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "consent", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return { data: await service.activePrimaryDpoa(organizationId, patientId, nowIso()) };
    },
  );

  // 18. GET /api/v1/patients/:patientId/expiring-consents — the 90-day renewal window (D9),
  // CURSOR-paginated (§4.12: soonest-expiring first, keyset on (expires_at, id)).
  app.get(
    "/api/v1/patients/:patientId/expiring-consents",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "consent", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      const q = parse(ExpiringConsentsQuerySchema, request.query);
      const page = await service.listExpiringConsents(
        organizationId,
        patientId,
        q.windowDays ?? 90,
        nowIso(),
        { cursor: q.cursor, pageSize: q.pageSize ?? 50 },
      );
      return { data: page.rows, nextCursor: page.nextCursor };
    },
  );

  // 19. GET /api/v1/consents/:consentId/renewal-cycle — open + closed cycles (D8).
  app.get("/api/v1/consents/:consentId/renewal-cycle", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { consentId } = parse(ConsentIdParamsSchema, request.params);
    try {
      return { data: await service.listRenewalCycles(organizationId, consentId) };
    } catch (e) {
      mapError(e);
    }
  });

  // 20. POST /api/v1/consents/:consentId/renew — the D13 renewal chain (distinct from supersession:
  // the prior row is expired/revoked, not active). Closes the open renewal cycle as `renewed`.
  app.post(
    "/api/v1/consents/:consentId/renew",
    { preHandler: [SIGN, SIGN_STEP_UP] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      const body = parse(RenewBodySchema, request.body);
      try {
        const next = await service.renewConsent(
          organizationId,
          consentId,
          { ...body, createdById: userId } as RenewConsentInput,
          nowIso(),
          commandContextOf(request),
        );
        reply.code(201);
        return { data: next };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 21. GET /api/v1/patients/:patientId/delegated-access — the D10 projection a caregiver/portal
  // session resolves against (M31 consumes it once the portal session class exists).
  app.get(
    "/api/v1/patients/:patientId/delegated-access",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "consent", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return { data: await service.listDelegatedAccess(organizationId, patientId, nowIso()) };
    },
  );

  // 22. GET /api/v1/consents/:consentId/eval-audit — the per-CONSENT decision audit, CURSOR-paginated
  // (§4.12). Same partitioned sink as route 23, scoped to one record.
  app.get(
    "/api/v1/consents/:consentId/eval-audit",
    { preHandler: [READ_EVAL_AUDIT] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      const q = parse(ConsentEvalAuditQuerySchema, request.query);
      const page = await service.listEvalAudit(
        organizationId,
        { consentId },
        { cursor: q.cursor, pageSize: q.pageSize ?? 50 },
      );
      return { data: page.rows, nextCursor: page.nextCursor };
    },
  );

  // 23. GET /api/v1/consents/eval-audit/by-patient — the consent-DECISION audit, CURSOR-paginated
  // (§4.12; NOT the §164.528 disclosure sink — that is M4's, ADR-0013).
  app.get(
    "/api/v1/consents/eval-audit/by-patient",
    { preHandler: [READ_EVAL_AUDIT] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(EvalAuditQuerySchema, request.query);
      const page = await service.listEvalAudit(
        organizationId,
        { patientId: q.patientId },
        { cursor: q.cursor, pageSize: q.pageSize ?? 50 },
      );
      return { data: page.rows, nextCursor: page.nextCursor };
    },
  );

  // 24. POST /api/v1/consents/:consentId/document/re-render — re-emit m39.consent.signed so M22
  // re-renders the signed PDF (a template fix, a failed first render). Compliance-only + STEP-UP:
  // it republishes a signed consent document.
  app.post(
    "/api/v1/consents/:consentId/document/re-render",
    { preHandler: [ADMIN_RE_RENDER, RE_RENDER_STEP_UP] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      try {
        const receipt = await service.requestDocumentReRender(
          organizationId,
          consentId,
          userId,
          nowIso(),
        );
        reply.code(202);
        return { data: receipt };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 28. GET /api/v1/consents/post-mortem-eligible/:patientId — the M16 consumer view: which of the
  // patient's consents SURVIVE death and which terminate (D13). Read-only; no death is applied here.
  app.get(
    "/api/v1/consents/post-mortem-eligible/:patientId",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "consent", patientIdParam: "patientId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { patientId } = parse(PatientIdParamsSchema, request.params);
      return { data: await service.listPostMortemEligible(organizationId, patientId) };
    },
  );

  // 29. POST /api/v1/consents/bereavement-outreach — the dedicated post-mortem capture path (D14).
  // Its own permission key because the grantor is the BEREAVED person, not the patient, and the
  // patient must actually be deceased — the pure validator refuses otherwise.
  app.post(
    "/api/v1/consents/bereavement-outreach",
    { preHandler: [BEREAVEMENT_AUTHOR, BEREAVEMENT_STEP_UP] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const body = parse(BereavementOutreachBodySchema, request.body);
      try {
        const draft = await service.createBereavementOutreachDraft(organizationId, {
          patientId: body.patientId,
          grantorKind: body.grantorKind as ConsentGrantorKind,
          captureMethod: body.captureMethod as ConsentCaptureMethod,
          scopeDescriptor: body.scopeDescriptor,
          createdById: userId,
        });
        reply.code(201);
        return { data: draft };
      } catch (e) {
        mapError(e);
      }
    },
  );

  // 30. POST /api/v1/consents/:consentId/cascade/retry — re-fire a stuck revocation cascade (D7).
  // A budget-exhausted sweep is NOT a client error: it lands the cascade in its terminal
  // `partial_failed` state (which is what fires the M36 alert) and reports that honestly in the body.
  app.post(
    "/api/v1/consents/:consentId/cascade/retry",
    { preHandler: [CASCADE_ADMIN, CASCADE_STEP_UP] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { consentId } = parse(ConsentIdParamsSchema, request.params);
      try {
        const result = await service.retryRevocationCascade(organizationId, consentId, nowIso());
        reply.code(202);
        return { data: result };
      } catch (e) {
        mapError(e);
      }
    },
  );
}
