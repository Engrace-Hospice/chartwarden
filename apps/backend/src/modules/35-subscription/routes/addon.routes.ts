// apps/backend/src/modules/35-subscription/routes/addon.routes.ts — ADR-0108 the claims-billing add-on, platform-ops
// surface (`/api/admin`). Reads gate on `subscription.admin.read` + `platform_billing_scope`; grant / cancel reuse
// `subscription.admin.write` + platform scope + a fresh step-up + the AI-actor block + `Idempotency-Key` (no new permission keys). The
// acting membership is taken from `request.context`, never the body. Writes run on the platform runner only.
import type { FastifyInstance } from "fastify";
// The same D13 AI-actor block the M23 NPI-verification writes compose: the add-on decides who may start claims billing.
import { rejectAiActor } from "../../../bootstrap/reject-ai-actor";
import type { AddonService } from "../addon/addon-service";
import { writeActorOf } from "./actor";
import { IDEMPOTENT, P, PLATFORM_SCOPE, STEP_UP } from "./guards";
import {
  GrantAddonBodySchema,
  IdParamsSchema,
  SubscriptionAddonParamsSchema,
  parse,
} from "./subscription-typebox";

export interface AddonRouteDeps {
  readonly addons: AddonService;
}

const WRITE = "subscription.admin.write";
const READ = "subscription.admin.read";

export function registerAddonRoutes(app: FastifyInstance, deps: AddonRouteDeps): void {
  const { addons } = deps;
  const writeGuards = [
    P(WRITE),
    PLATFORM_SCOPE(WRITE),
    STEP_UP(WRITE),
    rejectAiActor(),
    IDEMPOTENT,
  ];

  app.get("/api/admin/addons", { preHandler: [P(READ), PLATFORM_SCOPE(READ)] }, async () =>
    addons.listAddons(),
  );
  app.get(
    "/api/admin/subscriptions/:id/addons",
    { preHandler: [P(READ), PLATFORM_SCOPE(READ)] },
    async (request) => {
      const { id } = parse(IdParamsSchema, request.params);
      return addons.listSubscriptionAddons(id);
    },
  );
  app.post(
    "/api/admin/subscriptions/:id/addons",
    { preHandler: writeGuards },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const { id } = parse(IdParamsSchema, request.params);
      const body = parse(GrantAddonBodySchema, request.body);
      return reply.code(201).send(await addons.grantAddon(actor, id, body));
    },
  );
  app.post(
    "/api/admin/subscriptions/:id/addons/:addonId/cancel",
    { preHandler: writeGuards },
    async (request) => {
      const actor = writeActorOf(request);
      const { id, addonId } = parse(SubscriptionAddonParamsSchema, request.params);
      return addons.cancelAddon(actor, id, addonId);
    },
  );
}
