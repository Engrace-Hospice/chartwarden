// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/tenant-typebox.ts — M34 (§4.2).
//
// TypeBox request/response schemas for the TENANT-scoped route surface (§4.1 "Tenant-scoped routes"):
// support-consent grants, DSAR export jobs (the §164.524 patient-access surface), tenant export jobs,
// onboarding task advance, and the tenant's BAA view. Named `tenant-typebox` (NOT `*schema*`) so the
// table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one (the M22 precedent).
// Validation runs through TypeBox `Value` → M1's VALIDATION_FAILED envelope. Step-up / idempotency ride
// HEADERS (never the body); the §6/D10 step-up table is enforced by `requireStepUp` pre-handlers in the
// route plugins, not by these body schemas. Read responses mirror the `service.ts` view DTOs so the
// generated client types the Phase-3 tenant screens (the M22 read-surface enrichment pattern).
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type {
  BaaRecordView as ServiceBaaRecordView,
  DownloadUrlView as ServiceDownloadUrlView,
  DsarExportJobView as ServiceDsarExportJobView,
  OnboardingTaskView as ServiceOnboardingTaskView,
  SupportConsentGrantView as ServiceSupportConsentGrantView,
  TenantExportJobView as ServiceTenantExportJobView,
} from "./service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// §3 vocab mirrors (string-literal unions; the canonical pgEnum types live in @wardenx/db).
const SUPPORT_GRANT_SCOPE = ["organization_scoped", "patient_scoped"] as const;
const DSAR_REQUEST_SOURCE = [
  "patient",
  "caregiver",
  "legal_representative",
  "authorized_third_party",
] as const;
const DSAR_STATUS = [
  "requested",
  "generating",
  "review_pending",
  "fulfilled",
  "denied",
  "extended",
] as const;
const TENANT_EXPORT_PURPOSE = [
  "migration",
  "baa_termination",
  "compliance_audit",
  "surveyor_request",
] as const;
const TENANT_EXPORT_STATUS = [
  "requested",
  "generating",
  "fulfilled",
  "expired",
  "cancelled",
] as const;
const ONBOARDING_STATUS = ["pending", "in_progress", "done", "skipped", "blocked"] as const;
const BAA_STATUS = ["executed", "pending", "terminated", "missing"] as const;
const DSAR_DENIAL_REASON = [
  "psychotherapy_notes",
  "legal_proceeding",
  "endangerment",
  "research_in_progress",
  "denied_by_authorized_party",
  "other_permitted",
] as const;

// ── Path params ───────────────────────────────────────────────────────────────────────────────────
export const GrantParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const DsarJobParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const TenantExportJobParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const OnboardingTaskParamsSchema = Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const BaaParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});

// ── Bodies ────────────────────────────────────────────────────────────────────────────────────────

// §4.2 — support consent grant (tenant compliance_officer; ≤72h expiry, platform-floor clamped).
export const SupportConsentGrantRequest = Type.Object({
  scope: lit(SUPPORT_GRANT_SCOPE),
  patientIdsInScope: Type.Optional(
    Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 50 }),
  ),
  grantReason: Type.String({ minLength: 20, maxLength: 2000 }),
  expiresAtIsoOffsetHours: Type.Number({ minimum: 0.5, maximum: 72 }),
});

export const RevokeConsentGrantRequest = Type.Object({
  revocationReason: Type.String({ minLength: 5, maxLength: 1000 }),
});

// §4.2 — DSAR export request (patient-scoped; identity-verification evidence captured per §164.524).
export const DsarExportRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  requestSource: lit(DSAR_REQUEST_SOURCE),
  requestorIdentityVerificationEvidence: Type.String({ minLength: 20, maxLength: 5000 }),
  idempotencyKey: Type.Optional(Type.String({ maxLength: 256 })),
});

export const DsarFulfillRequest = Type.Object({});

export const DsarExtendRequest = Type.Object({
  reason: Type.Optional(Type.String({ minLength: 5, maxLength: 1000 })),
});

export const DsarDenyRequest = Type.Object({
  deniedReason: lit(DSAR_DENIAL_REASON),
  narrative: Type.String({ minLength: 10, maxLength: 2000 }),
});

// §4.2 — tenant export request (org-scoped NDJSON archive; SEC-052 justification captured).
export const TenantExportRequest = Type.Object({
  requestedPurpose: lit(TENANT_EXPORT_PURPOSE),
  justification: Type.String({ minLength: 20, maxLength: 2000 }),
});

// §4.1 — onboarding task advance bodies (start / complete-with-evidence / block-with-reason).
export const OnboardingStartRequest = Type.Object({});

export const OnboardingCompleteRequest = Type.Object({
  completionEvidence: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const OnboardingBlockRequest = Type.Object({
  blockerReason: Type.String({ minLength: 5, maxLength: 1000 }),
});

// §4.2 — compliance-officer BAA attestation.
export const BaaAttestRequest = Type.Object({
  attestationConfirmed: Type.Literal(true),
});

// ── Queries (cursor / keyset pagination — §4.1 SD-052) ────────────────────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

export const GrantListQuerySchema = Type.Object(PageQuery);
export const DsarListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(lit(DSAR_STATUS)),
  ...PageQuery,
});
export const TenantExportListQuerySchema = Type.Object({
  status: Type.Optional(lit(TENANT_EXPORT_STATUS)),
  ...PageQuery,
});
export const OnboardingListQuerySchema = Type.Object(PageQuery);
export const BaaListQuerySchema = Type.Object(PageQuery);

// ── Response views (read surfaces — Phase-3 tenant screens) ───────────────────────────────────────
// Mirror the `service.ts` DTOs so the generated typed client types the M34 tenant read screens
// (the §164.524 DSAR queue, the tenant-export queue, the onboarding checklist, the BAA history).

/** One list page: `items` + the opaque `nextCursor`/`hasMore` envelope every list route returns. */
const CursorPageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });

export const SupportConsentGrantViewSchema = Type.Object({
  id: Type.String(),
  tenantAccountId: Type.String(),
  scope: lit(SUPPORT_GRANT_SCOPE),
  grantReason: Type.String(),
  issuedAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
  revokedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  active: Type.Boolean(),
  createdAt: Type.String({ format: "date-time" }),
});
export const SupportConsentGrantListResponseSchema = CursorPageOf(SupportConsentGrantViewSchema);

export const DsarExportJobViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  requestSource: lit(DSAR_REQUEST_SOURCE),
  status: lit(DSAR_STATUS),
  requestedAt: Type.String({ format: "date-time" }),
  slaDueAt: Type.String({ format: "date-time" }),
  extendedUntil: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  fulfilledAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  deniedReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
});
export const DsarExportJobListResponseSchema = CursorPageOf(DsarExportJobViewSchema);

export const TenantExportJobViewSchema = Type.Object({
  id: Type.String(),
  requestedPurpose: lit(TENANT_EXPORT_PURPOSE),
  status: lit(TENANT_EXPORT_STATUS),
  requestedAt: Type.String({ format: "date-time" }),
  fulfilledAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  bundleSizeBytes: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
});
export const TenantExportJobListResponseSchema = CursorPageOf(TenantExportJobViewSchema);

export const OnboardingTaskViewSchema = Type.Object({
  id: Type.String(),
  templateKey: Type.String(),
  status: lit(ONBOARDING_STATUS),
  assignedToMembershipId: Type.Union([Type.String(), Type.Null()]),
  dueAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  startedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  completedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  blockerReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
});
export const OnboardingTaskListResponseSchema = CursorPageOf(OnboardingTaskViewSchema);

export const BaaRecordViewSchema = Type.Object({
  id: Type.String(),
  tenantAccountId: Type.String(),
  addendumVersion: Type.String(),
  baaStatus: lit(BAA_STATUS),
  executedOn: Type.Union([Type.String(), Type.Null()]),
  effectiveOn: Type.Union([Type.String(), Type.Null()]),
  expiresOn: Type.Union([Type.String(), Type.Null()]),
  attestedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
});
export const BaaRecordListResponseSchema = CursorPageOf(BaaRecordViewSchema);

/** §4.1 — a 24h presigned download URL (SEC-052); returned by the DSAR + tenant-export download routes. */
export const DownloadUrlViewSchema = Type.Object({
  url: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
});

// Compile-time pins: each response DTO structurally conforms to its `service.ts` view (drift = a type error).
type Conforms<T extends V, V> = T;
type _Grant = Conforms<
  Static<typeof SupportConsentGrantViewSchema>,
  ServiceSupportConsentGrantView
>;
type _Dsar = Conforms<Static<typeof DsarExportJobViewSchema>, ServiceDsarExportJobView>;
type _TenantExport = Conforms<Static<typeof TenantExportJobViewSchema>, ServiceTenantExportJobView>;
type _Onboarding = Conforms<Static<typeof OnboardingTaskViewSchema>, ServiceOnboardingTaskView>;
type _Baa = Conforms<Static<typeof BaaRecordViewSchema>, ServiceBaaRecordView>;
type _Download = Conforms<Static<typeof DownloadUrlViewSchema>, ServiceDownloadUrlView>;

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
