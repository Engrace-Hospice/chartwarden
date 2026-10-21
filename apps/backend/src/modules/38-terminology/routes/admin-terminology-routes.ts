import { randomUUID } from "node:crypto";
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
// WHAT THE WRITE ROUTES DO (GAP-108). `POST …/load` registers a version row (idempotent on
// (system, version)), REFUSES a non-public system without an active licence attestation, and ENQUEUES
// `terminology.load_version`; the worker (`packages/terminology-loader`) moves the version loading → staged →
// active, or → failed with no residue. The route answers 503 — before registering anything — when no job queue
// is configured, so a deployment that cannot run the worker never accumulates dead `loading` rows.
// `POST …/refresh-embeddings` enqueues `terminology.refresh_embeddings`, and answers 503 EMBEDDINGS_NOT_CONFIGURED
// while no embeddings backend is bound (the BGE-small sidecar is not built — nothing fakes a vector).
// `POST /uploads` presigns the platform-bucket PUT an operator needs to hand a release file to the loader;
// `…/license-attestation` records the licence the gate checks and the attribution text served with the data.
import { requireAbac, requirePermission, requireStepUp } from "@wardenx/auth";
import type { CodeSystemId } from "@wardenx/terminology";
import {
  type LoadableSystemId,
  isLoadableSystem,
  validateAttestationInput,
} from "@wardenx/terminology-loader";
import { UnauthorizedError, ValidationError, ChartWardenError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { terminologyRefusalOf } from "../db-errors";
import type { PlatformUploadSigner, TerminologyJobProducer } from "../jobs-ports";
import type { TerminologyOpsStore } from "../ops-store";
import {
  AdminAttestationBodySchema,
  AdminAttestationParamsSchema,
  AdminAttestationsQuerySchema,
  AdminExtensionsQuerySchema,
  AdminLoadBodySchema,
  AdminSystemParamsSchema,
  AdminUploadBodySchema,
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
  /** The §4.3 producer. Absent ⇒ the load / refresh-embeddings routes answer 503 (no worker could run the job). */
  jobs?: TerminologyJobProducer;
  /** Presigns the platform-bucket PUT. Absent ⇒ `POST /uploads` answers 503 (no object storage configured). */
  uploads?: PlatformUploadSigner;
  /** True when an embeddings backend is bound; false ⇒ refresh-embeddings answers 503 EMBEDDINGS_NOT_CONFIGURED. */
  embeddingsAvailable?: boolean;
}

const UPLOAD_TTL_SECONDS = 900;
/** Object keys are server-minted under this prefix; the operator's file name is sanitised into the tail only. */
const UPLOAD_PREFIX = "terminology/uploads";

const unavailable = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 503);

/** Map a loader-function refusal onto the HTTP contract (licence → 403, unknown system → 422). */
function refusalToHttp(err: unknown): never {
  const refusal = terminologyRefusalOf(err);
  if (!refusal) throw err;
  if (refusal.code.startsWith("TERMINOLOGY_LICENSE_")) {
    const code = refusal.code.replace("TERMINOLOGY_", "");
    throw new ChartWardenError(code, refusal.detail, 403);
  }
  if (refusal.code === "TERMINOLOGY_UNKNOWN_SYSTEM") {
    throw new ChartWardenError("UNKNOWN_SYSTEM", refusal.detail, 422);
  }
  throw err;
}

/** A path-safe tail for an object key. */
const safeName = (name: string): string =>
  name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._]+/, "")
    .slice(0, 120) || "upload";

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

  // --- §4.2 register a source version AND enqueue its load (idempotent on (system, version); step-up) ----
  app.post(
    "/api/v1/admin/terminology/:system/load",
    { preHandler: [LOAD, LOAD_PLATFORM, LOAD_STEPUP] },
    async (request, reply) => {
      const { system } = parse(AdminSystemParamsSchema, request.params);
      const body = parse(AdminLoadBodySchema, request.body);
      if (!isLoadableSystem(system)) {
        throw new ChartWardenError(
          "SYSTEM_NOT_LOADABLE",
          `${system} has no source release to load`,
          422,
        );
      }
      if (!deps.jobs) {
        throw unavailable("LOADER_UNAVAILABLE", "the terminology job queue is not configured");
      }
      const activate = body.activate ?? true;
      let result: Awaited<ReturnType<TerminologyOpsStore["registerVersion"]>>;
      try {
        result = await ops.registerVersion({
          system,
          version: body.version,
          sourceFileRef: body.sourceFileRef,
          checksum: body.checksum,
          releasedOn: body.releasedOn ?? today(now),
          effectiveFrom: body.effectiveFrom ?? today(now),
          loadedBy: operatorOf(request),
        });
      } catch (err) {
        refusalToHttp(err);
      }
      // §4.2: "409 VERSION_ALREADY_LOADED (idempotent on (system, version)) — returns existing
      // versionId". The conflict is decided by the unique index inside the loader function, not by a
      // read-then-write here: two concurrent loads of the same release would both see nothing.
      if (!result.created) {
        // A version still `loading`/`staged` (a lost job, a restart) is re-driven: the job id is deduplicated, so
        // this is safe to repeat and is how an operator resumes a stuck load.
        const requeued = result.status === "loading" || result.status === "staged";
        if (requeued) await deps.jobs.enqueueLoadVersion(result.versionId, activate);
        return reply.code(409).send({
          error: {
            code: "VERSION_ALREADY_LOADED",
            message: `${system} version '${body.version}' is already registered`,
            details: { versionId: result.versionId, status: result.status, requeued },
          },
        });
      }
      try {
        await deps.jobs.enqueueLoadVersion(result.versionId, activate);
      } catch {
        // The row is registered and `loading`; repeating this request re-drives it (409 + requeued).
        throw unavailable(
          "LOADER_ENQUEUE_FAILED",
          `version ${result.versionId} is registered but could not be queued; repeat the request`,
        );
      }
      return {
        versionId: result.versionId,
        status: result.status,
        created: true,
        ingestion: "enqueued" as const,
      };
    },
  );

  // --- presign the platform-bucket upload an operator hands a release file through --------------------------
  app.post(
    "/api/v1/admin/terminology/uploads",
    { preHandler: [LOAD, LOAD_PLATFORM] },
    async (request) => {
      const body = parse(AdminUploadBodySchema, request.body);
      if (!deps.uploads)
        throw unavailable(
          "OBJECT_STORAGE_UNAVAILABLE",
          "platform object storage is not configured",
        );
      const objectKey = `${UPLOAD_PREFIX}/${body.system}/${randomUUID()}-${safeName(body.fileName)}`;
      const signed = await deps.uploads.presignUpload({
        objectKey,
        sha256Hex: body.sha256,
        ttlSeconds: UPLOAD_TTL_SECONDS,
      });
      return {
        sourceFileRef: objectKey,
        checksum: body.sha256,
        upload: { url: signed.url, headers: { ...signed.headers }, expiresAt: signed.expiresAt },
      };
    },
  );

  // --- licence attestations (the gate every non-public load is checked against) -----------------------------
  app.get(
    "/api/v1/admin/terminology/license-attestations",
    { preHandler: [READ, READ_PLATFORM] },
    async (request) => {
      const q = parse(AdminAttestationsQuerySchema, request.query);
      return { items: await ops.listLicenseAttestations(q.system as CodeSystemId | undefined) };
    },
  );

  app.post(
    "/api/v1/admin/terminology/:system/license-attestation",
    { preHandler: [LOAD, LOAD_PLATFORM, LOAD_STEPUP] },
    async (request, reply) => {
      const { system } = parse(AdminSystemParamsSchema, request.params);
      const body = parse(AdminAttestationBodySchema, request.body);
      if (!isLoadableSystem(system)) {
        throw new ChartWardenError(
          "SYSTEM_NOT_LOADABLE",
          `${system} has no source release to attest`,
          422,
        );
      }
      const input = {
        system: system as LoadableSystemId,
        licensee: body.licensee,
        licenseReference: body.licenseReference,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        attributionText: body.attributionText,
      };
      const problems = validateAttestationInput(input);
      if (problems.length > 0) {
        throw new ValidationError(
          "attestation validation failed",
          problems.map((message) => ({ field: "(body)", code: "INVALID", message })),
        );
      }
      try {
        const created = await ops.recordLicenseAttestation({
          ...input,
          attestedBy: operatorOf(request),
        });
        return reply.code(201).send({ attestationId: created.attestationId, systemId: system });
      } catch (err) {
        const refusal = terminologyRefusalOf(err);
        if (refusal?.code === "TERMINOLOGY_LICENSE_NOT_REQUIRED") {
          throw new ChartWardenError("LICENSE_NOT_REQUIRED", refusal.detail, 409);
        }
        return refusalToHttp(err);
      }
    },
  );

  app.post(
    "/api/v1/admin/terminology/license-attestations/:id/revoke",
    { preHandler: [LOAD, LOAD_PLATFORM, LOAD_STEPUP] },
    async (request) => {
      const { id } = parse(AdminAttestationParamsSchema, request.params);
      const revoked = await ops.revokeLicenseAttestation(id, operatorOf(request));
      if (!revoked)
        throw new ChartWardenError("NOT_FOUND", "attestation not found or already revoked", 404);
      return { revoked: true };
    },
  );

  // --- §4.2 recompute embeddings for a system at its CURRENT version ---------------------------
  app.post(
    "/api/v1/admin/terminology/:system/refresh-embeddings",
    { preHandler: [LOAD, LOAD_PLATFORM] },
    async (request) => {
      const { system } = parse(AdminSystemParamsSchema, request.params);
      if (!isLoadableSystem(system)) {
        throw new ChartWardenError("SYSTEM_NOT_LOADABLE", `${system} has no concepts to embed`, 422);
      }
      if (!deps.embeddingsAvailable || !deps.jobs) {
        throw unavailable(
          "EMBEDDINGS_NOT_CONFIGURED",
          "no embeddings backend is bound (the local BGE-small sidecar is not built); semantic search stays on fuzzy",
        );
      }
      const result = await ops.requestEmbeddingRefresh(system as CodeSystemId, operatorOf(request));
      // The version is resolved server-side from the ACTIVE row, so "no active version" is a real
      // refusal rather than a silently-logged no-op against nothing.
      if (!result.logged || result.versionId === null) {
        throw new ChartWardenError(
          "NO_ACTIVE_VERSION",
          `${system} has no active version to recompute embeddings for`,
          409,
        );
      }
      await deps.jobs.enqueueRefreshEmbeddings(system, result.versionId);
      return {
        versionId: result.versionId,
        status: "embedding" as const,
        recompute: "enqueued" as const,
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
