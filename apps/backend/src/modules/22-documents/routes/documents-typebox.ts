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
const SOURCE_CHANNEL = [
  "fax",
  "email_ingest",
  "portal_upload",
  "admin_upload",
  "api",
] as const;
const DECISION_KIND = ["approve", "approve_with_edit", "reject"] as const;

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

export const PatchDocumentRequest = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  patientFacing: Type.Optional(Type.Boolean()),
  attachToDisclosures: Type.Optional(Type.Boolean()),
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
  retentionClass: Type.Optional(Type.String({ maxLength: 64 })),
  ...PageQuery,
});

export const VersionListQuerySchema = Type.Object(PageQuery);
export const ClassificationQuerySchema = Type.Object(PageQuery);
export const JobsListQuerySchema = Type.Object(PageQuery);
export const JobQuerySchema = Type.Object(PageQuery);
export const ReviewQuerySchema = Type.Object(PageQuery);
export const TemplateListQuerySchema = Type.Object(PageQuery);

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
