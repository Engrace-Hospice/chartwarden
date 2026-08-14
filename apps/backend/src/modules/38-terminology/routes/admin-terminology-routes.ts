// apps/backend/src/modules/38-terminology/routes/admin-terminology-routes.ts — M38 §4.1 rows 11–14,
// the platform-ops surface (GAP-063).
//
// Four of the six §4.1 routes that had no registration anywhere in the app. `> All
// /api/v1/admin/terminology/* routes are platform-ops only and audited as audit.elevated_access per
// M4 §6` — so each one carries THREE gates, not one:
//
//   1. `requirePermission("terminology.admin.read"|".load")` — the §4.4 RBAC key.
//   2. `requireAbac(key, "terminology_admin_platform_ops")` — the platform-only conjunct. RBAC alone
//      cannot express it: a permission key travels with whatever role template carries it, and an org
//      that got `terminology.admin.load` onto a tenant role would be loading ICD-10-CM for every
//      tenant at once. Fastify preHandlers are AND-only, which is exactly the semantics wanted here.
//   3. `requireStepUp` on the load route — §4.2 marks it `session + step-up`, and a canonical load
//      changes the meaning of every code in the platform.
//
// WHAT THE WRITE ROUTES HONESTLY DO. `POST …/load` registers a version row (idempotent on
// (system, version)) and an append-only ledger entry; `POST …/refresh-embeddings` records a request
// against the system's ACTIVE version. Neither ingests concepts or computes a vector — the loader
// (`packages/terminology-loader`) and the embeddings worker (architecture §12) are not built. The
// responses say so in a field (`ingestion` / `recompute`) rather than returning a bare success that
// reads as "the codes are loaded". Nothing is ACTIVATED, so as-of resolution is untouched either way.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { CodeSystemId } from "@wardenx/terminology";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TerminologyOpsStore } from "../ops-store";
import {
  AdminExtensionsQuerySchema,
  AdminLoadBodySchema,
  AdminSystemParamsSchema,
  AdminVersionsQuerySchema,
  parse,
} from "./terminology-typebox";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The injection surface for M38's platform-ops routes. */
export interface AdminTerminologyRouteDeps {
  /** The §4.1 admin data port (Drizzle + the 0206 `terminology_loader` functions in prod). */
  ops: TerminologyOpsStore;
  /** Injected clock — the load route defaults `releasedOn`/`effectiveFrom` to today. */
  now?: () => Date;
}

const ADMIN_READ_KEY = "terminology.admin.read";
const ADMIN_LOAD_KEY = "terminology.admin.load";

const READ = requirePermission(ADMIN_READ_KEY) as PreHandler;
const LOAD = requirePermission(ADMIN_LOAD_KEY) as PreHandler;
const READ_PLATFORM = requireAbac(ADMIN_READ_KEY, "terminology_admin_platform_ops") as PreHandler;
const LOAD_PLATFORM = requireAbac(ADMIN_LOAD_KEY, "terminology_admin_platform_ops") as PreHandler;
const LOAD_STEPUP = requireStepUp(ADMIN_LOAD_KEY) as PreHandler;

/** The operator's user id — server-side from the session context, never the body. */
function operatorOf(request: FastifyRequest): string {
  const userId = request.context?.userId;
  if (!userId) throw new UnauthorizedError();
  return userId;
}

const today = (now: () => Date): string => now().toISOString().slice(0, 10);

export function registerAdminTerminologyRoutes(
  app: FastifyInstance,
  deps: AdminTerminologyRouteDeps,
): void {
  const { ops } = deps;
  const now = deps.now ?? (() => new Date());

  // --- §4.1 platform load history (terminology_update_log) ------------------------------------
  app.get(
    "/api/v1/admin/terminology/versions",
    { preHandler: [READ, READ_PLATFORM] },
    async (request) => {
      const q = parse(AdminVersionsQuerySchema, request.query);
      const items = await ops.loadHistory({
        system: q.system as CodeSystemId | undefined,
        limit: q.limit ?? 50,
      });
      return { items };
    },
  );

  // --- §4.2 register a source version (idempotent on (system, version); step-up) ---------------
  app.post(
    "/api/v1/admin/terminology/:system/load",
    { preHandler: [LOAD, LOAD_PLATFORM, LOAD_STEPUP] },
    async (request, reply) => {
      const { system } = parse(AdminSystemParamsSchema, request.params);
      const body = parse(AdminLoadBodySchema, request.body);
      const result = await ops.registerVersion({
        system: system as CodeSystemId,
        version: body.version,
        sourceFileRef: body.sourceFileRef,
        checksum: body.checksum,
        releasedOn: body.releasedOn ?? today(now),
        effectiveFrom: body.effectiveFrom ?? today(now),
        loadedBy: operatorOf(request),
      });
      // §4.2: "409 VERSION_ALREADY_LOADED (idempotent on (system, version)) — returns existing
      // versionId". The conflict is decided by the unique index inside the loader function, not by a
      // read-then-write here: two concurrent loads of the same release would both see nothing.
      if (!result.created) {
        return reply.code(409).send({
          error: {
            code: "VERSION_ALREADY_LOADED",
            message: `${system} version '${body.version}' is already registered`,
            details: { versionId: result.versionId, status: result.status },
          },
        });
      }
      return {
        versionId: result.versionId,
        status: result.status,
        created: true,
        ingestion: "pending_loader_worker" as const,
      };
    },
  );

  // --- §4.2 recompute embeddings for a system at its CURRENT version ---------------------------
  app.post(
    "/api/v1/admin/terminology/:system/refresh-embeddings",
    { preHandler: [LOAD, LOAD_PLATFORM] },
    async (request) => {
      const { system } = parse(AdminSystemParamsSchema, request.params);
      const result = await ops.requestEmbeddingRefresh(
        system as CodeSystemId,
        operatorOf(request),
      );
      // The version is resolved server-side from the ACTIVE row, so "no active version" is a real
      // refusal rather than a silently-logged no-op against nothing.
      if (!result.logged || result.versionId === null) {
        throw new WardenXError(
          "NO_ACTIVE_VERSION",
          `${system} has no active version to recompute embeddings for`,
          409,
        );
      }
      return {
        versionId: result.versionId,
        status: "embedding" as const,
        recompute: "pending_embeddings_worker" as const,
      };
    },
  );

  // --- §4.1 cross-tenant tenant-extension governance view --------------------------------------
  app.get(
    "/api/v1/admin/terminology/value-set-extensions",
    { preHandler: [READ, READ_PLATFORM] },
    async (request) => {
      const q = parse(AdminExtensionsQuerySchema, request.query);
      const limit = q.limit ?? 100;
      const items = await ops.listTenantExtensions({
        valueSetId: q.valueSetId,
        organizationId: q.organizationId,
        includeRemoved: q.includeRemoved,
        limit,
        cursor: q.cursor ?? null,
      });
      // Keyset cursor over the same (created_at, id) tuple the function orders by — a full page hands
      // back the last row's key, a short page ends the walk.
      const last = items.length === limit ? items[items.length - 1] : undefined;
      return {
        items,
        nextCursor: last ? `${last.createdAt}|${last.extensionId}` : null,
      };
    },
  );
}
