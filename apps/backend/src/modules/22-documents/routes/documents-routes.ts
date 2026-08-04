// apps/backend/src/modules/22-documents/routes/documents-routes.ts — M22-T07 the §4.1 route inventory
// (33 routes) behind the REAL Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth,
// M3) on the §4.6 keys M22 registers into M3's catalog (M22_CONTRIBUTED_PERMISSIONS). Org binding is
// server-side (`request.context`, never the body). Handlers compose over the injected DocumentRouteService
// (in-memory slice; Drizzle in prod under `withOrgContext` so RLS backstops). PHI list routes paginate by
// the opaque keyset cursor (§4.1 / SD-052); the signed-URL content route composes the injected
// SignedUrlService (T03 plan + T04 presign port + §4.12 BAA gate); the overlay PUT layers `If-Match`
// optimistic concurrency (§2.5 → 412). The §4.7 predicates M22 owns gate the PHI-content + review +
// publish + mutate routes via `requireAbac`.
import { type GuardRequest, requireAbac, requirePermission } from "@wardenx/auth";
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ifMatchVersionOf, requireIfMatch } from "./concurrency";
import {
  AbandonReviewRequest,
  AddTagRequest,
  BatchParamsSchema,
  BulkApproveRequest,
  ClassificationQuerySchema,
  CompleteReviewRequest,
  ConfirmClassificationRequest,
  DiscardBatchRequest,
  DiscrepancyParamsSchema,
  DocumentListQuerySchema,
  DocumentParamsSchema,
  ExportPhiBundleRequest,
  FormFillParamsSchema,
  IntakeUploadRequest,
  JobParamsSchema,
  JobQuerySchema,
  JobsListQuerySchema,
  OpenReviewRequest,
  OverlayParamsSchema,
  PatchDocumentRequest,
  PublishOverlayRequest,
  PublishTemplateRequest,
  RecordDecisionRequest,
  ResolveDiscrepancyRequest,
  RetryRenderRequest,
  ReviewParamsSchema,
  ReviewQuerySchema,
  SignedUrlRequest,
  TagParamsSchema,
  TemplateListQuerySchema,
  TemplateParamsSchema,
  TemplateVersionParamsSchema,
  UploadDocumentRequest,
  UploadVersionRequest,
  VersionListQuerySchema,
  VersionParamsSchema,
  parse,
} from "./documents-typebox";
import type { DocumentRouteService } from "./service";
import type { SignedUrlService } from "./signed-url-service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DocumentRouteDeps {
  service: DocumentRouteService;
  signedUrl: SignedUrlService;
}

function actorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  roles: readonly string[];
} {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

const docIdOf = (request: FastifyRequest): string => parse(DocumentParamsSchema, request.params).id;

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const UPLOAD = P("documents.upload");
const READ = P("documents.read");
const READ_PHI = P("documents.read_phi_content");
const EDIT = P("documents.edit_metadata");
const EXPORT = P("documents.export_phi_bundle");
const READ_TEMPLATES = P("documents.read_templates");
const PUBLISH_TEMPLATE = P("documents.publish_template");
const MANAGE_OVERLAY = P("documents.manage_overlay");
const ADMIN_READ_FILLS = P("documents.admin_read_fills");
const ADMIN_RETRY_RENDER = P("documents.admin_retry_render");
const INTAKE_UPLOAD = P("intake.upload");
const INTAKE_READ = P("intake.read");
const INTAKE_CONFIRM = P("intake.confirm_classification");
const INTAKE_REVIEW = P("intake.review");
const INTAKE_DISCARD = P("intake.discard_batch");

// §4.7 ABAC guards M22 owns (target = request.params → `id`).
const ABAC_OWNER = requireAbac("documents.read_phi_content", "document_owner_or_caseload", {
  notFoundOnDeny: true,
}) as PreHandler;
const ABAC_LEGAL_HOLD = requireAbac("documents.edit_metadata", "legal_hold_aware") as PreHandler;
// The candidate's risk level is a server-resolved fact (the candidate row in prod); the slice surfaces it on
// the query so the eligibility predicate is exercisable end-to-end. M22 never authorizes off the request body.
const riskTarget = (request: GuardRequest): Record<string, unknown> => {
  const q = request.query as { riskLevel?: unknown } | undefined;
  return { ...(request.params as Record<string, unknown>), riskLevel: q?.riskLevel };
};
const bulkTarget = (request: GuardRequest): Record<string, unknown> => {
  const q = request.query as { anyHighRisk?: unknown } | undefined;
  return { ...(request.params as Record<string, unknown>), anyHighRisk: q?.anyHighRisk === "true" };
};
const ABAC_REVIEWER = requireAbac("intake.review", "extraction_reviewer_eligible", {
  getTarget: riskTarget,
}) as PreHandler;
const ABAC_BULK = requireAbac("intake.review", "extraction_high_risk_field_per_field_only", {
  getTarget: bulkTarget,
}) as PreHandler;
const ABAC_PUBLISH = requireAbac(
  "documents.publish_template",
  "form_template_publish_authority",
) as PreHandler;
const ABAC_OVERLAY = requireAbac(
  "documents.manage_overlay",
  "tenant_template_overlay_edit_authority",
) as PreHandler;

// §2.5 optimistic concurrency — the overlay PUT carries the read version in If-Match.
const IF_MATCH = requireIfMatch() as PreHandler;

export function registerDocumentRoutes(app: FastifyInstance, deps: DocumentRouteDeps): void {
  const { service, signedUrl } = deps;

  // 1 — upload new document (creates document + version v1).
  app.post("/api/v1/documents", { preHandler: [UPLOAD] }, async (request, reply) => {
    const { organizationId, userId } = actorOf(request);
    const body = parse(UploadDocumentRequest, request.body);
    const res = await service.uploadDocument(organizationId, userId, {
      patientId: body.patientId ?? null,
      admissionId: body.admissionId ?? null,
      retentionClass: body.retentionClass,
      aggregateType: body.aggregateType,
      aggregateId: body.aggregateId ?? null,
      title: body.title,
      patientFacing: body.patientFacing ?? false,
    });
    return reply.code(201).send(res);
  });

  // 7 — list documents (static path before the :id routes; filtered + cursor-paginated).
  app.get(
    "/api/v1/documents",
    { preHandler: [READ], config: { auditRead: { resourceKind: "document", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(DocumentListQuerySchema, request.query);
      return service.listDocuments(
        organizationId,
        {
          patientId: q.patientId,
          aggregateType: q.aggregateType,
          retentionClass: q.retentionClass,
        },
        q.cursor,
        q.limit,
      );
    },
  );

  // 2 — upload new version of an existing document.
  app.post("/api/v1/documents/:id/versions", { preHandler: [UPLOAD] }, async (request, reply) => {
    const { organizationId } = actorOf(request);
    parse(UploadVersionRequest, request.body);
    const res = await service.uploadVersion(organizationId, docIdOf(request));
    return reply.code(201).send(res);
  });

  // 4 — list version history (cursor-paginated).
  app.get(
    "/api/v1/documents/:id/versions",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "document_version", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(VersionListQuerySchema, request.query);
      return service.listVersions(organizationId, docIdOf(request), q.cursor, q.limit);
    },
  );

  // 6 — mint signed URL + (in prod) 302 redirect to MinIO. ABAC: document_owner_or_caseload (§4.7).
  app.get(
    "/api/v1/documents/:id/versions/:versionId/content",
    {
      preHandler: [READ_PHI, ABAC_OWNER],
      config: { auditRead: { resourceKind: "document", resourceIdParam: "versionId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id, versionId } = parse(VersionParamsSchema, request.params);
      const q = parse(SignedUrlRequest, request.query);
      return signedUrl.mint({
        organizationId,
        documentId: id,
        versionId,
        purpose: q.purpose,
        ttlSeconds: q.ttlSeconds,
      });
    },
  );

  // 5 — read version metadata.
  app.get(
    "/api/v1/documents/:id/versions/:versionId",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "document_version", resourceIdParam: "versionId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id, versionId } = parse(VersionParamsSchema, request.params);
      return service.getVersion(organizationId, id, versionId);
    },
  );

  // 3 — read document metadata + current version metadata.
  app.get(
    "/api/v1/documents/:id",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "document", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getDocument(organizationId, docIdOf(request));
    },
  );

  // 8 — edit metadata (legal_hold_aware ABAC denies while a hold is active, §4.7).
  app.patch("/api/v1/documents/:id", { preHandler: [EDIT, ABAC_LEGAL_HOLD] }, async (request) => {
    const { organizationId } = actorOf(request);
    const body = parse(PatchDocumentRequest, request.body);
    return service.patchDocument(organizationId, docIdOf(request), {
      title: body.title,
      patientFacing: body.patientFacing,
      attachToDisclosures: body.attachToDisclosures,
    });
  });

  // 9 — add tag.
  app.post(
    "/api/v1/documents/:id/tags",
    { preHandler: [EDIT, ABAC_LEGAL_HOLD] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(AddTagRequest, request.body);
      const res = await service.addTag(organizationId, docIdOf(request), {
        tagKind: body.tagKind,
        tagKey: body.tagKey,
        tagValue: body.tagValue ?? null,
      });
      return reply.code(201).send(res);
    },
  );

  // 10 — remove tag.
  app.delete(
    "/api/v1/documents/:id/tags/:tagId",
    { preHandler: [EDIT, ABAC_LEGAL_HOLD] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id, tagId } = parse(TagParamsSchema, request.params);
      await service.removeTag(organizationId, id, tagId);
      return reply.code(204).send();
    },
  );

  // 11 — §164.524 right-of-access bulk export (step-up at the route; SEC-052).
  app.post(
    "/api/v1/documents/:id/export-phi-bundle",
    { preHandler: [EXPORT, ABAC_OWNER] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const body = parse(ExportPhiBundleRequest, request.body);
      const res = await service.exportPhiBundle(organizationId, {
        patientId: body.patientId,
        purpose: body.purpose,
      });
      return reply.code(201).send(res);
    },
  );

  // ── intake (§4.1) ──────────────────────────────────────────────────────────────────────────────────

  // 12 — upload a new intake batch.
  app.post("/api/v1/intake/uploads", { preHandler: [INTAKE_UPLOAD] }, async (request, reply) => {
    const { organizationId } = actorOf(request);
    const body = parse(IntakeUploadRequest, request.body);
    const res = await service.uploadBatch(organizationId, {
      patientId: body.patientId ?? null,
      sourceChannel: body.sourceChannel,
    });
    return reply.code(201).send(res);
  });

  // 13 — read batch metadata + pipeline status.
  app.get(
    "/api/v1/intake/uploads/:id",
    {
      preHandler: [INTAKE_READ],
      config: { auditRead: { resourceKind: "intake_batch", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(BatchParamsSchema, request.params);
      return service.getBatch(organizationId, id);
    },
  );

  // 14 — read classifier output (cursor-paginated).
  app.get(
    "/api/v1/intake/uploads/:id/classification",
    {
      preHandler: [INTAKE_READ],
      config: { auditRead: { resourceKind: "intake_classification", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(BatchParamsSchema, request.params);
      const q = parse(ClassificationQuerySchema, request.query);
      return service.listClassification(organizationId, id, q.cursor, q.limit);
    },
  );

  // 15 — human-confirm classifier results.
  app.post(
    "/api/v1/intake/uploads/:id/classification/confirm",
    { preHandler: [INTAKE_CONFIRM] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(BatchParamsSchema, request.params);
      parse(ConfirmClassificationRequest, request.body);
      return service.confirmClassification(organizationId, id);
    },
  );

  // 16 — list extraction jobs for the batch (cursor-paginated).
  app.get(
    "/api/v1/intake/uploads/:id/jobs",
    {
      preHandler: [INTAKE_READ],
      config: { auditRead: { resourceKind: "intake_job", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(BatchParamsSchema, request.params);
      const q = parse(JobsListQuerySchema, request.query);
      return service.listJobs(organizationId, id, q.cursor, q.limit);
    },
  );

  // 17 — read job + candidates (candidates cursor-paginated).
  app.get(
    "/api/v1/intake/jobs/:id",
    {
      preHandler: [INTAKE_READ],
      config: { auditRead: { resourceKind: "intake_job", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(JobParamsSchema, request.params);
      const q = parse(JobQuerySchema, request.query);
      return service.getJob(organizationId, id, q.cursor, q.limit);
    },
  );

  // 18 — open extraction_review session (acquires lock).
  app.post(
    "/api/v1/intake/uploads/:id/review",
    { preHandler: [INTAKE_REVIEW] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(BatchParamsSchema, request.params);
      parse(OpenReviewRequest, request.body);
      const res = await service.openReview(organizationId, id, userId);
      return reply.code(201).send(res);
    },
  );

  // 19 — read review state (candidates + decisions; cursor-paginated).
  app.get(
    "/api/v1/intake/reviews/:id",
    {
      preHandler: [INTAKE_REVIEW],
      config: { auditRead: { resourceKind: "intake_review", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ReviewParamsSchema, request.params);
      const q = parse(ReviewQuerySchema, request.query);
      return service.getReview(organizationId, id, q.cursor, q.limit);
    },
  );

  // 20 — record per-candidate decision (extraction_reviewer_eligible ABAC, §4.7).
  app.post(
    "/api/v1/intake/reviews/:id/decisions",
    { preHandler: [INTAKE_REVIEW, ABAC_REVIEWER] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ReviewParamsSchema, request.params);
      const body = parse(RecordDecisionRequest, request.body);
      const res = await service.recordDecision(organizationId, id, {
        candidateId: body.candidateId,
        decision: body.decision,
      });
      return reply.code(201).send(res);
    },
  );

  // 21 — bulk-approve low-risk (extraction_high_risk_field_per_field_only ABAC → 422 if high-risk in scope).
  app.post(
    "/api/v1/intake/reviews/:id/decisions:bulk-approve",
    { preHandler: [INTAKE_REVIEW, ABAC_BULK] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ReviewParamsSchema, request.params);
      const body = parse(BulkApproveRequest, request.body);
      const res = await service.bulkApprove(organizationId, id, body.candidateIds);
      return reply.code(201).send(res);
    },
  );

  // 22 — resolve a discrepancy.
  app.post(
    "/api/v1/intake/reviews/:id/discrepancies/:discrepancyId/resolve",
    { preHandler: [INTAKE_REVIEW, ABAC_REVIEWER] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id, discrepancyId } = parse(DiscrepancyParamsSchema, request.params);
      parse(ResolveDiscrepancyRequest, request.body);
      return service.resolveDiscrepancy(organizationId, id, discrepancyId);
    },
  );

  // 23 — attest + trigger writeback dispatcher.
  app.post(
    "/api/v1/intake/reviews/:id/complete",
    { preHandler: [INTAKE_REVIEW] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ReviewParamsSchema, request.params);
      parse(CompleteReviewRequest, request.body);
      return service.completeReview(organizationId, id);
    },
  );

  // 24 — release lock; decisions preserved.
  app.post(
    "/api/v1/intake/reviews/:id/abandon",
    { preHandler: [INTAKE_REVIEW] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(ReviewParamsSchema, request.params);
      parse(AbandonReviewRequest, request.body);
      return service.abandonReview(organizationId, id);
    },
  );

  // 25 — mark batch non-actionable.
  app.post(
    "/api/v1/intake/uploads/:id/discard",
    { preHandler: [INTAKE_DISCARD] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(BatchParamsSchema, request.params);
      parse(DiscardBatchRequest, request.body);
      return service.discardBatch(organizationId, id);
    },
  );

  // ── form templates / overlays / admin (§4.1) ─────────────────────────────────────────────────────────

  // 26 — list all templates (cursor-paginated).
  app.get(
    "/api/v1/form-templates",
    {
      preHandler: [READ_TEMPLATES],
      config: { auditRead: { none: "org-wide form template catalog is config, not patient data" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(TemplateListQuerySchema, request.query);
      return service.listTemplates(organizationId, q.cursor, q.limit);
    },
  );

  // 27 — read template + active version.
  app.get(
    "/api/v1/form-templates/:key",
    {
      preHandler: [READ_TEMPLATES],
      config: { auditRead: { none: "form template + active version is config, not patient data" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { key } = parse(TemplateParamsSchema, request.params);
      return service.getTemplate(organizationId, key);
    },
  );

  // 28 — read a specific template version.
  app.get(
    "/api/v1/form-templates/:key/versions/:versionId",
    {
      preHandler: [READ_TEMPLATES],
      config: { auditRead: { none: "specific form template version is config, not patient data" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { key, versionId } = parse(TemplateVersionParamsSchema, request.params);
      return service.getTemplateVersion(organizationId, key, versionId);
    },
  );

  // 29 — publish a new template version (platform-only; form_template_publish_authority ABAC, §4.7).
  app.post(
    "/api/v1/admin/form-templates/:key/versions",
    { preHandler: [PUBLISH_TEMPLATE, ABAC_PUBLISH] },
    async (request, reply) => {
      const { organizationId } = actorOf(request);
      const { key } = parse(TemplateParamsSchema, request.params);
      const body = parse(PublishTemplateRequest, request.body);
      const res = await service.publishTemplateVersion(organizationId, key, {
        versionLabel: body.versionLabel,
      });
      return reply.code(201).send(res);
    },
  );

  // 30 — list org's overlays.
  app.get(
    "/api/v1/tenant-overlays",
    {
      preHandler: [READ_TEMPLATES],
      config: { auditRead: { none: "tenant template overlays are org config, not patient data" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.listOverlays(organizationId);
    },
  );

  // 31 — publish overlay (step-up + golden-template diff; tenant_template_overlay_edit_authority ABAC + If-Match).
  app.put(
    "/api/v1/tenant-overlays/:templateKey",
    { preHandler: [MANAGE_OVERLAY, ABAC_OVERLAY, IF_MATCH] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { templateKey } = parse(OverlayParamsSchema, request.params);
      parse(PublishOverlayRequest, request.body);
      return service.publishOverlay(organizationId, templateKey, ifMatchVersionOf(request));
    },
  );

  // 32 — inspect a form fill record (platform-only debug).
  app.get(
    "/api/v1/admin/form-fills/:id",
    {
      preHandler: [ADMIN_READ_FILLS],
      config: { auditRead: { resourceKind: "form_fill", resourceIdParam: "id" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(FormFillParamsSchema, request.params);
      return service.getFormFill(organizationId, id);
    },
  );

  // 33 — manually retry a failed render (platform-only; step-up; audited as elevated).
  app.post(
    "/api/v1/admin/form-fills/:id/retry",
    { preHandler: [ADMIN_RETRY_RENDER] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parse(FormFillParamsSchema, request.params);
      parse(RetryRenderRequest, request.body);
      return service.retryRender(organizationId, id);
    },
  );
}
