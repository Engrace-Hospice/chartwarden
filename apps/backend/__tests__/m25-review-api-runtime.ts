/**
 * Disposable source-mounted Fastify runtime used only by the M25 live qualification suite.
 * It deliberately has the same app-side secrets as the production API needs for this path:
 * app DB, Better Auth session lookup, and the command-signing key. It does not receive the
 * evaluator writer/source DB credentials or the Claim.MD artifact keyring.
 */
import { readFileSync } from "node:fs";
import {
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbSessionContextStore,
  createDbSessionTimeoutEnforcer,
  createIdentityAuth,
  createIdentityCredentialAdmin,
  getIdentitySession,
  registerDbEffectivePermissionResolver,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { createClaimMdProtectedPayloadCipher } from "../src/bootstrap/claimmd-payload-cipher";
import { type AuthenticateHook, buildServer, getSeam } from "../src/bootstrap/index";
import { createSessionAuthenticate } from "../src/bootstrap/plugins/authenticate";
import { mountIdentityRoutes } from "../src/modules/02-identity";
import { registerIdentitySeams } from "../src/modules/02-identity/seams";
import { registerAuthorizationAbacPredicates } from "../src/modules/03-authorization/abac-predicates";
import { registerAuthorizationSeams } from "../src/modules/03-authorization/seams";
import { claimMdInboxKeyRingFromEnv } from "../src/modules/23-billing-medicare/claimmd-identity/config";
import { registerM25AbacPredicates } from "../src/modules/25-remittance/abac-predicates";
import {
  createMedicaidEraReviewService,
  unavailableMedicaidEraReviewReaders,
} from "../src/modules/25-remittance/domain/medicaid-era-review-service";
import { buildDrizzleClaimMdEraReviewService } from "../src/modules/25-remittance/ingest/claimmd-era-review";
import { bindConfiguredRemoteEvaluatorWrites } from "../src/modules/25-remittance/ingest/isolated-evaluator-command";
import { buildDrizzleMedicaidEraReviewWorkflow } from "../src/modules/25-remittance/ingest/medicaid-era-review-service";
import type { M25ReadService, M25WriteService } from "../src/modules/25-remittance/routes";
import { mountM25Routes } from "../src/modules/25-remittance/routes/mount";

if (process.env.M25_TEST_API_RUNTIME !== "1") {
  throw new Error("M25_TEST_API_RUNTIME=1 is required for the disposable API runtime");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the disposable API runtime");
if (process.env.M25_EVALUATOR_ENABLED !== "true")
  throw new Error("the isolated evaluator must be enabled in the disposable API runtime");

const dbHandle = createDbClient({ connectionString: databaseUrl, max: 5 });
const auth = createIdentityAuth(dbHandle.db as never, {
  authLogger: () => undefined,
});
const actorEnrichment = createDbActorEnrichmentReader(dbHandle.db);
const sessionStore = createDbSessionContextStore(dbHandle.db, actorEnrichment);
const authenticate: AuthenticateHook = createSessionAuthenticate({
  getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
  getResolver: () => getSeam("SessionContextResolver"),
  sessionTimeout: createDbSessionTimeoutEnforcer(dbHandle.db),
  // These real composition-required gates are unrelated to the M25 review routes; the synthetic
  // org is an already-live org and no note-closing surface is mounted by this focused API runtime.
  organizationStage: { isConfined: async () => false },
  noteClosureGate: { assertMayCall: async () => undefined },
});

registerDbEffectivePermissionResolver(dbHandle.db);
const unavailableOnlyEvaluator = createMedicaidEraReviewService(
  unavailableMedicaidEraReviewReaders,
);
const localWorkflow = buildDrizzleMedicaidEraReviewWorkflow(dbHandle.db, unavailableOnlyEvaluator);
const medicaidEraReviewService = bindConfiguredRemoteEvaluatorWrites(localWorkflow, process.env);
const claimMdKeyRingPath = process.env.M25_TEST_CLAIMMD_KEYRING_FILE;
const claimMdKeyRing = claimMdKeyRingPath
  ? claimMdInboxKeyRingFromEnv({
      CLAIMMD_RESPONSE_INBOX_KEYRING: readFileSync(claimMdKeyRingPath, "utf8"),
    })
  : null;
if (claimMdKeyRingPath && !claimMdKeyRing)
  throw new Error("the synthetic Claim.MD review key ring is invalid");
const claimMdEraReviewService = claimMdKeyRing
  ? buildDrizzleClaimMdEraReviewService(
      dbHandle.db,
      createClaimMdProtectedPayloadCipher(claimMdKeyRing, "claimmd-era-stage:v1"),
    )
  : undefined;

const server = buildServer({
  db: dbHandle.db,
  authenticate,
  security: { rateLimitEnabled: false },
  registerModuleSeams: () => {
    registerIdentitySeams({ sessions: sessionStore, db: dbHandle.db });
    registerAuthorizationSeams({ db: dbHandle.db });
    registerAuthorizationAbacPredicates();
    registerM25AbacPredicates({ db: dbHandle.db });
  },
  registerModuleRoutes: (app) => {
    mountIdentityRoutes(app, dbHandle.db, createDbAdminMembershipReader(dbHandle.db), {
      credentialAdmin: createIdentityCredentialAdmin(auth),
      // The integrated journey reads identity state only. Refuse unrelated onboarding mutations
      // in this disposable harness rather than leaving a latent grant path behind.
      provisioningRoles: {
        async resolveKeys() {
          throw new Error("identity role provisioning is unavailable in the M25 review harness");
        },
      },
      roleAttacher: {
        async attach({ roleKeys }) {
          return { attached: [], unresolved: [...roleKeys] };
        },
      },
      proposedRoleGuard: {
        async assertProposable() {
          throw new Error("identity role grants are disabled in the M25 review harness");
        },
      },
      validateLocations: async (_organizationId, locationIds) => locationIds.length === 0,
    });
    mountM25Routes(app, {
      // The focused runtime registers the real M25 route mount. Other route families are not
      // called by this suite; these inert service objects prevent them from reaching unrelated
      // data paths while the six Medicaid ERA routes use the real database workflow above.
      readService: {} as M25ReadService,
      writeService: {} as M25WriteService,
      medicaidEraReviewService,
      ...(claimMdEraReviewService ? { claimMdEraReviewService } : {}),
    });
  },
});

const shutdown = async () => {
  await server.close().catch(() => undefined);
  await dbHandle.close().catch(() => undefined);
};
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

await server.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? "3000") });
console.info(JSON.stringify({ component: "m25-test-api", event: "ready" }));
