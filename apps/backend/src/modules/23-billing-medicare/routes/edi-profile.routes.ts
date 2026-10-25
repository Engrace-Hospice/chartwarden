// apps/backend/src/modules/23-billing-medicare/routes/edi-profile.routes.ts — M23 (migration 1269).
//
// The per-(ProviderEntity, route) EDI profile admin surface: the submitter and receiver parties of the 837I interchange that the
// chart cannot supply. List a provider entity's profiles; PUT one by route key (CLEARINGHOUSE_VENDOR value). Gated by the MAC
// credential permissions (the same setup-wizard step, the same roles): reads `billing.mac_credential.read`, the write
// `billing.mac_credential.admin` + the §D14 step-up. Both compose the §4.7 `provider_entity_billing_scope` predicate over the
// `:providerEntityId` path param; the write adds the §D13 AI-block + `Idempotency-Key`. A first PUT omits `If-Match`; an update
// carries the version last read (428 / 412). No PHI; org and membership binding is server-side.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { parseIfMatch, requireIdempotencyKey } from "./concurrency";
import type { EdiProfileRouteService } from "./edi-profile-service";
import {
  EdiProfileListParamsSchema,
  EdiProfileParamsSchema,
  UpsertEdiProfileBodySchema,
  parse,
} from "./edi-profile-typebox";
import { P, PROVIDER_SCOPE, STEP_UP, targetProviderFromParams } from "./guards";

export interface EdiProfileRouteDeps {
  readonly ediProfileService: EdiProfileRouteService;
}

const READ = P("billing.mac_credential.read");
const READ_ABAC = PROVIDER_SCOPE("billing.mac_credential.read", targetProviderFromParams);
const ADMIN = P("billing.mac_credential.admin");
const ADMIN_ABAC = PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromParams);
const ADMIN_STEPUP = STEP_UP("billing.mac_credential.admin");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** The optional `If-Match` version (present only when updating an existing profile). */
function optionalIfMatch(request: Parameters<typeof parseIfMatch>[0]): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? parseIfMatch(request) : undefined;
}

export function registerEdiProfileRoutes(app: FastifyInstance, deps: EdiProfileRouteDeps): void {
  const { ediProfileService } = deps;

  // GET /billing/edi-profiles/:providerEntityId — every route's profile for the provider entity.
  app.get(
    "/api/v1/billing/edi-profiles/:providerEntityId",
    {
      preHandler: [READ, READ_ABAC],
      config: {
        auditRead: { none: "EDI submitter/receiver party configuration — no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(EdiProfileListParamsSchema, request.params);
      return { profiles: await ediProfileService.listProfiles(actor, providerEntityId) };
    },
  );

  // PUT /billing/edi-profiles/:providerEntityId/:routeKey — create (201) or update (200, If-Match) the profile.
  app.put(
    "/api/v1/billing/edi-profiles/:providerEntityId/:routeKey",
    { preHandler: [ADMIN, ADMIN_ABAC, ADMIN_STEPUP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const key = parse(EdiProfileParamsSchema, request.params);
      const body = parse(UpsertEdiProfileBodySchema, request.body);
      const { created, profile } = await ediProfileService.upsertProfile(
        actor,
        key,
        body,
        optionalIfMatch(request),
      );
      return reply.code(created ? 201 : 200).send(profile);
    },
  );
}
