// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/support-consent-grants.ts — M34 §4.1.
//
// The TENANT-scoped support-consent-grant routes (`withOrgContext` — the tenant's own org, M2 `staff`
// session). A tenant compliance_officer files a `support_consent_grant` (scope + ≤72h expiry) that a
// DISTINCT platform-ops actor may later start a support_session against (the with-consent break-glass
// variant, M34-F01). The §6/D10 step-up table gates the ISSUE route (`passkey_recent_5min`, compliance
// officer). Routes gate on the REAL Authorization Contract (`requirePermission`/`requireStepUp` from
// @chartwarden/auth) on the §4.5 keys M34 registers; handlers compose over the injected TenantRouteService
// (in-memory slice; Drizzle under `withOrgContext` in prod so RLS backstops). LIST is auditRead-declared
// in the Drizzle service (every grant view is a §164.528 disclosure-accounting surface). Mirrors the M22
// registerDocumentRoutes plugin shape EXACTLY.
import { requirePermission, requireStepUp } from "@chartwarden/auth";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import type { TenantRouteService } from "./service";
import {
  GrantListQuerySchema,
  GrantParamsSchema,
  RevokeConsentGrantRequest,
  SupportConsentGrantRequest,
  parse,
} from "./tenant-typebox";

export interface SupportConsentGrantRouteDeps {
  service: TenantRouteService;
}

// §4.5 permission guards.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const LIST = P("support_consent_grant.list_own");
const ISSUE = P("support_consent_grant.issue");
const REVOKE = P("support_consent_grant.revoke");

// §6/D10 step-up — issuing a grant is `passkey_recent_5min` (compliance officer).
const STEP_UP_ISSUE = requireStepUp("support_consent_grant.issue") as PreHandler;

export function registerSupportConsentGrantRoutes(
  app: FastifyInstance,
  deps: SupportConsentGrantRouteDeps,
): void {
  const { service } = deps;

  // list own grants (§4.1).
  app.get("/api/v1/tenant/support-consent-grants", { preHandler: [LIST] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(GrantListQuerySchema, request.query);
    return service.listConsentGrants(organizationId, q.cursor, q.limit);
  });

  // issue a grant — step-up; 72h max expiry; emits m34.support_consent_grant.issued + M36 to platform-ops.
  // ABAC note (§4.1): grantor must hold the compliance_officer role — the route service asserts the role
  // server-side (the spec's "(grantor must be compliance_officer role)" inline rule).
  app.post(
    "/api/v1/tenant/support-consent-grants",
    { preHandler: [ISSUE, STEP_UP_ISSUE] },
    async (request, reply) => {
      const { organizationId, membershipId } = actorOf(request);
      const body = parse(SupportConsentGrantRequest, request.body);
      const res = await service.issueConsentGrant(organizationId, membershipId, {
        scope: body.scope,
        patientIdsInScope: body.patientIdsInScope ?? null,
        grantReason: body.grantReason,
        expiresAtIsoOffsetHours: body.expiresAtIsoOffsetHours,
      });
      return reply.code(201).send(res);
    },
  );

  // revoke a grant — cascades to any open support_session referencing this grant (§4.1).
  app.post(
    "/api/v1/tenant/support-consent-grants/:id/revoke",
    { preHandler: [REVOKE] },
    async (request) => {
      const { organizationId, membershipId } = actorOf(request);
      const { id } = parse(GrantParamsSchema, request.params);
      const body = parse(RevokeConsentGrantRequest, request.body);
      return service.revokeConsentGrant(organizationId, id, membershipId, body.revocationReason);
    },
  );
}
