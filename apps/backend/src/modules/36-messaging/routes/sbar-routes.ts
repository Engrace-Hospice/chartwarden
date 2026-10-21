// apps/backend/src/modules/36-messaging/routes/sbar-routes.ts - M36 WP 3.3 SBAR policy.
//
//   GET    /api/v1/messaging/sbar/policy                       the effective policy for the composer   (messaging.send)
//   PUT    /api/v1/messaging/template-admin/sbar-policy        replace the tenant's tighten-only policy (messaging.template.manage)
//   DELETE /api/v1/messaging/template-admin/sbar-policy        back to the platform defaults           (messaging.template.manage)
//
// GET is a 404 while the tenant flag `messaging.sbar` is off (the feature does not exist). Org and actor are always the
// server-side request context. The write-time checks on a message live in sbar/sbar-write-check.ts, not here; this file
// also exports the route-level flag check the send and edit routes call when a body contains an sbar block.
import { requirePermission } from "@chartwarden/auth";
import { effectiveSbarPolicy, prepareSbarPolicy } from "@chartwarden/messaging";
import {
  NotFoundError,
  type RichBody,
  SBAR_MAX_SECTION_CHARS,
  UnauthorizedError,
  richBodySbar,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SbarPolicyStore } from "../sbar/sbar-policy-store-db";
import { sbarNotAvailable } from "../sbar/sbar-write-check";
import { parse } from "./messaging-typebox";
import { PutSbarPolicyBodySchema } from "./sbar-typebox";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SbarRouteDeps {
  /** The tenant flag `messaging.sbar`. A throw reads as off (fail closed). */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly store: SbarPolicyStore;
}

/** Used when the boot supplies none: flag off, so SBAR is refused on write and the policy route 404s. */
export const DISABLED_SBAR: SbarRouteDeps = {
  isEnabled: async () => false,
  store: {
    read: async () => null,
    put: async () => undefined,
    remove: async () => undefined,
  },
};

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

const flagOn = (deps: SbarRouteDeps, organizationId: string): Promise<boolean> =>
  deps.isEnabled(organizationId).catch(() => false);

/** Write-time flag check for a send/edit body: no sbar block => untouched; flag off => 422 SBAR_NOT_AVAILABLE. */
export async function assertSbarFlag(
  request: FastifyRequest,
  deps: SbarRouteDeps,
  richBody: RichBody | undefined,
): Promise<void> {
  const { organizationId } = actorOf(request);
  if (!richBody || richBodySbar(richBody) === null) return;
  if (!(await flagOn(deps, organizationId))) throw sbarNotAvailable();
}

function policyView(stored: Awaited<ReturnType<SbarPolicyStore["read"]>>) {
  const policy = effectiveSbarPolicy(stored);
  return {
    minChars: policy.minChars,
    maxChars: SBAR_MAX_SECTION_CHARS,
    requirePatientChannel: policy.requirePatientChannel,
    hints: policy.hints,
    customized: stored !== null,
  };
}

export function registerSbarRoutes(app: FastifyInstance, deps: SbarRouteDeps): void {
  const SEND = requirePermission("messaging.send") as PreHandler;
  const MANAGE = requirePermission("messaging.template.manage") as PreHandler;
  const { store } = deps;

  app.get(
    "/api/v1/messaging/sbar/policy",
    {
      preHandler: [SEND],
      config: {
        auditRead: { none: "SBAR policy is organisation configuration: no patient data" },
      },
    },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      if (!(await flagOn(deps, organizationId))) throw new NotFoundError("sbar_policy");
      return policyView(await store.read(organizationId, userId));
    },
  );

  app.put(
    "/api/v1/messaging/template-admin/sbar-policy",
    { preHandler: [MANAGE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const prepared = prepareSbarPolicy(parse(PutSbarPolicyBodySchema, request.body));
      await store.put(organizationId, userId, prepared);
      return policyView(prepared);
    },
  );

  app.delete(
    "/api/v1/messaging/template-admin/sbar-policy",
    { preHandler: [MANAGE] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      await store.remove(organizationId, userId);
      return reply.code(204).send();
    },
  );
}
