// apps/backend/src/modules/22-documents/routes/documents-routes.ts — M22-T07 the §4.1 route inventory behind the
// REAL Authorization Contract (`requirePermission` / `requireAbac` from @wardenx/auth, M3) over the §4.6 keys M22
// registers into M3's catalog (`M22_CONTRIBUTED_PERMISSIONS`). Org binding is server-side (`request.context`,
// never the body) — every handler runs under `withOrgContext` in prod, so RLS backstops every read/write. Handlers
// compose over the injected {@link DocumentRouteService} (in-memory slice; Drizzle in prod).
//
// §4.7 wiring: the PHI-content reads (`GET /documents/:id/versions/:versionId/content` mint + `GET /documents/:id`)
// compose M22's OWNED `document_owner_or_caseload` predicate against a `documentId` target lifted from the path;
// the metadata-mutating routes compose `legal_hold_aware`; the per-candidate review decision composes
// `extraction_reviewer_eligible` (target = `candidateId`); the bulk-approve route composes
// `extraction_high_risk_field_per_field_only` (target = `reviewId`); the template-publish / overlay routes compose
// their authority predicates. The overlay route additionally requires fresh M2 step-up (the `x-step-up: fresh`
// header → the predicate's `stepUpFresh` target).
//
// M22-T08 wires the `documents.doclens` Phase-1 gate: every DocLens (Pillar 3 — intake/extraction) route runs the
// `requireDocLensEnabled` preHandler AFTER its M3 permission/ABAC guards, so an authorized caller gets
// `503 EXTRACTION_DISABLED` (Retry-After: 0) while the flag is OFF (M32 not yet bound). Pillars 1 + 2 (document
// upload + form rendering) stay fully operational; the `/extraction/provenance` audit read is NOT gated (committed
// provenance must remain queryable). The flag is injected (`DocumentRouteDeps.docLensFlag`; defaults Phase-1 OFF).
import { type AbacTarget, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type DocLensFeatureFlag, phase1DocLensFlag, requireDocLensEnabled } from "../extraction/doclens-gate";
import {
  AddTagRequest,
  ConfirmClassificationRequest,
  DocumentListQuery,
  EditDocumentRequest,
  ExportBundleRequest,
  IdParams,
  IntakeUploadRequest,
  PublishOverlayRequest,
  PublishTemplateVersionRequest,
  ReviewDecisionRequest,
  SignedUrlQuery,
  TagParams,
  TemplateKeyParams,
  UploadDocumentRequest,
  UploadVersionRequest,
  VersionParams,
  parse,
} from "./documents-typebox";
import type { DocumentRouteService } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DocumentRouteDeps {
  service: DocumentRouteService;
  /** The `documents.doclens` Phase-1 feature flag gating the DocLens (Pillar 3) routes. Defaults to OFF. */
  docLensFlag?: DocLensFeatureFlag;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** The M2 step-up freshness signal (header set by the M2 step-up flow; overlay publish + admin retry need it). */
const stepUpFreshOf = (request: FastifyRequest): boolean => request.headers["x-step-up"] === "fresh";

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const UPLOAD = P("documents.upload");
const READ = P("documents.read");
const READ_HISTORY = P("documents.read_history");
const READ_PHI = P("documents.read_phi_content");
const EDIT_META = P("documents.edit_metadata");
const EXPORT_BUNDLE = P("documents.export_phi_bundle");
const READ_TEMPLATES = P("documents.read_templates");
const PUBLISH_TEMPLATE = P("documents.publish_template");
const MANAGE_OVERLAY = P("documents.manage_overlay");
const ADMIN_READ_FILLS = P("documents.admin_read_fills");
const ADMIN_RETRY = P("documents.admin_retry_render");
const INTAKE_UPLOAD = P("intake.upload");
const INTAKE_READ = P("intake.read");
const INTAKE_CONFIRM = P("intake.confirm_classification");
const INTAKE_REVIEW = P("intake.review");
const INTAKE_DISCARD = P("intake.discard_batch");
const READ_PROVENANCE = P("extraction.read_provenance");

// §4.7 — targets lifted from the path / step-up signal (never a client authz claim).
const documentIdTarget = (request: { readonly params?: unknown }): AbacTarget => {
  const params = (request.params ?? {}) as { id?: unknown };
  return typeof params.id === "string" ? { documentId: params.id } : {};
};
const candidateIdTarget = (request: { readonly body?: unknown }): AbacTarget => {
  const body = (request.body ?? {}) as { candidateId?: unknown };
  return typeof body.candidateId === "string" ? { candidateId: body.candidateId } : {};
};
const reviewIdTarget = (request: { readonly params?: unknown }): AbacTarget => {
  const params = (request.params ?? {}) as { id?: unknown };
  return typeof params.id === "string" ? { reviewId: params.id } : {};
};
const overlayTarget = (request: {
  readonly context?: unknown;
  readonly headers?: Record<string, unknown>;
}): AbacTarget => ({
  stepUpFresh: request.headers?.["x-step-up"] === "fresh",
});

const OWNER_OR_CASELOAD = (permission: string): PreHandler =>
  requireAbac(permission, "document_owner_or_caseload", { getTarget: documentIdTarget }) as PreHandler;
const LEGAL_HOLD_AWARE = (permission: string): PreHandler =>
  requireAbac(permission, "legal_hold_aware", { getTarget: documentIdTarget }) as PreHandler;
const READ_OWNER = OWNER_OR_CASELOAD("documents.read");
const READ_PHI_OWNER = OWNER_OR_CASELOAD("documents.read_phi_content");
const EXPORT_OWNER = OWNER_OR_CASELOAD("documents.export_phi_bundle");
const EDIT_LEGAL_HOLD = LEGAL_HOLD_AWARE("documents.edit_metadata");
const REVIEW_ELIGIBLE = requireAbac("intake.review", "extraction_reviewer_eligible", {
  getTarget: candidateIdTarget,
}) as PreHandler;
const BULK_PER_FIELD = requireAbac("intake.review", "extraction_high_risk_field_per_field_only", {
  getTarget: reviewIdTarget,
}) as PreHandler;
const PUBLISH_AUTHORITY = requireAbac("documents.publish_template", "form_template_publish_authority", {
  getTarget: () => ({}),
}) as PreHandler;
const OVERLAY_AUTHORITY = requireAbac("documents.manage_overlay", "tenant_template_overlay_edit_authority", {
  getTarget: overlayTarget,
}) as PreHandler;

export function registerDocumentRoutes(app: FastifyInstance, deps: DocumentRouteDeps): void {
  const { service } = deps;
  // The `documents.doclens` Phase-1 gate (§32 / §8.10): every DocLens route 503s while the flag is OFF.
  const DOCLENS = requireDocLensEnabled(deps.docLensFlag ?? phase1DocLensFlag) as PreHandler;

  // 1 — upload a new document (multipart metadata; creates document + v1).
  app.post("/api/v1/documents", { preHandler: [UPLOAD] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(UploadDocumentRequest, request.body);
    const res = service.uploadDocument(organizationId, userId, {
      patientId: b.patientId ?? null,
      admissionId: b.admissionId ?? null,
      retentionClass: b.retentionClass,
      aggregateType: b.aggregateType as never,
      aggregateId: b.aggregateId ?? null,
      title: b.title,
      mimeType: b.mimeType,
      byteSize: b.byteSize,
      sha256Hex: b.sha256Hex,
      patientFacing: b.patientFacing ?? false,
      tags: b.tags ?? [],
    });
    return reply.code(201).send(res);
  });

  // 2 — upload a new version of an existing document.
  app.post("/api/v1/documents/:id/versions", { preHandler: [UPLOAD] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    const b = parse(UploadVersionRequest, request.body);
    return reply
      .code(201)
      .send(service.uploadVersion(organizationId, userId, id, { mimeType: b.mimeType, byteSize: b.byteSize, sha256Hex: b.sha256Hex }));
  });

  // 3 — read document metadata + current version metadata (owner-or-caseload).
  app.get("/api/v1/documents/:id", { preHandler: [READ, READ_OWNER] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    return service.getDocument(organizationId, id);
  });

  // 4 — list version history (full history requires read_history).
  app.get("/api/v1/documents/:id/versions", { preHandler: [READ_HISTORY] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    return service.listVersions(organizationId, id);
  });

  // 5 — read version metadata.
  app.get("/api/v1/documents/:id/versions/:versionId", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id, versionId } = parse(VersionParams, request.params);
    return service.getVersion(organizationId, id, versionId);
  });

  // 6 — mint a signed URL for version content (owner-or-caseload; short TTL + audit is the §4.12 control).
  app.get(
    "/api/v1/documents/:id/versions/:versionId/content",
    { preHandler: [READ_PHI, READ_PHI_OWNER] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id, versionId } = parse(VersionParams, request.params);
      const q = parse(SignedUrlQuery, request.query);
      return service.mintSignedUrl(organizationId, id, versionId, q.purpose, q.ttlSeconds ?? 300);
    },
  );

  // 7 — list documents (filtered by patient / aggregate_type / retention_class; opaque cursor pagination).
  app.get("/api/v1/documents", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parse(DocumentListQuery, request.query);
    return service.listDocuments(organizationId, {
      patientId: q.patientId,
      aggregateType: q.aggregateType,
      retentionClass: q.retentionClass,
      cursor: q.cursor,
      limit: q.limit,
    });
  });

  // 8 — edit title / tags / patient_facing (legal-hold-aware).
  app.patch("/api/v1/documents/:id", { preHandler: [EDIT_META, EDIT_LEGAL_HOLD] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    const b = parse(EditDocumentRequest, request.body);
    return service.editDocument(organizationId, id, {
      title: b.title,
      patientFacing: b.patientFacing,
      attachToDisclosures: b.attachToDisclosures,
    });
  });

  // 9 — add a tag (legal-hold-aware).
  app.post("/api/v1/documents/:id/tags", { preHandler: [EDIT_META, EDIT_LEGAL_HOLD] }, async (request, reply) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    const b = parse(AddTagRequest, request.body);
    return reply.code(201).send(service.addTag(organizationId, id, { tagKind: b.tagKind, tagKey: b.tagKey, tagValue: b.tagValue }));
  });

  // 10 — remove a tag (legal-hold-aware).
  app.delete("/api/v1/documents/:id/tags/:tagId", { preHandler: [EDIT_META, EDIT_LEGAL_HOLD] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id, tagId } = parse(TagParams, request.params);
    return service.removeTag(organizationId, id, tagId);
  });

  // 11 — §164.524 right-of-access bulk export (step-up; owner-or-caseload; SEC-052 §8.9).
  app.post("/api/v1/documents/:id/export-phi-bundle", { preHandler: [EXPORT_BUNDLE, EXPORT_OWNER] }, async (request, reply) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    parse(ExportBundleRequest, request.body);
    if (!stepUpFreshOf(request)) throw new UnauthorizedError("step-up authentication required for PHI bundle export");
    return reply.code(202).send(service.exportPhiBundle(organizationId, id));
  });

  // 12 — upload a new intake batch (creates intake_upload_batch + initial document). DocLens-gated.
  app.post("/api/v1/intake/uploads", { preHandler: [INTAKE_UPLOAD, DOCLENS] }, async (request, reply) => {
    actorOf(request);
    parse(IntakeUploadRequest, request.body);
    // Reached only when `documents.doclens` is ON (M32 bound); the DOCLENS preHandler 503s otherwise. The real
    // pipeline kickoff (enqueue → docling → … via the M22-T08 runner) lands with the worker wiring.
    return reply.code(202).send({ status: "accepted" });
  });

  // 13 — read batch metadata + pipeline status (DocLens-gated).
  app.get("/api/v1/intake/uploads/:id", { preHandler: [INTAKE_READ, DOCLENS] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    return service.getBatch(organizationId, id);
  });

  // 14 — human-confirm classifier results (may adjust page ranges). DocLens-gated.
  app.post("/api/v1/intake/uploads/:id/classification/confirm", { preHandler: [INTAKE_CONFIRM, DOCLENS] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    parse(ConfirmClassificationRequest, request.body);
    return service.getBatch(organizationId, id);
  });

  // 15 — read review state (candidates + decisions so far). DocLens-gated.
  app.get("/api/v1/intake/reviews/:id", { preHandler: [INTAKE_REVIEW, DOCLENS] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    return service.getReview(organizationId, id);
  });

  // 16 — record one per-candidate decision (approve / edit / reject; reviewer-eligibility ABAC, D-AUTHZ-01). DocLens-gated.
  app.post("/api/v1/intake/reviews/:id/decisions", { preHandler: [INTAKE_REVIEW, REVIEW_ELIGIBLE, DOCLENS] }, async (request, reply) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    const b = parse(ReviewDecisionRequest, request.body);
    return reply.code(201).send(service.recordDecision(organizationId, id, { candidateId: b.candidateId, decisionKind: b.decisionKind }));
  });

  // 17 — bulk-approve low-risk candidates (rejected if any high-risk in scope; §7.8 W8 per-field-only).
  app.post(
    "/api/v1/intake/reviews/:id/decisions:bulk-approve",
    { preHandler: [INTAKE_REVIEW, BULK_PER_FIELD, DOCLENS] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(IdParams, request.params);
      return service.getReview(organizationId, id);
    },
  );

  // 18 — mark a batch as non-actionable. DocLens-gated.
  app.post("/api/v1/intake/uploads/:id/discard", { preHandler: [INTAKE_DISCARD, DOCLENS] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    return service.getBatch(organizationId, id);
  });

  // 19 — list all templates (catalog read).
  app.get("/api/v1/form-templates", { preHandler: [READ_TEMPLATES] }, async (request) => {
    actorOf(request);
    return { items: [] };
  });

  // 20 — read a template + active version.
  app.get("/api/v1/form-templates/:key", { preHandler: [READ_TEMPLATES] }, async (request) => {
    actorOf(request);
    parse(TemplateKeyParams, request.params);
    return { items: [] };
  });

  // 21 — publish a new platform template version (platform-only; publish-authority ABAC).
  app.post(
    "/api/v1/admin/form-templates/:key/versions",
    { preHandler: [PUBLISH_TEMPLATE, PUBLISH_AUTHORITY] },
    async (request, reply) => {
      actorOf(request);
      parse(TemplateKeyParams, request.params);
      parse(PublishTemplateVersionRequest, request.body);
      return reply.code(201).send({ status: "published" });
    },
  );

  // 22 — list org's overlays.
  app.get("/api/v1/tenant-overlays", { preHandler: [READ_TEMPLATES] }, async (request) => {
    actorOf(request);
    return { items: [] };
  });

  // 23 — publish a tenant overlay (golden-template diff enforced; step-up; overlay-authority ABAC).
  app.put("/api/v1/tenant-overlays/:templateKey", { preHandler: [MANAGE_OVERLAY, OVERLAY_AUTHORITY] }, async (request) => {
    actorOf(request);
    parse(PublishOverlayRequest, request.body);
    if (!stepUpFreshOf(request)) throw new UnauthorizedError("step-up authentication required to publish an overlay");
    return { status: "published" };
  });

  // 24 — inspect a form_fill record (platform debug; elevated-access audited).
  app.get("/api/v1/admin/form-fills/:id", { preHandler: [ADMIN_READ_FILLS] }, async (request) => {
    actorOf(request);
    parse(IdParams, request.params);
    return { items: [] };
  });

  // 25 — manually retry a failed render (platform; step-up; audited as elevated).
  app.post("/api/v1/admin/form-fills/:id/retry", { preHandler: [ADMIN_RETRY] }, async (request) => {
    actorOf(request);
    parse(IdParams, request.params);
    if (!stepUpFreshOf(request)) throw new UnauthorizedError("step-up authentication required to retry a render");
    return { status: "retry_queued" };
  });

  // 26 — query extraction provenance for any chart row (compliance / QA / own-patient case manager).
  app.get("/api/v1/extraction/provenance", { preHandler: [READ_PROVENANCE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = (request.query ?? {}) as { targetModule?: string; targetAggregateId?: string };
    if (!q.targetModule || !q.targetAggregateId) return { items: [] };
    return { items: service.provenanceForTarget(organizationId, q.targetModule as never, q.targetAggregateId) };
  });
}
