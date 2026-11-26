import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createDbActorEnrichmentReader,
  createDbEffectivePermissionStore,
  createDbSessionContextStore,
  createSessionContextResolver,
  resolveEffectivePermissions,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { claimMdInboxKeyRingFromEnv } from "./modules/23-billing-medicare/claimmd-identity/config";
import { registerM24PublishedSeams } from "./modules/24-billing-medicaid";
import { BROAD_DENIAL_SCOPE_ROLES } from "./modules/25-remittance/abac-predicates";
import { createMedicaidEraReviewService } from "./modules/25-remittance/domain/medicaid-era-review-service";
import { createClaimMdEraStore } from "./modules/25-remittance/ingest/claimmd-era-store";
import { assertEvaluatorPoolIdentity } from "./modules/25-remittance/ingest/evaluator-pool-identity";
import { createIsolatedEvaluatorHandler } from "./modules/25-remittance/ingest/isolated-evaluator-server";
import { buildDrizzleMedicaidEraReviewReaders } from "./modules/25-remittance/ingest/medicaid-era-review-readers";
import { buildDrizzleMedicaidEraReviewWorkflow } from "./modules/25-remittance/ingest/medicaid-era-review-service";
import { createDbMdmStore } from "./modules/40-mdm/mdm-store-db";
import { registerMdmSeams } from "./modules/40-mdm/seams";

declare const Bun: {
  serve(input: {
    hostname: string;
    port: number;
    fetch(request: Request): Promise<Response>;
  }): { readonly port: number; stop(): void };
};

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the isolated M25 evaluator`);
  return value;
};
const secret = (name: string): string => readFileSync(required(name), "utf8").trim();
const dbUrlFromSecret = (name: string): string => secret(name);

const boundedPool = {
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 10_000,
  statement_timeout: 5_000,
  query_timeout: 6_000,
};
const app = createDbClient({
  connectionString: dbUrlFromSecret("M25_EVALUATOR_APP_DATABASE_URL_FILE"),
  max: 4,
  pool: boundedPool,
});
const eraSource = createDbClient({
  connectionString: dbUrlFromSecret("M25_EVALUATOR_ERA_SOURCE_DATABASE_URL_FILE"),
  max: 2,
  pool: boundedPool,
});
const writer = createDbClient({
  connectionString: dbUrlFromSecret("M25_EVALUATOR_DATABASE_URL_FILE"),
  max: 4,
  pool: boundedPool,
});
// Fail closed at boot when a URL file names the wrong login: the pools are built from three secret files and nothing
// else proves which login each one is (a superuser or BYPASSRLS app-reader, or a writer URL naming another login).
const identityQuery = sql`SELECT current_user::text AS name, r.rolsuper, r.rolbypassrls
  FROM pg_roles r WHERE r.rolname = current_user`;
await Promise.all([
  assertEvaluatorPoolIdentity(app.db, identityQuery, "application reader"),
  assertEvaluatorPoolIdentity(
    eraSource.db,
    identityQuery,
    "ERA source reader",
    "chartwarden_m25_era_source_login",
  ),
  assertEvaluatorPoolIdentity(
    writer.db,
    identityQuery,
    "review writer",
    "chartwarden_m25_evaluator_login",
  ),
]);
const keyRing = claimMdInboxKeyRingFromEnv({
  CLAIMMD_RESPONSE_INBOX_KEYRING: secret("M25_EVALUATOR_CLAIMMD_KEYRING_FILE"),
});
if (!keyRing) throw new Error("Claim.MD protected artifact key ring is required");
registerMdmSeams({ store: createDbMdmStore(app.db) });
registerM24PublishedSeams(app.db);
const store = createClaimMdEraStore({ sourceReaderDb: eraSource.db, keyRing });
const workflow = buildDrizzleMedicaidEraReviewWorkflow(
  app.db,
  createMedicaidEraReviewService(buildDrizzleMedicaidEraReviewReaders(app.db, store)),
  writer.db,
);
const enrichment = createDbActorEnrichmentReader(app.db);
const sessions = createSessionContextResolver(createDbSessionContextStore(app.db, enrichment));
const permissions = createDbEffectivePermissionStore(app.db);
const publicKey = createPublicKey({
  key: Buffer.from(secret("M25_EVALUATOR_PUBLIC_KEY_FILE"), "base64url"),
  format: "der",
  type: "spki",
});
const kid = required("M25_EVALUATOR_SIGNING_KEY_ID");
const handler = createIsolatedEvaluatorHandler({
  workflow,
  publicKeys: new Map([[kid, publicKey]]),
  ready: async () => {
    await Promise.all([
      app.db.execute(sql`SELECT 1`),
      eraSource.db.execute(sql`SELECT 1`),
      writer.db.execute(sql`SELECT 1`),
    ]);
    return true;
  },
  authority: {
    async resolve(principal, operation) {
      const resolved = await sessions.resolveActor(
        { orgId: principal.organizationId },
        principal.sessionId,
      );
      if (
        !resolved ||
        resolved.userId !== principal.userId ||
        resolved.membershipId !== principal.membershipId
      )
        return null;
      const requiredPermission =
        operation === "evaluate" ? "remittance.match_review" : "remittance.financial_review";
      const effective = resolveEffectivePermissions(
        await permissions.loadGrants(principal.organizationId, principal.userId),
        Date.now(),
      );
      if (!effective.permissions.has(requiredPermission)) return null;
      const providerEntityScope = BROAD_DENIAL_SCOPE_ROLES.some((role) =>
        resolved.roles.includes(role),
      )
        ? undefined
        : resolved.providerEntityIds;
      return {
        organizationId: principal.organizationId,
        userId: principal.userId,
        membershipId: principal.membershipId,
        sessionId: principal.sessionId,
        roles: resolved.roles,
        providerEntityScope,
        stepUpRecent: false,
      };
    },
  },
});

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.M25_EVALUATOR_PORT ?? 3012),
  fetch: handler,
});
console.info(
  JSON.stringify({
    level: "info",
    component: "m25-isolated-evaluator",
    event: "ready",
    port: server.port,
  }),
);
let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.stop();
  await Promise.all([app.close(), eraSource.close(), writer.close()]);
  process.exitCode = 0;
};
process.on("SIGTERM", () => void shutdown().catch(() => process.exit(1)));
process.on("SIGINT", () => void shutdown().catch(() => process.exit(1)));
