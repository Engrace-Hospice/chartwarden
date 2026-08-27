import { buildCapabilityStatement, isSupportedScope } from "@wardenx/fhir";
// apps/backend/src/modules/28-fhir/routes/fhir-r4.routes.ts — §4.1 R1-R22: the FHIR-spec HTTP surface.
//
// These routes authenticate with a SMART bearer token (NOT a WardenX session), so they do NOT compose the
// M3 `requirePermission`/`requireAbac` preHandlers — their gate is the bearer resolution + the client's
// `allowed_scopes`, applied in the handler. Every error is a FHIR `OperationOutcome`
// (`application/fhir+json`); the admin surface (R23-R39) uses the WardenX envelope instead.
//
// ── PHASE-1 POSTURE (read-only US Core R4, `fhir.write` OFF) ────────────────────────────────────────
//
//   · The projection pipeline (`@wardenx/fhir` mappers/search) reads through the M28 consumed seams, which
//     are M1 fail-closed deny-stubs this wave — so a live single-resource read has no data path and R4/R6
//     return a well-formed empty result rather than a 500 from a deny-stub throw. The SHAPE (scope
//     enforcement, disclosure audit, OperationOutcome envelope) is real and is what the surface guarantees.
//   · Claim / ClaimResponse / ExplanationOfBenefit / ServiceRequest / QuestionnaireResponse / Location
//     short-circuit to 404 BEFORE reaching any reader (W-FHIR-07): they are registered as CONCRETE routes
//     so Fastify prefers them over the generic `:resourceType` param route.
//   · R5/R6 (FHIR R5/R6) return 415 via a wildcard.
//   · The token endpoint (R3) validates the SMART Backend Services form and resolves the client; with no
//     platform-bypass client-resolution path bound this wave it fails CLOSED (`invalid_client`), which is
//     correct — no external client is provisioned yet.
import {
  FHIR_FORWARD_SEAM_RESOURCES,
  FHIR_PHASE_1_VERSION,
  FHIR_SESSION_TTL_MINUTES,
  type FhirReadDisclosureEnvelope,
} from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getFhirTerminologyProvider } from "../seams/index";
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
import type { FhirBearerContext, FhirGatewayStore } from "./store";

/** A disclosure-audit sink for served FHIR reads (D15 / §164.528). Injected; defaults to a no-op. */
export interface FhirDisclosureAuditPort {
  auditRead(envelope: FhirReadDisclosureEnvelope): Promise<void>;
}

export interface FhirR4RouteDeps {
  readonly store: FhirGatewayStore;
  /** Absent ⇒ disclosure reads are not persisted (db-less boot); the shape still runs. */
  readonly audit?: FhirDisclosureAuditPort;
  readonly now?: () => string;
}

/** The resource types the Phase-1 CapabilityStatement advertises `read` + `search-type` on. */
const ADVERTISED_RESOURCES = [
  "Patient",
  "Encounter",
  "Condition",
  "Observation",
  "MedicationRequest",
  "MedicationStatement",
  "MedicationAdministration",
  "DiagnosticReport",
  "CarePlan",
  "Goal",
  "DocumentReference",
  "Coverage",
] as const;

const bearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
};

export function registerFhirR4Routes(app: FastifyInstance, deps: FhirR4RouteDeps): void {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const auditRead = async (envelope: FhirReadDisclosureEnvelope): Promise<void> => {
    if (deps.audit) await deps.audit.auditRead(envelope);
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
    if (ctx === null || ctx.clientStatus !== "active") {
      await reply
        .code(401)
        .header("content-type", FHIR_JSON_CONTENT_TYPE)
        .send(
          operationOutcome(
            "error",
            "security",
            "the bearer token is invalid or expired",
            "FHIR_BAD_BEARER",
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
      resources: ADVERTISED_RESOURCES.map((type) => ({
        type,
        interactions: ["read", "search-type"] as const,
        searchParams: type === "Patient" ? ["identifier", "name"] : ["patient"],
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

  // ── R3 — SMART Backend Services token mint ───────────────────────────────────────────────────────
  app.post("/fhir/oauth2/token", async (request, reply) => {
    const body = parse(TokenFormBody, request.body);
    void body; // shape validated; the client-assertion verification + session mint bind with the
    // platform-bypass client-resolution path (Phase-1 fail-closed — no external client is provisioned).
    reply.code(401).header("content-type", "application/json");
    return {
      error: "invalid_client",
      error_description:
        "the presenting client could not be resolved (Phase-1 fail-closed: no external FHIR client is provisioned)",
    };
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
    await auditRead({
      organizationId: ctx.organizationId,
      fhirClientId: ctx.clientId,
      resourceType: "Patient",
      patientId,
      queryParameters: { $everything: "true" },
      resultCount: 0,
      servedAt: now(),
    });
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return { resourceType: "Bundle", type: "searchset", total: 0, entry: [] };
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
    await auditRead({
      organizationId: ctx.organizationId,
      fhirClientId: ctx.clientId,
      resourceType,
      queryParameters: { _id: id },
      resultCount: 0,
      servedAt: now(),
    });
    // Phase 1: the projection reader seams are fail-closed deny-stubs, so no live single-resource read
    // has a data path — a well-formed not-found is the honest answer, never a 500 from a deny-stub throw.
    return sendOutcome(
      reply,
      404,
      "warning",
      "not-found",
      `${resourceType}/${id} was not found`,
      "FHIR_NOT_FOUND",
    );
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
    const query = parseQuery(ResourceSearchQuery, request.query);
    await auditRead({
      organizationId: ctx.organizationId,
      fhirClientId: ctx.clientId,
      resourceType,
      ...(query.patient ? { patientId: query.patient } : {}),
      queryParameters: query.patient ? { patient: query.patient } : {},
      resultCount: 0,
      servedAt: now(),
    });
    reply.header("content-type", FHIR_JSON_CONTENT_TYPE);
    return { resourceType: "Bundle", type: "searchset", total: 0, entry: [], link: [] };
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
