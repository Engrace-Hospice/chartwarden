// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/baa-register.ts — M34 (§4.1
// platform-ops; §3.8 / D11). The platform→tenant Business Associate Agreement register (DISTINCT from
// M40's tenant→external BAA register). List (all tenants' BAA records, across addendum versions), create
// (file a new `platform_tenant_baa_record` for a (tenant_account, addendum_version) — UNIQUE), update
// (execution / termination / dates / contacts / document linkage). Not a PHI table (BAA status +
// references only), so reads do not `auditRead`; the M4 write-audit trigger backstops the mutations.
//
// All three routes are platform-ops (the register spans tenants → `withPlatformContext` cross-tenant in
// prod); the §4.1 platform-ops surface authorizes the whole register CRUD off `tenant_lifecycle_platform_ops`
// + the `platform_tenant_baa.read_platform` key. The compliance-officer ATTESTATION route lives on the
// tenant surface (`POST /api/v1/tenant/baa/:id/attest`, a separate group) — this group is the platform-ops
// register CRUD only. Org/actor binding is server-side. Mirrors the sibling tenants.ts plugin shape.
import { requireAbac, requirePermission } from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BaaParamsSchema,
  BaaRegisterListQuerySchema,
  CreateBaaRequest,
  UpdateBaaRequest,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface BaaRegisterRouteDeps {
  /** The §4.1 platform-ops route service (in-memory slice; Drizzle under `withPlatformContext` in prod). */
  service: TenantPlatformRouteService;
}

function actorOf(request: FastifyRequest): { userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { userId: ctx.userId };
}

const baaIdOf = (request: FastifyRequest): string => parse(BaaParamsSchema, request.params).id;

const READ = requirePermission("platform_tenant_baa.read_platform") as PreHandler;
const ABAC_PLATFORM_OPS = requireAbac(
  "platform_tenant_baa.read_platform",
  "tenant_lifecycle_platform_ops",
) as PreHandler;

export function registerBaaRegisterRoutes(app: FastifyInstance, deps: BaaRegisterRouteDeps): void {
  const { service } = deps;

  // 1 — list the platform-tenant BAA register across tenants (cursor-paginated; tenant/status filters). §4.1.
  app.get(
    "/api/v1/platform/baa-register",
    { preHandler: [READ, ABAC_PLATFORM_OPS] },
    async (request) => {
      actorOf(request);
      const q = parse(BaaRegisterListQuerySchema, request.query);
      return service.listBaaRecords(
        { tenantAccountId: q.tenantAccountId, status: q.status },
        q.cursor,
        q.limit,
      );
    },
  );

  // 2 — file a new BAA record for a (tenant_account, addendum_version) (UNIQUE; §3.8). §4.1.
  app.post(
    "/api/v1/platform/baa-register",
    { preHandler: [READ, ABAC_PLATFORM_OPS] },
    async (request, reply) => {
      const { userId } = actorOf(request);
      const body = parse(CreateBaaRequest, request.body);
      const res = await service.createBaaRecord(userId, {
        tenantAccountId: body.tenantAccountId,
        addendumVersion: body.addendumVersion,
        baaStatus: body.baaStatus,
        executedOn: body.executedOn ?? null,
        effectiveOn: body.effectiveOn ?? null,
        expiresOn: body.expiresOn ?? null,
        breachNotificationContactEmail: body.breachNotificationContactEmail ?? null,
        breachNotificationContactPhone: body.breachNotificationContactPhone ?? null,
      });
      return reply.code(201).send(res);
    },
  );

  // 3 — update a BAA record (execution / termination / dates / contacts / document linkage). §4.1.
  app.patch(
    "/api/v1/platform/baa-register/:id",
    { preHandler: [READ, ABAC_PLATFORM_OPS] },
    async (request) => {
      const { userId } = actorOf(request);
      const body = parse(UpdateBaaRequest, request.body);
      return service.updateBaaRecord(baaIdOf(request), userId, {
        baaStatus: body.baaStatus,
        executedOn: body.executedOn,
        effectiveOn: body.effectiveOn,
        expiresOn: body.expiresOn,
        breachNotificationContactEmail: body.breachNotificationContactEmail,
        breachNotificationContactPhone: body.breachNotificationContactPhone,
        documentId: body.documentId,
      });
    },
  );
}
