// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/tenants.ts — M34 (§4.1 platform-ops).
//
// The platform-ops tenant-lifecycle route surface (§4.1 platform-ops table; §4.2 per-route specs; §6/D10
// step-up table). Every route is gated by the REAL Authorization Contract (`requirePermission` /
// `requireAbac` / `requireStepUp` from @wardenx/auth, M3) on the §4.5 keys M34 registers into M3's catalog
// (M34_CONTRIBUTED_PERMISSIONS) + the `tenant_lifecycle_platform_ops` ABAC predicate M34 owns
// (./abac-predicates). Cross-tenant reads run under `withPlatformContext` (M1 @wardenx/tenancy — the
// separately-pooled, RLS-bypass, AUDITED platform-ops read path, F03/F09) in prod; org/actor binding is
// ALWAYS server-side (`request.context`, never the body). Mirrors the M22 routes/documents-routes.ts shape.
//
// READ/LIST routes (which the Phase-3 platform-ops screens consume) are fully live: the handlers compose
// over the injected TenantPlatformRouteService → `withPlatformContext` → typed response, and `auditRead()`
// records every cross-tenant PHI-adjacent read (HIPAA §164.312(b) + the F09 bypass-audit guarantee).
// The lifecycle-COMMAND routes (provision / status / offboard / shred / dek-rotate) ENQUEUE the matching
// §4.3 worker job through the service's injected enqueue port + emit the outbox descriptor; the live
// BullMQ worker construction is Phase 2D (see service.ts TODO).
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DekRotateRequest,
  OffboardTenantRequest,
  OrgSlugParamsSchema,
  ProvisionTenantRequest,
  ShredTenantRequest,
  StatusTransitionRequest,
  TenantListQuerySchema,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface TenantPlatformRouteDeps {
  /** The §4.1 platform-ops route service (in-memory in the slice; Drizzle under `withPlatformContext` in prod). */
  service: TenantPlatformRouteService;
}

/** The org-scoped actor (org/actor binding is server-side: the context, never the body). */
function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  membershipId: string;
  roles: readonly string[];
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, membershipId, roles: ctx.roles };
}

const orgSlugOf = (request: FastifyRequest): string =>
  parse(OrgSlugParamsSchema, request.params).orgSlug;

// §4.5 permission guards on the §4.1 platform-ops keys.
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const LIST = P("tenant.list_platform");
const READ = P("tenant.read_platform");
const PROVISION = P("tenant.provision");
const TRANSITION = P("tenant.transition_status");
const OFFBOARD = P("tenant.offboard");
const SHRED = P("tenant.shred.execute");
const DEK_ROTATE = P("tenant.dek_rotate");

// §4.6 — `tenant_lifecycle_platform_ops` ABAC (the actor holds the `platform_ops` M3 RBAC role, F03).
const A = (key: string): PreHandler =>
  requireAbac(key, "tenant_lifecycle_platform_ops") as PreHandler;
const ABAC_LIST = A("tenant.list_platform");
const ABAC_READ = A("tenant.read_platform");
const ABAC_PROVISION = A("tenant.provision");
const ABAC_TRANSITION = A("tenant.transition_status");
const ABAC_OFFBOARD = A("tenant.offboard");
const ABAC_SHRED = A("tenant.shred.execute");
const ABAC_DEK_ROTATE = A("tenant.dek_rotate");

// §6/D10 step-up — the command routes require recent M2 SESSION_POLICY step-up (the operation key drives
// M3-T07's per-operation freshness policy: provision/offboard/dek-rotate=passkey_recent_5min,
// status=passkey_recent_5min (terminal)/password_recent_15min (reversible), shred=passkey_recent_2min+cosign).
const STEPUP = (op: string): PreHandler => requireStepUp(op) as PreHandler;
const STEPUP_PROVISION = STEPUP("tenant.provision");
const STEPUP_TRANSITION = STEPUP("tenant.transition_status");
const STEPUP_OFFBOARD = STEPUP("tenant.offboard");
const STEPUP_SHRED = STEPUP("tenant.shred.execute");
const STEPUP_DEK_ROTATE = STEPUP("tenant.dek_rotate");

/**
 * Register the §4.1 platform-ops tenant-lifecycle routes. Mounted by the composition root behind the
 * same authenticate/security/error chain when a DB client is present (the M36 `mountMessagingRoutes`
 * precedent). The auditRead marker on the read routes is the F09 platform-bypass audit anchor.
 */
export function registerTenantPlatformRoutes(
  app: FastifyInstance,
  deps: TenantPlatformRouteDeps,
): void {
  const { service } = deps;

  // 1 — list tenants (cross-tenant, cursor-paginated; filters status/plan/created_after/legal-name). §4.1.
  app.get("/api/v1/platform/tenants", { preHandler: [LIST, ABAC_LIST] }, async (request) => {
    actorOf(request);
    const q = parse(TenantListQuerySchema, request.query);
    return service.listTenants(
      { status: q.status, planLabel: q.planLabel, createdAfter: q.createdAfter, search: q.search },
      q.cursor,
      q.limit,
    );
  });

  // 3 — provision a tenant from a signup_intent OR raw input (step-up; enqueues `tenant.provision`). §4.1/§4.2.
  app.post(
    "/api/v1/platform/tenants",
    { preHandler: [PROVISION, ABAC_PROVISION, STEPUP_PROVISION] },
    async (request, reply) => {
      const { membershipId } = actorOf(request);
      const body = parse(ProvisionTenantRequest, request.body);
      const res = await service.provisionTenant(membershipId, {
        signupIntentId: body.signupIntentId ?? null,
        legalBusinessName: body.legalBusinessName,
        billingContactEmail: body.billingContactEmail,
        breachNotificationContactEmail: body.breachNotificationContactEmail,
        firstAdminEmail: body.firstAdminEmail,
        firstAdminFullName: body.firstAdminFullName,
        planLabel: body.planLabel,
      });
      return reply.code(202).send(res);
    },
  );

  // 2 — full tenant overview (§5.2: account + latest status_event + key_ring meta + onboarding + BAA). §4.1.
  app.get(
    "/api/v1/platform/tenants/:orgSlug",
    { preHandler: [READ, ABAC_READ] },
    async (request) => {
      actorOf(request);
      return service.getTenantOverview(orgSlugOf(request));
    },
  );

  // 4 — apply a lifecycle status transition (step-up; the eleven-state machine guards apply). §4.1/§4.2.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/status",
    { preHandler: [TRANSITION, ABAC_TRANSITION, STEPUP_TRANSITION] },
    async (request, reply) => {
      const { userId } = actorOf(request);
      const body = parse(StatusTransitionRequest, request.body);
      const res = await service.transitionStatus(orgSlugOf(request), userId, {
        toStatus: body.toStatus,
        transitionReason: body.transitionReason,
      });
      return reply.code(202).send(res);
    },
  );

  // 5 — initiate offboarding (step-up; active|suspended|at_risk → offboarding_initiated cascade). §4.1.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/offboard",
    { preHandler: [OFFBOARD, ABAC_OFFBOARD, STEPUP_OFFBOARD] },
    async (request, reply) => {
      const { userId } = actorOf(request);
      const body = parse(OffboardTenantRequest, request.body);
      const res = await service.offboardTenant(orgSlugOf(request), userId, {
        transitionReason: body.transitionReason,
        exportPurpose: body.exportPurpose,
      });
      return reply.code(202).send(res);
    },
  );

  // 6 — execute the cryptographic shred (passkey_recent_2min + co-signer; enqueues `tenant.shred`). §4.1/§6.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/shred",
    { preHandler: [SHRED, ABAC_SHRED, STEPUP_SHRED] },
    async (request, reply) => {
      const { membershipId } = actorOf(request);
      const body = parse(ShredTenantRequest, request.body);
      const res = await service.requestShred(orgSlugOf(request), membershipId, {
        transitionReason: body.transitionReason,
        destructionCertificateId: body.destructionCertificateId,
      });
      return reply.code(202).send(res);
    },
  );

  // 7 — request a DEK rotation (step-up; enqueues `tenant.dek_rotate`; manual trigger only Phase 1). §4.1.
  app.post(
    "/api/v1/platform/tenants/:orgSlug/dek-rotate",
    { preHandler: [DEK_ROTATE, ABAC_DEK_ROTATE, STEPUP_DEK_ROTATE] },
    async (request, reply) => {
      const { membershipId } = actorOf(request);
      const body = parse(DekRotateRequest, request.body);
      const res = await service.requestDekRotate(orgSlugOf(request), membershipId, {
        reason: body.reason,
      });
      return reply.code(202).send(res);
    },
  );
}
