// apps/backend/src/modules/22-documents/routes/documents-typebox.ts — M22-T07 TypeBox route schemas (§4.2).
// Named `*-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one, and so the OpenAPI route scanner skips it. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope (422). The §4.1 PHI list routes use opaque cursor pagination (`next_cursor` +
// `has_more`, SD-052): the query carries an opaque `cursor` + a clamped `limit` (default 50, max 200); the
// service encodes `(created_at DESC, id)` into the cursor. Response view shapes (the §5 screens' reads) are
// enriched into the OpenAPI contract with the screens in M22-T10.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const Uuid = Type.String({ format: "uuid" });

// ── §3.2 enum value sets (mirror the @wardenx/types unions) ───────────────────────────────────────────────
/** §2.3 retention classes a user-upload may declare (the SUD `compliance_42cfr_part2` class is set by the
 *  pipeline / consent capture, never by an upload body — D23). */
const RETENTION_CLASS = Type.Union([
  Type.Literal("compliance"),
  Type.Literal("clinical_record"),
  Type.Literal("bereavement"),
  Type.Literal("operational"),
  Type.Literal("intake_artifact"),
]);

const ACCESS_PURPOSE = Type.Union([
  Type.Literal("treatment"),
  Type.Literal("payment"),
  Type.Literal("operations"),
  Type.Literal("disclosure"),
  Type.Literal("patient_access"),
  Type.Literal("amendment_review"),
  Type.Literal("survey_export"),
]);

const TAG = Type.Object({
  tagKind: Type.Union([Type.Literal("free"), Type.Literal("structured")]),
  tagKey: Type.String({ minLength: 1, maxLength: 100 }),
  tagValue: Type.Optional(Type.String({ maxLength: 500 })),
});

// ── path params ───────────────────────────────────────────────────────────────────────────────────────────
export const IdParams = Type.Object({ id: Uuid });
export const VersionParams = Type.Object({ id: Uuid, versionId: Uuid });
export const TagParams = Type.Object({ id: Uuid, tagId: Uuid });
export const TemplateKeyParams = Type.Object({ key: Type.String({ minLength: 1, maxLength: 200 }) });
export const TemplateVersionParams = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 200 }),
  versionId: Uuid,
});

// ── §4.1 cursor pagination (opaque `next_cursor` + `has_more`, SD-052) ────────────────────────────────────
/** The shared list query — an opaque cursor + a clamped page size (default 50, max 200; offset is forbidden). */
export const CursorQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

/** `GET /documents` — the §4.1 list filtered by patient / aggregate_type / retention_class. */
export const DocumentListQuery = Type.Composite([
  CursorQuery,
  Type.Object({
    patientId: Type.Optional(Uuid),
    aggregateType: Type.Optional(Type.String({ maxLength: 100 })),
    retentionClass: Type.Optional(Type.String({ maxLength: 100 })),
  }),
]);

// ── request bodies ────────────────────────────────────────────────────────────────────────────────────────
/** `POST /documents` — upload new document (the multipart payload metadata; the binary is presigned separately). */
export const UploadDocumentRequest = Type.Object({
  patientId: Type.Optional(Uuid),
  admissionId: Type.Optional(Uuid),
  retentionClass: RETENTION_CLASS,
  aggregateType: Type.String({ minLength: 1, maxLength: 100 }),
  aggregateId: Type.Optional(Uuid),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  mimeType: Type.String({ minLength: 1, maxLength: 200 }),
  byteSize: Type.Integer({ minimum: 0 }),
  sha256Hex: Type.String({ minLength: 64, maxLength: 64 }),
  tags: Type.Optional(Type.Array(TAG, { maxItems: 50 })),
  patientFacing: Type.Optional(Type.Boolean({ default: false })),
});

/** `POST /documents/:id/versions` — upload a new version of an existing document. */
export const UploadVersionRequest = Type.Object({
  mimeType: Type.String({ minLength: 1, maxLength: 200 }),
  byteSize: Type.Integer({ minimum: 0 }),
  sha256Hex: Type.String({ minLength: 64, maxLength: 64 }),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});

/** `PATCH /documents/:id` — edit title / tags / patient_facing flag. */
export const EditDocumentRequest = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  patientFacing: Type.Optional(Type.Boolean()),
  attachToDisclosures: Type.Optional(Type.Boolean()),
});

/** `POST /documents/:id/tags` — add one tag. */
export const AddTagRequest = TAG;

/** `POST /documents/:id/versions/:versionId/content` query — mint a signed URL (TTL clamped at the service). */
export const SignedUrlQuery = Type.Object({
  purpose: ACCESS_PURPOSE,
  ttlSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600, default: 300 })),
});

/** `POST /documents/:id/export-phi-bundle` — §164.524 right-of-access bulk export (step-up; SEC-052 §8.9). */
export const ExportBundleRequest = Type.Object({
  purpose: ACCESS_PURPOSE,
  recipientClass: Type.Optional(Type.String({ maxLength: 100 })),
});

/** `POST /intake/uploads` — upload a new intake batch (the multi-page payload metadata). */
export const IntakeUploadRequest = Type.Object({
  patientId: Type.Optional(Uuid),
  pageCount: Type.Integer({ minimum: 1, maximum: 5000 }),
  sourceKind: Type.Union([Type.Literal("fax_ingest"), Type.Literal("user_upload"), Type.Literal("api_ingest")]),
});

/** `POST /intake/uploads/:id/classification/confirm` — human-confirm classifier results. */
export const ConfirmClassificationRequest = Type.Object({
  pageRanges: Type.Array(
    Type.Object({
      fromPage: Type.Integer({ minimum: 1 }),
      toPage: Type.Integer({ minimum: 1 }),
      docType: Type.String({ minLength: 1, maxLength: 100 }),
    }),
    { minItems: 1, maxItems: 500 },
  ),
});

/** `POST /intake/reviews/:id/decisions` — record one per-candidate decision (approve / edit / reject). */
export const ReviewDecisionRequest = Type.Object({
  candidateId: Uuid,
  decisionKind: Type.Union([
    Type.Literal("approve"),
    Type.Literal("approve_with_edit"),
    Type.Literal("reject"),
  ]),
  editedValue: Type.Optional(Type.String({ maxLength: 4000 })),
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

/** `PUT /tenant-overlays/:templateKey` — publish a tenant overlay (golden-template diff enforced; step-up). */
export const PublishOverlayRequest = Type.Object({
  branding: Type.Optional(Type.String({ maxLength: 4000 })),
  stateAddendum: Type.Optional(Type.String({ maxLength: 8000 })),
});

/** `POST /admin/form-templates/:key/versions` — publish a new platform template version (platform-only). */
export const PublishTemplateVersionRequest = Type.Object({
  versionLabel: Type.String({ minLength: 1, maxLength: 100 }),
  payloadSchema: Type.String({ minLength: 1 }),
  renderEngine: Type.Union([Type.Literal("react_pdf"), Type.Literal("puppeteer")]),
});

// ── §5.1 response view shapes (the screens' reads; enriched into the OpenAPI contract in M22-T10) ────────────
// Mirror the {@link DocumentView} / {@link DocumentVersionView} / … service shapes so the generated client types
// the M22-T10 read screens. Enum-valued fields use the full §3.2 unions (incl. the SUD `compliance_42cfr_part2`
// class, which an upload body may NOT set but a rendered/consent-captured document CAN carry — D23).
const RETENTION_CLASS_VIEW = Type.Union([
  Type.Literal("compliance"),
  Type.Literal("clinical_record"),
  Type.Literal("bereavement"),
  Type.Literal("operational"),
  Type.Literal("intake_artifact"),
  Type.Literal("compliance_42cfr_part2"),
]);

const TagView = Type.Object({
  id: Uuid,
  tagKind: Type.Union([Type.Literal("free"), Type.Literal("structured")]),
  tagKey: Type.String(),
  tagValue: Type.Union([Type.String(), Type.Null()]),
});

const DocumentVersionView = Type.Object({
  id: Uuid,
  versionNumber: Type.Integer(),
  mimeType: Type.String(),
  byteSize: Type.Integer(),
  sha256Hex: Type.String(),
  uploadedByKind: Type.String(),
  uploadedAt: Type.String({ format: "date-time" }),
});

/** `GET /documents/:id` + each row of `GET /documents` — document metadata + active version + tags. */
export const DocumentView = Type.Object({
  id: Uuid,
  organizationId: Uuid,
  patientId: Type.Union([Uuid, Type.Null()]),
  admissionId: Type.Union([Uuid, Type.Null()]),
  retentionClass: RETENTION_CLASS_VIEW,
  sourceKind: Type.String(),
  aggregateType: Type.String(),
  aggregateId: Type.Union([Uuid, Type.Null()]),
  title: Type.String(),
  patientFacing: Type.Boolean(),
  attachToDisclosures: Type.Boolean(),
  status: Type.String(),
  activeVersion: Type.Union([DocumentVersionView, Type.Null()]),
  versionsCount: Type.Integer(),
  tags: Type.Array(TagView),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});

/** `GET /documents` — the opaque-cursor page (SD-052: `items` + `nextCursor` + `hasMore`). */
export const DocumentListResponse = Type.Object({
  items: Type.Array(DocumentView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});

/** `GET /documents/:id/versions` — the full version ledger (newest first). */
export const DocumentVersionListResponse = Type.Array(DocumentVersionView);

/** `GET /documents/:id/versions/:versionId/content` — the minted §164.528 short-TTL signed-URL grant. */
export const SignedUrlView = Type.Object({
  url: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
  accessKind: Type.String(),
});

/** `GET /intake/uploads/:id` — intake batch metadata + pipeline status (DocLens-gated; typed for the contract). */
export const IntakeBatchView = Type.Object({
  id: Uuid,
  organizationId: Uuid,
  patientId: Type.Union([Uuid, Type.Null()]),
  status: Type.String(),
  pageCount: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
});

/** `GET /intake/reviews/:id` — review state (candidate count + decisions-so-far; DocLens-gated). */
export const ReviewView = Type.Object({
  id: Uuid,
  intakeBatchId: Uuid,
  status: Type.String(),
  reviewerMembershipId: Uuid,
  decisionsCount: Type.Integer(),
});

/** `GET /extraction/provenance` — the committed-extraction provenance trail for a chart row. */
export const ProvenanceListResponse = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Uuid,
      targetModule: Type.String(),
      targetAggregateId: Type.Union([Uuid, Type.Null()]),
      targetFieldPath: Type.String(),
      sourceDocumentId: Uuid,
      decisionKind: Type.String(),
      committedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    }),
  ),
});

export type UploadDocumentBody = Static<typeof UploadDocumentRequest>;
export type EditDocumentBody = Static<typeof EditDocumentRequest>;

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
