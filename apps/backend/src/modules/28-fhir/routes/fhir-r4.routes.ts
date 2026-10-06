import { buildCapabilityStatement, isSupportedScope } from "@wardenx/fhir";
// apps/backend/src/modules/28-fhir/routes/fhir-r4.routes.ts — §4.1 R1-R22: the FHIR-spec HTTP surface.
//
// These routes authenticate with a SMART bearer token (NOT a WardenX session), so they do NOT compose the
// M3 `requirePermission`/`requireAbac` preHandlers — their gate is the bearer resolution + the client's
// `allowed_scopes`, applied in the handler. Every error is a FHIR `OperationOutcome`
// (`application/fhir+json`); the admin surface (R23-R39) uses the WardenX envelope instead.
//
// ── POSTURE (read-only US Core R4, `fhir.write` OFF) ────────────────────────────────────────────────
//
//   · The projection pipeline is `./projection.ts`: every served resource is composed at read time from
//     an owner module's data through the M1 seam registry, shaped by a pure `@wardenx/fhir` mapper, and
//     put through the D3 egress consent gate before it reaches the wire. `SERVED_RESOURCES` is the single
//     source of truth for what this gateway can answer, and BOTH the CapabilityStatement (R1) and the
//     router read it — so the conformance claim and the behaviour cannot drift apart.
//   · A resource type this gateway does not serve answers `not-supported`, NOT `not-found`. The
//     difference is the whole point: `not-found` tells a partner their patient has no such record, which
//     is a statement about their data and was false; `not-supported` is a statement about this server.
//   · Claim / ClaimResponse / ExplanationOfBenefit / ServiceRequest / QuestionnaireResponse / Location
//     short-circuit to 404 BEFORE reaching any reader (W-FHIR-07): they are registered as CONCRETE routes
//     so Fastify prefers them over the generic `:resourceType` param route.
//   · R17/R18 (FHIR R5/R6) return 415 via a wildcard.
//   · The token endpoint (R3) runs both §D2 auth paths for real (`./token-mint.ts`). It used to answer
//     `invalid_client` unconditionally, which made every route below it unreachable by construction —
//     not a fail-closed posture but a wall (F-035, #95).
//   · EVERY served read writes a 45 CFR §164.528 accounting row through `store.recordDisclosure`, AFTER
//     the body is assembled, so `resultCount` is what actually crossed. A read that 403s or 404s
//     disclosed nothing and is deliberately not accounted for.
import type { OperationOutcome } from "@wardenx/fhir";
import {
  FHIR_FORWARD_SEAM_RESOURCES,
  FHIR_PHASE_1_VERSION,
  FHIR_SESSION_TTL_MINUTES,
  type FhirReadDisclosureEnvelope,
} from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { type FhirBaaStatusView, getFhirTerminologyProvider } from "../seams/index";
import { BAA_NOT_IN_FORCE_CODE, isBaaInForce, isIpAllowed } from "./client-gates";
import {
  type FhirClientRateLimiter,
  createInMemoryFhirClientRateLimiter,
} from "./client-rate-limiter";
import { codeSystemIdForUri } from "./code-system-uris";
import {
  ExportQuery,
  ResourceReadParams,
  ResourceSearchQuery,
  ResourceTypeParams,
  TokenFormBody,
  ValidateCodeBody,
  parse,
  parseQuery,
} from "./m28-typebox";
import { FHIR_JSON_CONTENT_TYPE, operationOutcome, sendOutcome } from "./operation-outcome";
import {
  type FhirProjectionContext,
  SERVED_RESOURCES,
  projectResourceById,
  projectSearch,
  servedResource,
  supportsInteraction,
} from "./projection";
import type { FhirBearerContext, FhirGatewayStore } from "./store";
import {
  type FhirAssertionReplayGuard,
  type FhirJwksFetcher,
  createInMemoryFhirReplayGuard,
  mintFhirToken,
} from "./token-mint";

/** A disclosure-audit sink for served FHIR reads (D15 / §164.528). Injected; defaults to a no-op. */
export interface FhirDisclosureAuditPort {
  auditRead(envelope: FhirReadDisclosureEnvelope): Promise<void>;
}

export interface FhirR4RouteDeps {
  readonly store: FhirGatewayStore;
  /**
   * Where §164.528 accounting rows go. Defaults to `store.recordDisclosure` — the ledger, not a no-op:
   * this used to default to a no-op and the composition root never overrode it, so a surface whose
   * entire purpose is disclosing PHI to third parties accounted for nothing. A test may substitute a
   * spy; a deployment may not substitute silence.
   */
  readonly audit?: FhirDisclosureAuditPort;
  readonly now?: () => string;
  /** R3 — resolves a registered client's `jwks_uri`. Absent ⇒ the SMART assertion path cannot verify. */
  readonly jwks?: FhirJwksFetcher;
  /** R3 — the assertion `jti` replay defence. Defaults to the per-process guard (see its own header). */
  readonly replay?: FhirAssertionReplayGuard;
  /** R3 — this endpoint's absolute URL, the `aud` an assertion must carry. */
  readonly tokenEndpointUrl?: string;
  /** GAP-083 — the M40 BAA gate for mint + reads. UNBOUND ⇒ every client is refused (fail closed). */
  readonly baa?: Pick<FhirBaaStatusView, "isBaaActive">;
  /** GAP-083 / D16 — per-client token bucket. Defaults to a per-process bucket. */
  readonly rateLimiter?: FhirClientRateLimiter;
}

/**
 * The resource types this gateway serves — derived from `SERVED_RESOURCES`, never a second list.
 *
 * It used to be a hand-written literal of TWELVE types on which the CapabilityStatement claimed `read`
 * and `search-type`, while the read handler answered 404 for all twelve and the search handler an empty
 * Bundle for all twelve. A conformance statement is a machine-readable promise, and it was the first
 * thing any partner's tooling fetched — anonymously, before authenticating (F-035, #95).
 */
const ADVERTISED_RESOURCES = SERVED_RESOURCES.map((r) => r.type);

const bearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
};

export function registerFhirR4Routes(app: FastifyInstance, deps: FhirR4RouteDeps): void {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const replay = deps.replay ?? createInMemoryFhirReplayGuard();
  const rateLimiter = deps.rateLimiter ?? createInMemoryFhirClientRateLimiter();
  const auditRead = async (envelope: FhirReadDisclosureEnvelope): Promise<void> => {
    // Defaults to the LEDGER (F-035). A failure to record must not be swallowed silently, but neither
    // may it un-serve a read the client is entitled to and has already been authorised for: the
    // disclosure happened either way, so the honest failure mode is a loud log beside a served response,
    // not a 500 that hides both.
    try {
      if (deps.audit) await deps.audit.auditRead(envelope);
      else await store.recordDisclosure(envelope);
    } catch (err) {
      app.log.error(
        { err, resourceType: envelope.resourceType, fhirClientId: envelope.fhirClientId },
        "M28 §164.528: a served FHIR read could not be written to the disclosure ledger",
      );
    }
  };

  /**
   * An unbound reader seam is a DEPLOYMENT fact, not a clinical one.
   *
   * Every projection reads through the M1 seam registry, and an unregistered seam is a fail-closed
   * deny-stub that THROWS `NotImplementedError`. Left to propagate that is a 500 — the shape this file's
   * original comment was avoiding when it answered a blanket 404 instead. Both are wrong for the same
   * reason: neither tells the truth. A 503 naming the condition says "this deployment cannot answer that
   * yet", which is what actually happened, and matches how the terminology provider two routes down
   * already reports its own outage.
   */
  const unboundReader = (error: unknown): boolean =>
    error instanceof Error && error.name === "NotImplementedError";

  /**
   * Assemble the per-request projection context. The tenant's D9 URI bases come from
   * `tenant_fhir_config`; a tenant that has never configured them gets a `urn:`-namespaced fallback
   * derived from its own org id, which is still tenant-private and still resolvable as an identifier
   * system — never a shared or guessable namespace that two tenants could both mint into.
   */
  const projectionContext = async (ctx: FhirBearerContext): Promise<FhirProjectionContext> => {
    const config = await store.getConfig(ctx.organizationId);
    return {
      organizationId: ctx.organizationId,
      recipientClientId: ctx.clientId,
      tenantFhirHost: config?.tenantFhirHost ?? `urn:wardenx:org:${ctx.organizationId}`,
      identifierUriBase: config?.identifierUriBase ?? `urn:wardenx:org:${ctx.organizationId}`,
      asOfDate: now(),
    };
  };

  /** Resolve the bearer client, or send a 401 OperationOutcome and return null. */
  const resolveBearer = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FhirBearerContext | null> => {
    const token = bearerToken(request);
    if (token === null) {
      await reply
        .code(401)
        .header("content-type", FHIR_JSON_CONTENT_TYPE)
        .send(operationOutcome("error", "login", "a bearer token is required", "FHIR_NO_BEARER"));
      return null;
    }
    const ctx = await store.resolveBearer(token);
    // GAP-083 / D12 (§4.7 `fhir_client_active`): status, IP allowlist, BAA. `request.ip` is Fastify's
    // trusted-proxy-derived peer, never a raw `X-Forwarded-For`. Status/IP failures stay the generic 401;
    // a BAA failure (reached only for an active, allowlisted client holding a live session) carries the
    // distinct BAA_NOT_IN_FORCE code so it is not mistaken for a bad credential.
    const sendBad = async (message: string, code: string): Promise<null> => {
      await reply
        .code(401)
        .header("content-type", FHIR_JSON_CONTENT_TYPE)
        .send(operationOutcome("error", "security", message, code));
      return null;
    };
    if (
      ctx === null ||
      ctx.clientStatus !== "active" ||
      !isIpAllowed(request.ip, ctx.ipAllowlist)
    ) {
      return sendBad("the bearer token is invalid or expired", "FHIR_BAD_BEARER");
    }
    const baaOk = await isBaaInForce(deps.baa, {
      organizationId: ctx.organizationId,
      contractReference: ctx.baaContractReference,
      asOf: now(),
    });
    if (!baaOk) {
      request.log.warn(
        {
          code: BAA_NOT_IN_FORCE_CODE,
          clientId: ctx.clientId,
          organizationId: ctx.organizationId,
          contractReference: ctx.baaContractReference,
        },
        "M28: FHIR read refused, client BAA is not in force",
      );
      return sendBad("no BAA is in force for this client", BAA_NOT_IN_FORCE_CODE);
    }
    // D16 — per-client token bucket, AFTER authentication so an unauthenticated caller cannot drain a
    // client's allowance.
    const verdict = await rateLimiter.consume(ctx.clientId, ctx.rateLimitRps);
    if (!verdict.allowed) {
      await reply
        .code(429)
        .header("retry-after", String(verdict.retryAfterSeconds))
        .header("content-type", FHIR_JSON_CONTENT_TYPE)
        .send(
          operationOutcome(
            "error",
            "throttled",
            "this client has exceeded its request rate",
            "FHIR_RATE_LIMITED",
          ),
        );
      return null;
    }
    return ctx;
  };

  const hasReadScope = (ctx: FhirBearerContext, resourceType: string): boolean =>
    ctx.scopesGranted.includes(`system/${resourceType}.read`) ||
    ctx.scopesGranted.includes("system/*.read");

  // ── R1 — CapabilityStatement (anonymous per FHIR convention) ─────────────────────────────────────
  app.get("/fhir/r4/metadata", async (_request, reply) => {
    const statement = buildCapabilityStatement({
      fhirVersion: FHIR_PHASE_1_VERSION,
      releaseTag: "phase-1",
      publicationDate: "2026-01-01",
      baseUrl: "/fhir/r4",
      // Each resource declares the interactions it ACTUALLY supports, which is what
      // `CapabilityStatement.rest.resource.interaction` is for. Encounter is `search-type` only —
      // M8 publishes a patient-scoped signed-encounter read and no read-by-id, so an instance read has
      // no data path and claiming one would be the same false promise in a smaller font.
      resources: SERVED_RESOURCES.map((r) => ({
        type: r.type,
        interactions: r.interactions,
        searchParams: r.searchParams,
      })),
      operations: [
        {
          name: "export",
          definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export",
        },
        {
          name: "everything",
          definition: "http://hl7.org/fhir/OperationDefinition/Patient-everything",
        },
      ],
    });
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return statement;
  });

  // ── R2 — SMART well-known configuration (anonymous) ──────────────────────────────────────────────
  app.get("/fhir/.well-known/smart-configuration", async (_request, reply) => {
    reply.header("content-type", "application/json");
    return {
      token_endpoint: "/fhir/oauth2/token",
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS384", "ES384"],
      grant_types_supported: ["client_credentials"],
      scopes_supported: ["system/*.read"],
      capabilities: ["client-confidential-asymmetric", "permission-v2"],
    };
  });

  // ── R3 — token mint (both §D2 auth paths) ────────────────────────────────────────────────────────
  app.post("/fhir/oauth2/token", async (request, reply) => {
    const body = parse(TokenFormBody, request.body);
    const result = await mintFhirToken(
      {
        store,
        jwks: deps.jwks ?? {
          async fetch() {
            return null;
          },
        },
        replay,
        baa: deps.baa,
        rateLimiter,
        tokenEndpointUrl: deps.tokenEndpointUrl,
        nowMs: () => Date.parse(now()),
      },
      {
        scope: body.scope,
        clientId: body.client_id,
        clientAssertionType: body.client_assertion_type,
        clientAssertion: body.client_assertion,
        clientSecret: body.client_secret,
        ip: request.ip,
      },
    );
    // An OAuth token endpoint answers OAuth JSON, never an OperationOutcome — a SMART client's token
    // layer parses the former and would report the latter as an unparseable response.
    reply.header("content-type", "application/json");
    if (!result.ok) {
      // The precise reason is LOGGED, never sent: distinguishing "no such client" from "wrong secret"
      // would turn this endpoint into a client-id oracle for an unauthenticated caller.
      request.log.warn(
        { reason: result.error.logReason, clientId: body.client_id },
        "M28 R3: token request refused",
      );
      if (result.error.baaFailure !== undefined) {
        // Structured, secret-free: client id, org and the reference that failed to resolve.
        request.log.warn(
          { code: BAA_NOT_IN_FORCE_CODE, ...result.error.baaFailure },
          "M28 R3: token mint refused, client BAA is not in force",
        );
      }
      if (result.error.retryAfterSeconds !== undefined) {
        reply.header("retry-after", String(result.error.retryAfterSeconds));
      }
      reply.code(result.error.status);
      return result.error.body;
    }
    request.log.info(
      { clientId: result.grant.clientId, scope: result.grant.body.scope },
      "M28 R3: token minted",
    );
    reply.code(200);
    return result.grant.body;
  });

  // ── W-FHIR-07 — forward-seam + Phase-2 resources: 404 BEFORE any reader (concrete routes win) ─────
  for (const resource of [...FHIR_FORWARD_SEAM_RESOURCES, "QuestionnaireResponse", "Location"]) {
    app.get(`/fhir/r4/${resource}/:id`, async (_request, reply) =>
      sendOutcome(
        reply,
        404,
        "error",
        "not-found",
        `the ${resource} resource is not available on this FHIR gateway version`,
        "FHIR_RESOURCE_NOT_AVAILABLE",
      ),
    );
  }

  // ── R6 — Patient/$everything (concrete, before the generic :resourceType route) ──────────────────
  app.get("/fhir/r4/Patient/:id/$everything", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    if (!hasReadScope(ctx, "Patient")) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        "scope system/Patient.read is required",
        "FHIR_SCOPE_DENIED",
      );
    }
    const patientId = (request.params as { id: string }).id;
    const projectionCtx = await projectionContext(ctx);
    // `$everything` is every resource this gateway serves ABOUT one patient — which is precisely the
    // served set, each scoped to that patient, rather than a separate aggregation. Deriving it from
    // `SERVED_RESOURCES` is what keeps it honest as the served set grows or shrinks: a resource added to
    // the gateway appears here automatically, and one removed cannot linger in a stale second list.
    //
    // A scope the client does NOT hold silently contributes nothing rather than failing the whole
    // operation: `$everything` means "everything you may see", and refusing the entire Bundle because a
    // partner lacks one of four scopes would make the operation unusable for every narrowly-scoped
    // client. The Patient scope IS required, and was checked above.
    const collected: Record<string, unknown>[] = [];
    const warnings: OperationOutcome[] = [];
    // An unbound reader for ONE type degrades that type only. `$everything` is a compilation, so
    // refusing the whole Bundle because one owner module's seam is unbound would hide the three that
    // ARE readable; the consumer is told which type was unavailable through an `OperationOutcome` entry
    // rather than through a silent gap.
    const collect = async (type: string, params: { _id?: string; patient?: string }) => {
      try {
        const projection = await projectSearch(projectionCtx, type, params);
        if (projection === null) return;
        collected.push(...projection.resources);
        warnings.push(...projection.warnings);
      } catch (error) {
        if (!unboundReader(error)) throw error;
        request.log.warn({ err: error, resourceType: type }, "M28 R6: reader seam unbound");
        warnings.push({
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "warning",
              code: "not-supported",
              details: {
                text: `${type} is unavailable on this deployment: its reader seam is not bound`,
              },
            },
          ],
        });
      }
    };
    await collect("Patient", { _id: patientId });
    for (const served of SERVED_RESOURCES) {
      if (served.type === "Patient") continue;
      if (!hasReadScope(ctx, served.type)) continue;
      await collect(served.type, { patient: patientId });
    }
    // De-duplicate the advisories the same way `gateBundleForEgress` does within one resource type: a
    // patient with no Part 2 release produces the same `suppressed` warning from every type, and four
    // copies of it say nothing the first does not.
    const seenWarning = new Set<string>();
    const dedupedWarnings = warnings.filter((w) => {
      const text = w.issue[0]?.details?.text ?? "";
      if (seenWarning.has(text)) return false;
      seenWarning.add(text);
      return true;
    });
    if (collected.length > 0) {
      await auditRead({
        organizationId: ctx.organizationId,
        fhirClientId: ctx.clientId,
        resourceType: "Patient",
        patientId,
        queryParameters: { $everything: "true" },
        resultCount: collected.length,
        servedAt: now(),
      });
    }
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return {
      resourceType: "Bundle",
      type: "searchset",
      total: collected.length,
      entry: [
        ...collected.map((resource) => ({ resource, search: { mode: "match" } })),
        ...dedupedWarnings.map((resource) => ({ resource, search: { mode: "outcome" } })),
      ],
    };
  });

  // ── R7 / R9 — system-level + all-patient $export ─────────────────────────────────────────────────
  const handleExport = async (
    request: FastifyRequest,
    reply: FastifyReply,
    requestKind: "system" | "group" | "patient",
    groupId?: string,
  ): Promise<FastifyReply> => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    const query = parseQuery(ExportQuery, request.query);
    const resourceTypes = query._type
      ? query._type
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [...ADVERTISED_RESOURCES];
    const denied = resourceTypes.find((t) => !hasReadScope(ctx, t));
    if (denied !== undefined) {
      sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        `scope system/${denied}.read is required`,
        "FHIR_SCOPE_DENIED",
      );
      return reply;
    }
    const job = await store.createJob(ctx.organizationId, {
      clientId: ctx.clientId,
      requestKind,
      groupId,
      resourceTypes,
      since: query._since,
      initiatedByMembershipId: null,
    });
    reply
      .code(202)
      .header("content-location", `/fhir/r4/$export-poll-status/${job.id}`)
      .header("content-type", FHIR_JSON_CONTENT_TYPE);
    return reply.send({
      resourceType: "OperationOutcome",
      issue: [
        { severity: "information", code: "informational", diagnostics: "bulk export accepted" },
      ],
    });
  };

  app.post("/fhir/r4/$export", async (request, reply) => handleExport(request, reply, "system"));
  app.post("/fhir/r4/Patient/$export", async (request, reply) =>
    handleExport(request, reply, "patient"),
  );
  app.post("/fhir/r4/Group/:id/$export", async (request, reply) =>
    handleExport(request, reply, "group", (request.params as { id: string }).id),
  );

  // ── R10 — poll bulk export status ────────────────────────────────────────────────────────────────
  app.get("/fhir/r4/$export-poll-status/:jobId", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    const jobId = (request.params as { jobId: string }).jobId;
    const job = await store.getJob(ctx.organizationId, jobId);
    if (job === null) {
      return sendOutcome(
        reply,
        404,
        "error",
        "not-found",
        "bulk export job not found",
        "FHIR_EXPORT_JOB_NOT_FOUND",
      );
    }
    if (job.status === "expired") {
      return sendOutcome(
        reply,
        410,
        "error",
        "processing",
        "the bulk export output has expired",
        "FHIR_EXPORT_EXPIRED",
      );
    }
    if (job.status === "completed") {
      reply.code(200).header("content-type", FHIR_JSON_CONTENT_TYPE);
      return {
        transactionTime: job.completedAt,
        request: "/fhir/r4/$export",
        requiresAccessToken: true,
        output: [],
      };
    }
    reply.code(202).header("x-progress", job.status);
    return { status: job.status };
  });

  // ── R11 — cancel bulk export ─────────────────────────────────────────────────────────────────────
  app.delete("/fhir/r4/$export-poll-status/:jobId", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    const jobId = (request.params as { jobId: string }).jobId;
    await store.cancelJob(ctx.organizationId, jobId, null);
    reply.code(202).header("content-type", FHIR_JSON_CONTENT_TYPE);
    return {
      resourceType: "OperationOutcome",
      issue: [
        { severity: "information", code: "informational", diagnostics: "bulk export cancelled" },
      ],
    };
  });

  // ── R12 — CodeSystem read ────────────────────────────────────────────────────────────────────────
  app.get("/fhir/r4/CodeSystem/:system", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    if (!hasReadScope(ctx, "CodeSystem")) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        "scope system/CodeSystem.read is required",
        "FHIR_SCOPE_DENIED",
      );
    }
    return sendOutcome(
      reply,
      404,
      "warning",
      "not-supported",
      "CodeSystem lookup is not served in Phase 1",
      "FHIR_NOT_SUPPORTED",
    );
  });

  // ── R13 — CodeSystem/$validate-code ──────────────────────────────────────────────────────────────
  //
  // This route used to return `result: false` for every request without reading its Parameters at all
  // (#117). That is not a Phase-1 stub, it is a WRONG ANSWER: `false` means "this code is not valid in
  // that system", so a conformant client acting on it rejects codes that are perfectly good. Its
  // neighbours R12/R14 are honest about the same gap — they return `not-supported` — but a
  // `$validate-code` cannot borrow that shape without also refusing the systems it CAN answer for.
  //
  // It can answer for all of them. M38's `TerminologyProvider` is registered live on every boot (Drizzle-
  // backed with a DB, in-memory without one), and `validate(system, code)` is the exact question. The only
  // missing piece was the vocabulary join — a FHIR client names a code system by canonical URI, M38 by id
  // — which is `codeSystemIdForUri`. A system that map does not carry is `not-supported`, named, rather
  // than silently answered `false`.
  app.post("/fhir/r4/CodeSystem/$validate-code", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    if (!hasReadScope(ctx, "CodeSystem")) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        "scope system/CodeSystem.read is required",
        "FHIR_SCOPE_DENIED",
      );
    }
    const params = parse(ValidateCodeBody, request.body);
    // FHIR names the system `url`; `system` is the spelling several clients send and costs nothing to
    // accept. `code` may arrive as valueCode or valueString depending on the client's serializer.
    const named = (name: string): string | null => {
      const p = params.parameter.find((x) => x.name === name);
      return p?.valueUri ?? p?.valueCode ?? p?.valueString ?? null;
    };
    const systemUri = named("url") ?? named("system");
    const code = named("code");
    if (systemUri === null || code === null) {
      return sendOutcome(
        reply,
        400,
        "error",
        "invalid",
        "Parameters must supply both a code system (`url` or `system`) and a `code`",
        "FHIR_VALIDATE_CODE_INCOMPLETE",
      );
    }
    const systemId = codeSystemIdForUri(systemUri);
    if (systemId === null) {
      return sendOutcome(
        reply,
        404,
        "warning",
        "not-supported",
        `code system ${systemUri} is not served by this server`,
        "FHIR_NOT_SUPPORTED",
      );
    }
    let result: { valid: boolean; status?: string };
    try {
      result = await getFhirTerminologyProvider().validate(systemId, code);
    } catch {
      // The seam is registered on every boot, so this is defensive — but a throw here must still leave
      // the FHIR surface FHIR: the M1 error envelope is not an OperationOutcome, and a conformance
      // surface that answers a terminology outage in a second error format is two bugs, not one.
      return sendOutcome(
        reply,
        503,
        "error",
        "processing",
        "the terminology service is unavailable",
        "FHIR_TERMINOLOGY_UNAVAILABLE",
      );
    }
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return {
      resourceType: "Parameters",
      parameter: [
        { name: "result", valueBoolean: result.valid },
        ...(result.valid
          ? result.status && result.status !== "active"
            ? [{ name: "message", valueString: `code is ${result.status} in ${systemUri}` }]
            : []
          : [{ name: "message", valueString: `code ${code} is not valid in ${systemUri}` }]),
      ],
    };
  });

  // ── R14 — ValueSet read ──────────────────────────────────────────────────────────────────────────
  app.get("/fhir/r4/ValueSet/:vs", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    if (!hasReadScope(ctx, "ValueSet")) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        "scope system/ValueSet.read is required",
        "FHIR_SCOPE_DENIED",
      );
    }
    return sendOutcome(
      reply,
      404,
      "warning",
      "not-supported",
      "ValueSet read is not served in Phase 1",
      "FHIR_NOT_SUPPORTED",
    );
  });

  // ── R15 — ValueSet/$expand ───────────────────────────────────────────────────────────────────────
  app.get("/fhir/r4/ValueSet/:vs/$expand", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    if (!hasReadScope(ctx, "ValueSet")) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        "scope system/ValueSet.read is required",
        "FHIR_SCOPE_DENIED",
      );
    }
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return { resourceType: "ValueSet", status: "active", expansion: { total: 0, contains: [] } };
  });

  // ── R16 — inbound staging (write scope) ──────────────────────────────────────────────────────────
  app.post("/fhir/r4/:resourceType", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    const { resourceType } = parse(ResourceTypeParams, request.params);
    if (!ctx.scopesGranted.includes(`system/${resourceType}.write`)) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        `scope system/${resourceType}.write is required`,
        "FHIR_SCOPE_DENIED",
      );
    }
    const payload = (request.body ?? {}) as Record<string, unknown>;
    try {
      const proposal = await store.stageInbound(ctx.organizationId, {
        sourceClientId: ctx.clientId,
        resourceType,
        sourceFhirId: typeof payload.id === "string" ? payload.id : null,
        payload,
      });
      reply.code(202).header("content-type", FHIR_JSON_CONTENT_TYPE);
      return {
        resourceType: "OperationOutcome",
        issue: [
          {
            severity: "information",
            code: "informational",
            diagnostics: `resource staged as inbound proposal ${proposal.id} (owner ${proposal.ownerModule}); awaiting review`,
          },
        ],
      };
    } catch (error) {
      const status = (error as { httpStatus?: number }).httpStatus ?? 500;
      if (status === 501) {
        return sendOutcome(
          reply,
          501,
          "error",
          "not-supported",
          `inbound staging is not supported for ${resourceType}`,
          "FHIR_INBOUND_UNSUPPORTED",
        );
      }
      throw error;
    }
  });

  // ── R4 — single-resource read (generic; concrete resources above win) ────────────────────────────
  app.get("/fhir/r4/:resourceType/:id", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    const { resourceType, id } = parse(ResourceReadParams, request.params);
    if (!hasReadScope(ctx, resourceType)) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        `scope system/${resourceType}.read is required`,
        "FHIR_SCOPE_DENIED",
      );
    }
    if (!supportsInteraction(resourceType, "read")) {
      // NOT `not-found`. A 404/not-found is a statement about the TENANT'S data ("you have no such
      // record"); this is a statement about the SERVER ("I do not serve that"). Answering the first
      // when the second is true is how a partner concludes a patient has no medications.
      return sendOutcome(
        reply,
        404,
        "warning",
        "not-supported",
        servedResource(resourceType) === undefined
          ? `${resourceType} is not served by this FHIR gateway`
          : `${resourceType} supports search only on this FHIR gateway; read by id is not available`,
        "FHIR_NOT_SUPPORTED",
      );
    }
    let projection: Awaited<ReturnType<typeof projectResourceById>>;
    try {
      projection = await projectResourceById(await projectionContext(ctx), resourceType, id);
    } catch (error) {
      if (!unboundReader(error)) throw error;
      request.log.warn({ err: error, resourceType }, "M28 R4: reader seam unbound");
      return sendOutcome(
        reply,
        503,
        "error",
        "processing",
        `${resourceType} cannot be read on this deployment: its owner module's reader seam is not bound`,
        "FHIR_READER_UNBOUND",
      );
    }
    if (projection === null || projection.resources.length === 0) {
      // Genuinely absent, OR filtered by the D3 consent gate. Deliberately indistinguishable: telling a
      // recipient "this exists but you may not see it" is itself a disclosure — that the patient has a
      // record of that type — which is exactly what an absent 42 CFR Part 2 release forbids. The
      // advisory that IS returned says content was suppressed without saying what.
      const outcome = operationOutcome(
        "warning",
        "not-found",
        `${resourceType}/${id} was not found`,
        "FHIR_NOT_FOUND",
      );
      reply.code(404).header("content-type", FHIR_JSON_CONTENT_TYPE);
      return {
        ...outcome,
        issue: [...outcome.issue, ...(projection?.warnings.flatMap((w) => w.issue) ?? [])],
      };
    }
    const resource = projection.resources[0] as Record<string, unknown>;
    // Accounted for AFTER the body exists, with the real count (§164.528). A refused or absent read
    // disclosed nothing and must not appear in an accounting.
    await auditRead({
      organizationId: ctx.organizationId,
      fhirClientId: ctx.clientId,
      resourceType,
      ...(resourceType === "Patient" ? { patientId: id } : {}),
      queryParameters: { _id: id },
      resultCount: 1,
      servedAt: now(),
    });
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return resource;
  });

  // ── R5 — type-level search ───────────────────────────────────────────────────────────────────────
  app.get("/fhir/r4/:resourceType", async (request, reply) => {
    const ctx = await resolveBearer(request, reply);
    if (ctx === null) return reply;
    const { resourceType } = parse(ResourceTypeParams, request.params);
    if (!hasReadScope(ctx, resourceType)) {
      return sendOutcome(
        reply,
        403,
        "error",
        "forbidden",
        `scope system/${resourceType}.read is required`,
        "FHIR_SCOPE_DENIED",
      );
    }
    if (!supportsInteraction(resourceType, "search-type")) {
      return sendOutcome(
        reply,
        404,
        "warning",
        "not-supported",
        `${resourceType} is not served by this FHIR gateway`,
        "FHIR_NOT_SUPPORTED",
      );
    }
    const query = parseQuery(ResourceSearchQuery, request.query);
    let projection: Awaited<ReturnType<typeof projectSearch>>;
    try {
      projection = await projectSearch(await projectionContext(ctx), resourceType, {
        patient: query.patient,
        _id: query._id,
        identifier: query.identifier,
        _since: query._since,
        _count: query._count,
      });
    } catch (error) {
      if (!unboundReader(error)) throw error;
      request.log.warn({ err: error, resourceType }, "M28 R5: reader seam unbound");
      return sendOutcome(
        reply,
        503,
        "error",
        "processing",
        `${resourceType} cannot be searched on this deployment: its owner module's reader seam is not bound`,
        "FHIR_READER_UNBOUND",
      );
    }
    const resources = projection?.resources ?? [];
    const warnings = projection?.warnings ?? [];
    const queryParameters: Record<string, string> = {};
    if (query.patient) queryParameters.patient = query.patient;
    if (query._id) queryParameters._id = query._id;
    if (query.identifier) queryParameters.identifier = query.identifier;
    if (query._since) queryParameters._since = query._since;
    // A search that matched nothing is still a search, but it disclosed nothing, so it is not an
    // accounting entry (§164.528 accounts for DISCLOSURES, not for requests).
    if (resources.length > 0) {
      await auditRead({
        organizationId: ctx.organizationId,
        fhirClientId: ctx.clientId,
        resourceType,
        ...(query.patient ? { patientId: query.patient } : {}),
        queryParameters,
        resultCount: resources.length,
        servedAt: now(),
      });
    }
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return {
      resourceType: "Bundle",
      type: "searchset",
      total: resources.length,
      // W-FHIR-03: the `suppressed` advisories ride IN the Bundle as `OperationOutcome` entries with
      // `search.mode = "outcome"`, which is where a FHIR consumer looks for "some results were withheld".
      // Dropping them would make a consent-filtered search indistinguishable from an empty one, and that
      // silent gap is the §4001 information-blocking shape the advisory exists to avoid.
      entry: [
        ...resources.map((resource) => ({ resource, search: { mode: "match" } })),
        ...warnings.map((resource) => ({ resource, search: { mode: "outcome" } })),
      ],
      link: [],
    };
  });

  // ── R17 / R18 — FHIR R5 / R6: 415 Unsupported Media Type ─────────────────────────────────────────
  app.get("/fhir/r5/*", async (_request, reply) =>
    sendOutcome(
      reply,
      415,
      "error",
      "not-supported",
      "FHIR R5 is not supported (D1/D7)",
      "FHIR_VERSION_UNSUPPORTED",
    ),
  );
  app.get("/fhir/r6/*", async (_request, reply) =>
    sendOutcome(
      reply,
      415,
      "error",
      "not-supported",
      "FHIR R6 is not supported (D1/D7)",
      "FHIR_VERSION_UNSUPPORTED",
    ),
  );
}

/** Re-exported so the token vocabulary (TTL) is reachable from the route barrel. */
export { FHIR_SESSION_TTL_MINUTES, isSupportedScope };
