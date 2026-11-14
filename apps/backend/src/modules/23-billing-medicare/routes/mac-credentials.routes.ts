// apps/backend/src/modules/23-billing-medicare/routes/mac-credentials.routes.ts — M23 (§4.1 §3.6 admin).
//
// The per-ProviderEntity MAC submitter-credential admin surface (the M34 setup-wizard seam): list the
// per-PE credentials (the `client_secret_cipher` is NEVER projected — only a `hasSecret` flag + the safe
// identifiers, §3.6) and UPSERT a credential. The plaintext `clientSecret` is WRITE-ONLY — it is encrypted
// under the per-tenant DEK at the persistence boundary (the §4.4 SecretCipherPort) before it reaches the
// repo, and is redacted from audit value-capture. Reads gate `billing.mac_credential.read`; the upsert gates
// `billing.mac_credential.admin` + the §D14 step-up assertion (privileged config). Both compose the §4.7
// `provider_entity_billing_scope` predicate over the ProviderEntity + the §D13 AI-block on the mutation +
// `Idempotency-Key`. An update carries the §2.5 `If-Match` version (409 STALE_VERSION on stale); a first insert omits it.
import {
  actorOf,
  optionalIfMatchVersionOf,
  parse,
  rejectAiActor,
  requireIdempotencyKey,
} from "@chartwarden/shared/route-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { writeActorOf } from "./actor";
import { MacCredentialListQuerySchema, ProviderEntityParamsSchema } from "./billing-typebox";
import {
  P,
  PROVIDER_SCOPE,
  STEP_UP,
  targetProviderFromBody,
  targetProviderFromParams,
} from "./guards";
import { parseMacCredentialBody } from "./mac-credential-body";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";

export interface MacCredentialRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
  /**
   * Per-user and per-organization cap on `POST .../test` (an outbound call to the MAC gateway per request). Production wires
   * MAC_CREDENTIAL_TEST_ROUTE_RATE_LIMIT, which fails CLOSED: with its store down the route is a typed 503, never an unmetered gateway
   * call. Absent = unlimited (tests only).
   */
  readonly testRateLimit?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const READ = P("billing.mac_credential.read");
const READ_ABAC = PROVIDER_SCOPE("billing.mac_credential.read", targetProviderFromParams);
const ADMIN = P("billing.mac_credential.admin");
const ADMIN_ABAC = PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromBody);
const ADMIN_STEPUP = STEP_UP("billing.mac_credential.admin");
const ADMIN_PARAM_ABAC = PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromParams);
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Register the §4.1 MAC-credential routes (#34–#35). */
export function registerMacCredentialRoutes(
  app: FastifyInstance,
  deps: MacCredentialRouteDeps,
): void {
  const { readService, writeService } = deps;

  // GET /billing/mac-credentials — list per-PE credentials (secrets masked, cursor-paginated). §4.1 #34.
  app.get(
    "/api/v1/billing/mac-credentials",
    {
      preHandler: [READ],
      config: {
        auditRead: {
          none: "MAC submitter credential metadata (never the secret) — no patient data",
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const q = parse(MacCredentialListQuerySchema, request.query);
      return readService.listMacCredentials(actor, q.cursor, q.limit);
    },
  );

  // GET /billing/mac-credentials/:providerEntityId — the credential for one PE (or null). §4.1.
  app.get(
    "/api/v1/billing/mac-credentials/:providerEntityId",
    {
      preHandler: [READ, READ_ABAC],
      config: {
        auditRead: { none: "one provider entity's MAC credential metadata — no patient data" },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(ProviderEntityParamsSchema, request.params);
      return readService.getMacCredential(actor, providerEntityId);
    },
  );

  // POST /billing/mac-credentials/:providerEntityId/test — check that the MAC portal for the PE's credential's jurisdiction
  // answers and stamp `last_sandbox_test_at` when it does. §4.1 #36 (GAP-144). It does NOT validate the credential: the probe
  // sends no secret, client id or submitter id (the first real submission is their first use). Step-up (privileged config) + the
  // provider scope + AI block + Idempotency-Key; the secret is never read, returned or logged.
  app.post(
    "/api/v1/billing/mac-credentials/:providerEntityId/test",
    {
      // The limiter runs AFTER the permission and step-up guards, so a caller who may not test never spends the budget.
      preHandler: [
        ADMIN,
        ADMIN_PARAM_ABAC,
        ADMIN_STEPUP,
        NO_AI,
        IDEMPOTENT,
        ...(deps.testRateLimit ? [deps.testRateLimit as never] : []),
      ],
    },
    async (request) => {
      const actor = writeActorOf(request);
      const { providerEntityId } = parse(ProviderEntityParamsSchema, request.params);
      return writeService.testMacCredential(actor, providerEntityId);
    },
  );

  // POST /billing/mac-credentials — upsert a credential (step-up; secret encrypted at the boundary). #35.
  app.post(
    "/api/v1/billing/mac-credentials",
    { preHandler: [ADMIN, ADMIN_ABAC, ADMIN_STEPUP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parseMacCredentialBody(request.body);
      const expectedVersion = optionalIfMatchVersionOf(request);
      const res = await writeService.upsertMacCredential(actor, {
        providerEntityId: body.providerEntityId,
        macJurisdiction: body.macJurisdiction,
        submitterId: body.submitterId,
        tradingPartnerId: body.tradingPartnerId,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        baaRecordRef: body.baaRecordRef,
        credentialExpiresAt: body.credentialExpiresAt,
        expectedVersion,
      });
      return reply.code(expectedVersion === undefined ? 201 : 200).send(res);
    },
  );
}
