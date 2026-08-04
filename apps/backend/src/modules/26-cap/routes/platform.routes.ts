// apps/backend/src/modules/26-cap/routes/platform.routes.ts — M26 (§4.1) the PLATFORM cap-constant surface
// (mounted under /api/v1/platform/cap, platform-admin only). List/publish/amend the CMS-published per-cap-year
// amount (D3). Every route composes the §4.7 `cap_platform_admin` ABAC (the actor holds platform_admin); the
// write path requires the elevated cap_platform_loader connection in prod (the composition root binds it).
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_NO_TARGET, P } from "./guards";
import {
  AmendConstantRequest,
  CapYearParams,
  PublishConstantRequest,
  parse,
  validateParams,
} from "./m26-typebox";
import type { M26ReadService } from "./read-service";
import type { M26WriteService } from "./write-service";

export interface PlatformRouteDeps {
  readonly readService: M26ReadService;
  readonly writeService: M26WriteService;
}

const CONST_READ = P("cap.platform_constant.read");
const CONST_MANAGE = P("cap.platform_constant.manage");
const PLATFORM_ADMIN_READ = ABAC_NO_TARGET("cap.platform_constant.read", "cap_platform_admin");
const PLATFORM_ADMIN_MANAGE = ABAC_NO_TARGET("cap.platform_constant.manage", "cap_platform_admin");
const IDEMPOTENT = requireIdempotencyKey();
const pParam = (request: { params: unknown }, key: string): string =>
  (request.params as Record<string, string>)[key] ?? "";

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): void {
  const { readService, writeService } = deps;

  app.get(
    "/api/v1/platform/cap/constants",
    { preHandler: [CONST_READ, PLATFORM_ADMIN_READ] },
    async (_request, reply) => reply.send(await readService.listPlatformConstants()),
  );

  app.post(
    "/api/v1/platform/cap/constants",
    { preHandler: [CONST_MANAGE, PLATFORM_ADMIN_MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(PublishConstantRequest, request.body);
      await writeService.publishConstant(writeActorOf(request), body);
      return reply.code(201).send({ capYear: body.capYear });
    },
  );

  app.patch(
    "/api/v1/platform/cap/constants/:capYear",
    {
      preHandler: [validateParams(CapYearParams), CONST_MANAGE, PLATFORM_ADMIN_MANAGE, IDEMPOTENT],
    },
    async (request, reply) => {
      const body = parse(AmendConstantRequest, request.body);
      const { capYear } = parse(CapYearParams, request.params);
      await writeService.amendConstant(writeActorOf(request), capYear, body);
      return reply.code(204).send();
    },
  );
}
