// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/feature-flags-admin.ts — M34 (§4.1
// platform-ops; §4.7 / D13). The feature-flag ADMIN routes M34 OWNS: M34 contributes the admin UI + the
// platform-ops authentication boundary, but M1 owns the `feature_flag` SCHEMA + the `FeatureFlagAdmin`
// seam (CRUD + kill switch). These routes DELEGATE the write to `m1.featureFlagAdmin.upsert(...)` /
// `.killSwitch(...)` — the M34 route is the auth boundary; the actual write is M1 (§4.7). Dependency-
// cruiser confirms M34 never imports M1's `feature_flag` schema directly: the seam is reached OPAQUELY in
// the route-service adapter (Phase 2D via `getSeam(...)`), so no `@chartwarden/db` flag-schema edge is created
// and M34 `dependsOn` stays `[1,2,3,4,36]` (the M22 forward-seam precedent).
//
// List (platform-global + per-tenant flags) is fully live (read via the M1 admin seam under
// `withPlatformContext` → typed page). Write + kill-switch carry `feature_flag_write_authority` ABAC
// (global flag → platform-ops only; per-tenant flag → org_admin) + passkey-recent-5min step-up (§6 / D10).
// The M36 `feature_flag.platform_emergency_changed` alert (plus the outbox row and the critical audit) on
// kill-switch is the M1 seam's emission, in-tx with the write. Mirrors the sibling tenants.ts plugin shape.
import {
  type GuardRequest,
  requireAbac,
  requirePermission,
  requireStepUp,
} from "@chartwarden/auth";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  FeatureFlagListQuerySchema,
  FeatureFlagParamsSchema,
  KillSwitchRequest,
  UpsertFeatureFlagRequest,
  parse,
} from "./platform-typebox";
import type { TenantPlatformRouteService } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface FeatureFlagAdminRouteDeps {
  /** The §4.7 platform-ops route service — a thin boundary over M1's `FeatureFlagAdmin` seam (D13). */
  service: TenantPlatformRouteService;
}

function actorOf(request: FastifyRequest): {
  userId: string;
  organizationId: string;
  membershipId: string | null;
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  return {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    membershipId: typeof membershipId === "string" && membershipId.length > 0 ? membershipId : null,
  };
}

const flagKeyOf = (request: FastifyRequest): string =>
  parse(FeatureFlagParamsSchema, request.params).flagKey;

const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const READ = P("feature_flag.read_platform");
const WRITE = P("feature_flag.write_platform");
const KILL = P("feature_flag.kill_switch");

// §4.6 — the write/kill-switch ABAC predicate resolves the flag's owner facts (global → platform-ops only;
// per-tenant → org_admin). The `flagKey` target is server-resolved (the row), surfaced on the param/body so
// the `feature_flag_write_authority` predicate is exercisable end-to-end. List gates on platform-ops.
// The target also carries the SCOPE the write names (`organizationId`, absent/null = platform-global): the
// predicate resolves the flag at exactly that scope and the resolver validates it against server rows, so a
// per-tenant flag in another org and a same-key global flag are told apart. The body is never trusted on its
// own — an unknown tenant scope denies.
const flagKeyTarget = (request: GuardRequest): Record<string, unknown> => {
  const p = request.params as { flagKey?: unknown } | undefined;
  const b = request.body as { flagKey?: unknown; organizationId?: unknown } | undefined;
  return { flagKey: p?.flagKey ?? b?.flagKey, organizationId: b?.organizationId };
};
const ABAC_PLATFORM_OPS = requireAbac(
  "feature_flag.read_platform",
  "tenant_lifecycle_platform_ops",
) as PreHandler;
const ABAC_WRITE = requireAbac("feature_flag.write_platform", "feature_flag_write_authority", {
  getTarget: flagKeyTarget,
}) as PreHandler;
const ABAC_KILL = requireAbac("feature_flag.kill_switch", "feature_flag_write_authority", {
  getTarget: flagKeyTarget,
}) as PreHandler;

// §6/D10 step-up (passkey_recent_5min on both the flag write and the kill switch).
const STEPUP_WRITE = requireStepUp("feature_flag.write_platform") as PreHandler;
const STEPUP_KILL = requireStepUp("feature_flag.kill_switch") as PreHandler;

export function registerFeatureFlagAdminRoutes(
  app: FastifyInstance,
  deps: FeatureFlagAdminRouteDeps,
): void {
  const { service } = deps;

  // 1 — list platform-global + per-tenant flags (read via the M1 admin seam; cursor-paginated). §4.1.
  app.get(
    "/api/v1/platform/feature-flags",
    { preHandler: [READ, ABAC_PLATFORM_OPS] },
    async (request) => {
      actorOf(request);
      const q = parse(FeatureFlagListQuerySchema, request.query);
      return service.listFeatureFlags(
        { organizationId: q.organizationId, flagKind: q.flagKind },
        q.cursor,
        q.limit,
      );
    },
  );

  // 2 — create/update a flag → delegates to `m1.featureFlagAdmin.upsert(...)` (D13; §4.7). §4.1.
  app.post(
    "/api/v1/platform/feature-flags",
    { preHandler: [WRITE, ABAC_WRITE, STEPUP_WRITE] },
    async (request, reply) => {
      const { userId } = actorOf(request);
      const body = parse(UpsertFeatureFlagRequest, request.body);
      const res = await service.upsertFeatureFlag(userId, {
        flagKey: body.flagKey,
        organizationId: body.organizationId ?? null,
        flagKind: body.flagKind,
        valueType: body.valueType,
        value: body.value,
        rolloutPercent: body.rolloutPercent ?? null,
        rationale: body.rationale ?? null,
      });
      return reply.code(201).send(res);
    },
  );

  // 3 — toggle a flag's kill switch → delegates to `m1.featureFlagAdmin.killSwitch(...)`; the M36
  // `feature_flag.platform_emergency_changed` alert is the seam's in-tx emission. §4.1.
  app.post(
    "/api/v1/platform/feature-flags/:flagKey/kill-switch",
    { preHandler: [KILL, ABAC_KILL, STEPUP_KILL] },
    async (request) => {
      const { userId, organizationId, membershipId } = actorOf(request);
      const body = parse(KillSwitchRequest, request.body);
      return service.setKillSwitch(userId, {
        flagKey: flagKeyOf(request),
        organizationId: body.organizationId ?? null,
        killSwitchActive: body.killSwitchActive,
        actorOrganizationId: organizationId,
        actorMembershipId: membershipId,
      });
    },
  );
}
