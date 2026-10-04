// apps/backend/src/modules/22-documents/routes/documents-typebox.ts — M22-T09 TypeBox route schemas (§4.2).
// Named `documents-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a
// TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's VALIDATION_FAILED
// envelope. Schemas mirror §4.2 (abbreviated where the spec spells out only the consequential routes).
// Optimistic concurrency / idempotency ride headers (NOT the body); the signed-URL request carries a
// `purpose` (the §164.528 access-purpose) + optional tighter TTL (clamped to the 300s floor server-side).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type { ExtractionReviewStatus } from "@wardenx/types";
import type { CursorPage as ServiceCursorPage } from "./concurrency";
import type {
  DocumentView as ServiceDocumentView,
  IntakeBatchView as ServiceIntakeBatchView,
  TagView as ServiceTagView,
  VersionView as ServiceVersionView,
} from "./service";
import type { MintedSignedUrl as ServiceMintedSignedUrl } from "./signed-url-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set("uri", (v) => typeof v === "string" && v.length > 0);
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// §3.2 vocab mirrors (string-literal unions; the canonical types live in @wardenx/types).
const RETENTION_CLASS = [
  "compliance",
  "clinical_record",
  "bereavement",
  "operational",
  "intake_artifact",
  "compliance_42cfr_part2",
] as const;
const ACCESS_PURPOSE = [
  "treatment",
  "payment",
  "operations",
  "disclosure",
  "patient_access",
  "amendment_review",
  "survey_export",
] as const;
const SOURCE_CHANNEL = ["fax", "email_ingest", "portal_upload", "admin_upload", "api"] as const;
const DOCUMENT_SOURCE_CHANNEL = [
  "email",
  "fax",
  "scanned_physical",
  "manual_upload",
  "portal",
  "api",
] as const;
const DECISION_KIND = ["approve", "approve_with_edit", "reject"] as const;
const DOCUMENT_AGGREGATE_TYPE = [
  "election_statement",
  "cti",
  "f2f",
  "nor",
  "revocation",
  "discharge_summary",
  "nomnc",
  "abn",
  "hipaa_privacy_notice",
  "code_status_directive",
  "encounter",
  "order_record",
  "medication_order",
  "medication_administration_record",
  "medication_reconciliation_worksheet",
  "patient_medication_list",
  "comfort_kit_receipt",
  "supply_bill_of_lading",
  "comfort_kit_return_receipt",
  "report_export",
  "report_schedule_run",
  "referral",
  "idg_patient_packet",
  "idg_minutes",
  "aide_poc",
  "msw_plan",
  "spiritual_plan",
  "volunteer_plan",
  "bereavement_letter",
  "visit_confirmation",
  "evv_verification",
  "patient_amendment_statement_of_disagreement",
  "consent_record",
  "notice_of_rights",
  "election_statement",
  "cti",
  "intake_source",
  "other",
] as const;
const VERIFIED_UPLOAD_MIME_TYPE = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export const DocumentSourceMetadataSchema = Type.Object({
  documentType: Type.Optional(lit(DOCUMENT_AGGREGATE_TYPE)),
  sourceChannel: Type.Optional(lit(DOCUMENT_SOURCE_CHANNEL)),
  receivedAt: Type.Optional(Type.String({ format: "date-time" })),
  originalFilename: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  externalMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  sender: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  faxReference: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  notes: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
});

// ── Path params (slice ids are uuid-shaped; cross-module ids validated per §4.2) ──────────────────────
export const DocumentParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const VersionParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  versionId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const TagParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  tagId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const BatchParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const JobParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const ReviewParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const DiscrepancyParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  discrepancyId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const TemplateParamsSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128 }),
});
export const TemplateVersionParamsSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128 }),
  versionId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const OverlayParamsSchema = Type.Object({
  templateKey: Type.String({ minLength: 1, maxLength: 128 }),
});
export const FormFillParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const VerifiedUploadParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
});

// ── Bodies ────────────────────────────────────────────────────────────────────────────────────────
export const UploadDocumentRequest = Type.Object({
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  admissionId: Type.Optional(Type.String({ format: "uuid" })),
  retentionClass: lit(RETENTION_CLASS),
  aggregateType: Type.String({ minLength: 1, maxLength: 64 }),
  aggregateId: Type.Optional(Type.String({ format: "uuid" })),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  tags: Type.Optional(
    Type.Array(
      Type.Object({
        tagKind: Type.Union([Type.Literal("free"), Type.Literal("structured")]),
        tagKey: Type.String({ minLength: 1, maxLength: 128 }),
        tagValue: Type.Optional(Type.String({ maxLength: 512 })),
      }),
      { maxItems: 50 },
    ),
  ),
  patientFacing: Type.Optional(Type.Boolean()),
});

export const UploadVersionRequest = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});

export const InitiateVerifiedUploadRequest = Type.Object({
  mode: Type.Union([Type.Literal("new_document"), Type.Literal("new_version")]),
  targetDocumentId: Type.Optional(Type.String({ format: "uuid" })),
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  admissionId: Type.Optional(Type.String({ format: "uuid" })),
  retentionClass: lit(RETENTION_CLASS),
  aggregateType: lit(DOCUMENT_AGGREGATE_TYPE),
  aggregateId: Type.Optional(Type.String({ format: "uuid" })),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  patientFacing: Type.Optional(Type.Boolean()),
  mimeType: lit(VERIFIED_UPLOAD_MIME_TYPE),
  byteSize: Type.Integer({ minimum: 1, maximum: 25 * 1024 * 1024 }),
  sha256Hex: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  sourceMetadata: Type.Optional(DocumentSourceMetadataSchema),
});

export const CompleteVerifiedUploadRequest = Type.Object({});
export const InitiateVerifiedUploadResponse = Type.Object({
  uploadId: Type.String({ format: "uuid" }),
  uploadUrl: Type.String({ format: "uri" }),
  requiredHeaders: Type.Record(Type.String(), Type.String()),
  expiresAt: Type.String({ format: "date-time" }),
});
export const CompleteVerifiedUploadResponse = Type.Object({
  documentId: Type.String({ format: "uuid" }),
  versionId: Type.String({ format: "uuid" }),
  versionNumber: Type.Integer({ minimum: 1 }),
});
export const AbortVerifiedUploadResponse = Type.Object({
  aborted: Type.Boolean(),
});

export const PatchDocumentRequest = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  patientFacing: Type.Optional(Type.Boolean()),
  attachToDisclosures: Type.Optional(Type.Boolean()),
});

export const LinkDocumentRequest = Type.Object({
  patientId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  admissionId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
});

export const AddTagRequest = Type.Object({
  tagKind: Type.Union([Type.Literal("free"), Type.Literal("structured")]),
  tagKey: Type.String({ minLength: 1, maxLength: 128 }),
  tagValue: Type.Optional(Type.String({ maxLength: 512 })),
});

export const ExportPhiBundleRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  purpose: lit(ACCESS_PURPOSE),
  recipientClass: Type.Optional(Type.String({ maxLength: 128 })),
});

// §4.2 — signed-URL request (the purpose is the §164.528 access-purpose; ttl clamps to the 300s floor).
export const SignedUrlRequest = Type.Object({
  purpose: lit(ACCESS_PURPOSE),
  recipientMembershipId: Type.Optional(Type.String({ format: "uuid" })),
  recipientClass: Type.Optional(Type.String({ maxLength: 128 })),
  ttlSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600 })),
});

// §4.2 — intake batch upload.
export const IntakeUploadRequest = Type.Object({
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  /** F-236 — the verified-uploaded source document (`POST /document-uploads` …/complete) this batch
   *  processes. Without it the batch has no file and an extraction run refuses (parse_failed). */
  documentId: Type.Optional(Type.String({ format: "uuid" })),
  sourceChannel: lit(SOURCE_CHANNEL),
  sourceMetadata: Type.Optional(Type.String({ maxLength: 2000 })),
});

export const ConfirmClassificationRequest = Type.Object({
  pageRanges: Type.Optional(
    Type.Array(
      Type.Object({
        fromPage: Type.Integer({ minimum: 1 }),
        toPage: Type.Integer({ minimum: 1 }),
        docType: Type.String({ minLength: 1, maxLength: 64 }),
      }),
      { maxItems: 200 },
    ),
  ),
});

export const OpenReviewRequest = Type.Object({});

// §4.2 — per-candidate decision.
export const RecordDecisionRequest = Type.Object({
  candidateId: Type.String({ format: "uuid" }),
  decision: lit(DECISION_KIND),
  editedValue: Type.Optional(Type.String({ maxLength: 4000 })),
  editedCode: Type.Optional(Type.String({ maxLength: 256 })),
  sourceViewConfirmed: Type.Literal(true),
  chartOverwriteConfirmed: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String({ minLength: 5, maxLength: 1000 })),
});

export const BulkApproveRequest = Type.Object({
  candidateIds: Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 200 }),
});

export const ResolveDiscrepancyRequest = Type.Object({
  resolutionValue: Type.Optional(Type.String({ maxLength: 4000 })),
  reason: Type.Optional(Type.String({ minLength: 5, maxLength: 1000 })),
});

export const CompleteReviewRequest = Type.Object({
  attestationConfirmed: Type.Literal(true),
});

export const AbandonReviewRequest = Type.Object({});

export const DiscardBatchRequest = Type.Object({
  reason: Type.String({ minLength: 5, maxLength: 1000 }),
});

export const PublishTemplateRequest = Type.Object({
  versionLabel: Type.String({ minLength: 1, maxLength: 64 }),
  payloadSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// §4.2 — tenant overlay publish (golden-template diff enforced server-side / D16).
export const PublishOverlayRequest = Type.Object({
  branding: Type.Object({
    letterhead: Type.Optional(
      Type.Object({
        logoUrl: Type.Optional(Type.String({ format: "uri" })),
        orgName: Type.String({ minLength: 1, maxLength: 200 }),
        addressLines: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 6 }),
        phone: Type.Optional(Type.String({ maxLength: 64 })),
        fax: Type.Optional(Type.String({ maxLength: 64 })),
      }),
    ),
    footerText: Type.Optional(Type.String({ maxLength: 1000 })),
    signatureBlockStyle: Type.Optional(
      Type.Union([Type.Literal("typed"), Type.Literal("cursive")]),
    ),
  }),
  stateAddendum: Type.Optional(
    Type.Object({
      stateCode: Type.String({ pattern: "^[A-Z]{2}$" }),
      addendumText: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
  ),
});

export const RetryRenderRequest = Type.Object({});

// ── Queries (cursor / keyset pagination — §4.1 SD-052) ────────────────────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

export const DocumentListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
  aggregateType: Type.Optional(Type.String({ maxLength: 64 })),
  aggregateId: Type.Optional(Type.String({ maxLength: 64 })),
  retentionClass: Type.Optional(Type.String({ maxLength: 64 })),
  // F-060 — find documents by tag, the query `document_tag_org_key_idx` was built for. `tagValue`
  // narrows within a key and is ignored without one (a value alone spans unrelated keys).
  tagKey: Type.Optional(Type.String({ maxLength: 128 })),
  tagValue: Type.Optional(Type.String({ maxLength: 512 })),
  ...PageQuery,
});

export const VersionListQuerySchema = Type.Object(PageQuery);
export const TagListQuerySchema = Type.Object(PageQuery);
export const ClassificationQuerySchema = Type.Object(PageQuery);
export const JobsListQuerySchema = Type.Object(PageQuery);
export const JobQuerySchema = Type.Object(PageQuery);
export const ReviewQuerySchema = Type.Object(PageQuery);
export const TemplateListQuerySchema = Type.Object(PageQuery);

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// These mirror the `service.ts` / `signed-url-service.ts` read views (DocumentView / VersionView /
// IntakeBatchView / MintedSignedUrl / CursorPage) so the generated client types the M22 read screens
// (DOC.Explorer / DOC.VersionHistory / INTAKE.BatchDetail / FORM.TemplateLibrary) instead of `never`. Each
// DTO is pinned to the real view by a compile-time `Conforms` alias below, so a view field added/renamed
// (or a wire-enum widened to a bare `string`) breaks `bun run build` rather than silently drifting from the
// client. Wire enums are published as literal unions (never `Type.String()`), matching the service unions.

/** §3.2 wire-enum mirrors used by the read DTOs (canonical unions live in @wardenx/types). */
const DOCUMENT_STATUS = ["active", "superseded", "legal_hold", "destroyed_tombstone"] as const;
const INTAKE_BATCH_STATUS = [
  "uploaded",
  "docling_complete",
  "classifier_complete",
  "extraction_complete",
  "in_review",
  "writeback_complete",
  "discarded",
  "split_into_children",
  "split_resolved_no_split",
  "parse_failed",
] as const;
const EXTRACTION_REVIEW_STATUS = ["in_progress", "complete", "abandoned"] as const;
/** §3.3 — `free` values may carry PHI (denylisted in the audit trigger); `structured` ones may not. */
const DOCUMENT_TAG_KIND = ["free", "structured"] as const;
const DOCUMENT_ACCESS_KIND = [
  "metadata_read",
  "content_download",
  "signed_url_issued",
  "signed_url_consumed",
  "portal_view",
  "disclosure_export",
] as const;

/** One PHI list page: `items` + the opaque `nextCursor`/`hasMore` envelope every list route returns. */
const CursorPageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });

export const DocumentViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  patientId: Type.Union([Type.String(), Type.Null()]),
  admissionId: Type.Union([Type.String(), Type.Null()]),
  retentionClass: lit(RETENTION_CLASS),
  aggregateType: Type.String(),
  aggregateId: Type.Union([Type.String(), Type.Null()]),
  title: Type.String(),
  patientFacing: Type.Boolean(),
  attachToDisclosures: Type.Boolean(),
  metadata: Type.Union([DocumentSourceMetadataSchema, Type.Null()]),
  status: lit(DOCUMENT_STATUS),
  version: Type.Integer(),
  versionsCount: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
export const DocumentListResponseSchema = CursorPageOf(DocumentViewSchema);

export const VersionViewSchema = Type.Object({
  id: Type.String(),
  documentId: Type.String(),
  versionNumber: Type.Integer(),
  mimeType: Type.String(),
  byteSize: Type.Integer(),
  uploadedAt: Type.String({ format: "date-time" }),
  createdAt: Type.String({ format: "date-time" }),
});
export const VersionListResponseSchema = CursorPageOf(VersionViewSchema);

/**
 * F-060 — the §3.3 tag DTO. `document_tag` was write-only: `POST /documents/:id/tags` returned the
 * created row on the wire and declared NO response schema, so `client:gen` typed it `never` and the
 * id `DELETE /documents/:id/tags/:tagId` needs was unreadable by any typed caller. Publishing the
 * shape is what makes the DELETE reachable and the tag survivable across a page load.
 */
export const TagViewSchema = Type.Object({
  id: Type.String(),
  tagKind: lit(DOCUMENT_TAG_KIND),
  tagKey: Type.String(),
  tagValue: Type.Union([Type.String(), Type.Null()]),
  addedAt: Type.String({ format: "date-time" }),
  createdAt: Type.String({ format: "date-time" }),
});
export const TagListResponseSchema = CursorPageOf(TagViewSchema);

export const IntakeBatchViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  patientId: Type.Union([Type.String(), Type.Null()]),
  status: lit(INTAKE_BATCH_STATUS),
  uploadedAt: Type.String({ format: "date-time" }),
  pages: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
});

/** Route 14 — classifier output page (`docType` is a free string on the read row). */
export const ClassificationListResponseSchema = CursorPageOf(
  Type.Object({
    id: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
    docType: Type.String(),
  }),
);

export const IntakeJobListResponseSchema = CursorPageOf(
  Type.Object({
    id: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
    status: Type.String(),
  }),
);

/** Route 17 — one job + its cursor-paginated extraction candidates (each with a risk tier). */
export const JobDetailResponseSchema = Type.Object({
  id: Type.String(),
  candidates: CursorPageOf(
    Type.Object({
      id: Type.String(),
      createdAt: Type.String({ format: "date-time" }),
      riskLevel: Type.String(),
    }),
  ),
});

/** Route 19 — review state: status + the cursor-paginated per-candidate decisions. */
export const ReviewDetailResponseSchema = Type.Object({
  id: Type.String(),
  status: lit(EXTRACTION_REVIEW_STATUS),
  decisions: CursorPageOf(
    Type.Object({ id: Type.String(), createdAt: Type.String({ format: "date-time" }) }),
  ),
});

/** Route 18 — the opened review session (F-237: published so the review screen can type it). */
export const OpenReviewResponseSchema = Type.Object({
  id: Type.String(),
  batchId: Type.String(),
  status: lit(EXTRACTION_REVIEW_STATUS),
  createdAt: Type.String({ format: "date-time" }),
});

/** Route 23 — completion + the F-235 writeback summary (ids, paths and reasons only — no values). */
export const CompleteReviewResponseSchema = Type.Object({
  reviewId: Type.String(),
  status: Type.Literal("complete"),
  writeback: Type.Optional(
    Type.Object({
      targetModule: Type.Union([Type.Literal("m5"), Type.Null()]),
      targetAggregateId: Type.Union([Type.String(), Type.Null()]),
      committedFieldPaths: Type.Array(Type.String()),
      excluded: Type.Array(
        Type.Object({
          candidateId: Type.String(),
          fieldPath: Type.String(),
          reason: Type.String(),
        }),
      ),
    }),
  ),
});

export const FormTemplateListResponseSchema = CursorPageOf(
  Type.Object({
    id: Type.String(),
    key: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
  }),
);

/** Route 27 — a template + its active version id. */
export const FormTemplateResponseSchema = Type.Object({
  key: Type.String(),
  activeVersionId: Type.String(),
});

/** Route 28 — a specific template version. */
export const FormTemplateVersionResponseSchema = Type.Object({
  key: Type.String(),
  versionId: Type.String(),
});

/** Route 30 — the org's published tenant overlays. */
export const TenantOverlayListResponseSchema = Type.Object({
  overlays: Type.Array(Type.Object({ templateKey: Type.String(), overlayId: Type.String() })),
});

/** Route 32 — a form-fill render record (platform-only debug). */
export const FormFillResponseSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
});

/** Route 5 — the minted short-lived signed URL (§4.12). */
export const SignedUrlResponseSchema = Type.Object({
  url: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
  documentVersionId: Type.String(),
  accessKind: lit(DOCUMENT_ACCESS_KIND),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _DocumentView = Conforms<Static<typeof DocumentViewSchema>, ServiceDocumentView>;
type _DocumentList = Conforms<
  Static<typeof DocumentListResponseSchema>,
  ServiceCursorPage<ServiceDocumentView>
>;
type _TagView = Conforms<Static<typeof TagViewSchema>, ServiceTagView>;
type _TagList = Conforms<Static<typeof TagListResponseSchema>, ServiceCursorPage<ServiceTagView>>;
type _VersionView = Conforms<Static<typeof VersionViewSchema>, ServiceVersionView>;
type _VersionList = Conforms<
  Static<typeof VersionListResponseSchema>,
  ServiceCursorPage<ServiceVersionView>
>;
type _IntakeBatchView = Conforms<Static<typeof IntakeBatchViewSchema>, ServiceIntakeBatchView>;
type _ClassificationList = Conforms<
  Static<typeof ClassificationListResponseSchema>,
  ServiceCursorPage<{ readonly id: string; readonly createdAt: string; readonly docType: string }>
>;
type _JobList = Conforms<
  Static<typeof IntakeJobListResponseSchema>,
  ServiceCursorPage<{ readonly id: string; readonly createdAt: string; readonly status: string }>
>;
type _JobDetail = Conforms<
  Static<typeof JobDetailResponseSchema>,
  {
    readonly id: string;
    readonly candidates: ServiceCursorPage<{
      readonly id: string;
      readonly createdAt: string;
      readonly riskLevel: string;
    }>;
  }
>;
type _ReviewDetail = Conforms<
  Static<typeof ReviewDetailResponseSchema>,
  {
    readonly id: string;
    readonly status: ExtractionReviewStatus;
    readonly decisions: ServiceCursorPage<{ readonly id: string; readonly createdAt: string }>;
  }
>;
type _TemplateList = Conforms<
  Static<typeof FormTemplateListResponseSchema>,
  ServiceCursorPage<{ readonly id: string; readonly key: string; readonly createdAt: string }>
>;
type _Template = Conforms<
  Static<typeof FormTemplateResponseSchema>,
  { readonly key: string; readonly activeVersionId: string }
>;
type _TemplateVersion = Conforms<
  Static<typeof FormTemplateVersionResponseSchema>,
  { readonly key: string; readonly versionId: string }
>;
type _TenantOverlayList = Conforms<
  Static<typeof TenantOverlayListResponseSchema>,
  { readonly overlays: { readonly templateKey: string; readonly overlayId: string }[] }
>;
type _FormFill = Conforms<
  Static<typeof FormFillResponseSchema>,
  { readonly id: string; readonly status: string }
>;
type _SignedUrl = Conforms<Static<typeof SignedUrlResponseSchema>, ServiceMintedSignedUrl>;

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
