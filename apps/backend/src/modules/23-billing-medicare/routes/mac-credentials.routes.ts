// apps/backend/src/modules/23-billing-medicare/routes/mac-credentials.routes.ts — M23 (§4.1 §3.6 admin).
//
// The per-ProviderEntity MAC submitter-credential admin surface (the M34 setup-wizard seam): list the
// per-PE credentials (the `client_secret_cipher` is NEVER projected — only a `hasSecret` flag + the safe
// identifiers, §3.6) and UPSERT a credential. The plaintext `clientSecret` is WRITE-ONLY — it is encrypted
// under the per-tenant DEK at the persistence boundary (the §4.4 SecretCipherPort) before it reaches the
// repo, and is redacted from audit value-capture. Reads gate `billing.mac_credential.read`; the upsert gates
// `billing.mac_credential.admin` + the §D14 step-up assertion (privileged config). Both compose the §4.7
// `provider_entity_billing_scope` predicate over the ProviderEntity + the §D13 AI-block on the mutation +
// `Idempotency-Key`. An update carries the §2.5 `If-Match` version (412 on stale); a first insert omits it.
import type { FastifyInstance } from "fastify";
import { actorOf, rejectAiActor, writeActorOf } from "./actor";
import { parseIfMatch, requireIdempotencyKey } from "./concurrency";
import { P, PROVIDER_SCOPE, STEP_UP, targetProviderFromBody, targetProviderFromParams } from "./guards";
import type { M23ReadRouteService } from "./read-service";
import type { M23WriteRouteService } from "./write-service";
import {
  MacCredentialListQuerySchema,
  ProviderEntityParamsSchema,
  UpsertMacCredentialBodySchema,
  parse,
} from "./billing-typebox";

export interface MacCredentialRouteDeps {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
}

const READ = P("billing.mac_credential.read");
const READ_ABAC = PROVIDER_SCOPE("billing.mac_credential.read", targetProviderFromParams);
const ADMIN = P("billing.mac_credential.admin");
const ADMIN_ABAC = PROVIDER_SCOPE("billing.mac_credential.admin", targetProviderFromBody);
const ADMIN_STEPUP = STEP_UP("billing.mac_credential.admin");
const NO_AI = rejectAiActor();
const IDEMPOTENT = requireIdempotencyKey();

/** Read the optional `If-Match` version (present only on an update of an existing credential, §2.5). */
function optionalIfMatch(request: Parameters<typeof parseIfMatch>[0]): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? parseIfMatch(request) : undefined;
}

/** Register the §4.1 MAC-credential routes (#34–#35). */
export function registerMacCredentialRoutes(app: FastifyInstance, deps: MacCredentialRouteDeps): void {
  const { readService, writeService } = deps;

  // GET /billing/mac-credentials — list per-PE credentials (secrets masked, cursor-paginated). §4.1 #34.
  app.get("/api/v1/billing/mac-credentials", { preHandler: [READ] }, async (request) => {
    const actor = actorOf(request);
    const q = parse(MacCredentialListQuerySchema, request.query);
    return readService.listMacCredentials(actor, q.cursor, q.limit);
  });

  // GET /billing/mac-credentials/:providerEntityId — the credential for one PE (or null). §4.1.
  app.get(
    "/api/v1/billing/mac-credentials/:providerEntityId",
    { preHandler: [READ, READ_ABAC] },
    async (request) => {
      const actor = actorOf(request);
      const { providerEntityId } = parse(ProviderEntityParamsSchema, request.params);
      return readService.getMacCredential(actor, providerEntityId);
    },
  );

  // POST /billing/mac-credentials — upsert a credential (step-up; secret encrypted at the boundary). #35.
  app.post(
    "/api/v1/billing/mac-credentials",
    { preHandler: [ADMIN, ADMIN_ABAC, ADMIN_STEPUP, NO_AI, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const body = parse(UpsertMacCredentialBodySchema, request.body);
      const expectedVersion = optionalIfMatch(request);
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
