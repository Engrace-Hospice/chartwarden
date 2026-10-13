// apps/backend/src/modules/34-saas-tenant-platform/routes/typebox.ts — M34 shared TypeBox route schemas
// (§4.2). Named `typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one (the M22 `documents-typebox.ts` precedent). Every other M34 route file
// (routes/platform/*, routes/tenant/*, routes/public/*) imports its request/response DTOs from HERE so the
// HTTP contract is defined once and never drifts from the validators. Validation runs through TypeBox
// `Value` → M1's VALIDATION_FAILED envelope. Schemas mirror §4.1–4.2 (the consequential route bodies the
// spec spells out; representative where it abbreviates). Org binding is server-side (`request.context` /
// `withOrgContext` / `withPlatformContext`), NEVER the body — no schema below carries an `organizationId`.
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
if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set("email", (v) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// ── §3 vocab mirrors (string-literal unions; the canonical enums live in @wardenx/db / @wardenx/types) ──

/** The eleven-state tenant lifecycle (§2.2). `signup_intent`/`destroyed` are never targetable via the
 *  status route (signup_intent is the genesis state; destroyed is reached only by the shred worker). */
export const TENANT_STATUS = [
  "signup_intent",
  "provisioning",
  "onboarding",
  "active",
  "suspended",
  "at_risk",
  "offboarding_initiated",
  "final_export_pending",
  "retained",
  "destruction_pending",
  "destroyed",
] as const;

/** Statuses the §4.2 `StatusTransitionRequest` permits as `toStatus` (`destroyed` excluded). */
export const TENANT_STATUS_TRANSITIONABLE = [
  "provisioning",
  "onboarding",
  "active",
  "suspended",
  "at_risk",
  "offboarding_initiated",
  "final_export_pending",
  "retained",
  "destruction_pending",
] as const;

export const SIGNUP_INTENT_STATUS = [
  "new",
  "qualified",
  "provisioned",
  "abandoned",
  "rejected",
] as const;
export const SIGNUP_INTENT_SOURCE = [
  "self_serve_form",
  "platform_ops_manual",
  "partner_referral",
] as const;
export const SUPPORT_GRANT_SCOPE = ["organization_scoped", "patient_scoped"] as const;
export const DSAR_REQUEST_SOURCE = [
  "patient",
  "caregiver",
  "legal_representative",
  "authorized_third_party",
] as const;
export const QUALIFY_DECISION = ["qualified", "rejected"] as const;

// ── Path params ──────────────────────────────────────────────────────────────────────────────────────
export const OrgIdParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const TenantTaskParamsSchema = Type.Object({
  orgId: Type.String({ minLength: 1, maxLength: 64 }),
  taskId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const IdParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const TaskIdParamsSchema = Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const FlagKeyParamsSchema = Type.Object({
  flagKey: Type.String({ minLength: 1, maxLength: 128 }),
});
/** Raw single-use credential; the service hashes it before lookup. A stored hash is never a bearer token. */
export const TokenHashParamsSchema = Type.Object({
  tokenHash: Type.String({ minLength: 32, maxLength: 128, pattern: "^[0-9A-Za-z_-]{32,128}$" }),
});

// ── Public signup-intent bodies (§3.11 / §7.1 Phase-3; routes/public/signup-intents.ts) ─────────────────

// POST /api/v1/public/signup-intents — the pre-organization self-serve intake. No session, no org; the
// body carries only the prospect's contact + business identity. `source` is server-pinned to
// `self_serve_form` for the public route (the body cannot widen it to a platform/partner origin).
export const PublicSignupIntentRequest = Type.Object({
  contactEmail: Type.String({ format: "email", minLength: 3, maxLength: 320 }),
  legalBusinessName: Type.String({ minLength: 2, maxLength: 500 }),
  intendedFirstAdminEmail: Type.String({ format: "email", minLength: 3, maxLength: 320 }),
});

// POST /api/v1/public/signup-intents/:tokenHash/verify-email — single-use email-verification consumption.
// verify-email carries NO request body: the token in the path IS the credential. The empty-object
// parse it used to perform validated nothing and published a request body clients cannot omit (#94).

// POST /api/v1/public/tenant-invitations/:tokenHash/accept — first-admin invitation acceptance.
export const AcceptInvitationRequest = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

// ── Platform-ops bodies (§4.2; routes/platform/*) ──────────────────────────────────────────────────────

// POST /api/v1/platform/tenants — provision from a signup_intent OR raw input.
export const ProvisionTenantRequest = Type.Object({
  signupIntentId: Type.Optional(Type.String({ format: "uuid" })),
  legalBusinessName: Type.String({ minLength: 2, maxLength: 500 }),
  billingContactEmail: Type.String({ format: "email", minLength: 3, maxLength: 320 }),
  breachNotificationContactEmail: Type.String({ format: "email", minLength: 3, maxLength: 320 }),
  intendedFirstAdminEmail: Type.String({ format: "email", minLength: 3, maxLength: 320 }),
  planLabel: Type.String({ minLength: 1, maxLength: 128 }),
});

// POST /api/v1/platform/tenants/:orgId/status — the §4.2 StatusTransitionRequest (verbatim shape).
export const StatusTransitionRequest = Type.Object({
  toStatus: lit(TENANT_STATUS_TRANSITIONABLE),
  transitionReason: Type.String({ minLength: 8, maxLength: 1000 }),
  sideEffectAcknowledgments: Type.Optional(
    Type.Object({
      sessionRevocationCascade: Type.Optional(Type.Boolean()),
      subscriptionCancellationScheduled: Type.Optional(Type.Boolean()),
    }),
  ),
});

// POST /api/v1/platform/tenants/:orgId/offboard.
export const OffboardTenantRequest = Type.Object({
  offboardReason: Type.String({ minLength: 8, maxLength: 1000 }),
});

// POST /api/v1/platform/tenants/:orgId/shred — only valid with an approved M4 destruction cert.
export const ShredTenantRequest = Type.Object({
  destructionCertificateId: Type.String({ format: "uuid" }),
});

// POST /api/v1/platform/tenants/:orgId/dek-rotate.
export const DekRotateRequest = Type.Object({
  rotationReason: Type.Optional(Type.String({ maxLength: 1000 })),
});

// POST /api/v1/platform/tenants/:orgId/onboarding/:taskId/skip.
export const SkipOnboardingTaskRequest = Type.Object({
  skipRationale: Type.String({ minLength: 8, maxLength: 2000 }),
});

// POST /api/v1/platform/tenant-invitations.
export const IssueTenantInvitationRequest = Type.Object({
  organizationId: Type.Optional(Type.String({ format: "uuid" })),
  inviteeEmail: Type.String({ format: "email", minLength: 3, maxLength: 320 }),
});

// POST /api/v1/platform/onboarding-templates — non-canonical only (canonical=true is migration-only).
export const WriteOnboardingTemplateRequest = Type.Object({
  templateKey: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  sequenceOrder: Type.Integer({ minimum: 0, maximum: 10000 }),
});

// POST /api/v1/platform/support-sessions — references a consent grant; opens a session.
export const StartSupportSessionRequest = Type.Object({
  supportConsentGrantId: Type.String({ format: "uuid" }),
  sessionReason: Type.String({ minLength: 8, maxLength: 2000 }),
});
export const ElevateSupportSessionRequest = Type.Object({
  elevationReason: Type.String({ minLength: 8, maxLength: 2000 }),
});
export const CloseSupportSessionRequest = Type.Object({});

// POST /api/v1/platform/feature-flags — create/update a flag (calls M1 FeatureFlagAdmin.upsert).
export const UpsertFeatureFlagRequest = Type.Object({
  flagKey: Type.String({ minLength: 1, maxLength: 128 }),
  organizationId: Type.Optional(Type.String({ format: "uuid" })),
  enabled: Type.Boolean(),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const KillSwitchRequest = Type.Object({
  killSwitchActive: Type.Boolean(),
  reason: Type.String({ minLength: 8, maxLength: 1000 }),
});

// POST /api/v1/platform/signup-intents/:id/qualify — promote to qualified or rejected.
export const QualifySignupIntentRequest = Type.Object({
  decision: lit(QUALIFY_DECISION),
  rejectionReason: Type.Optional(Type.String({ minLength: 5, maxLength: 2000 })),
});

// POST /api/v1/platform/tenant-export-jobs/:id/approve-oversized — SEC-052 second-actor approval.
export const ApproveOversizedExportRequest = Type.Object({
  approvalReason: Type.String({ minLength: 8, maxLength: 2000 }),
});

// ── Tenant-scoped bodies (§4.2; routes/tenant/*) ───────────────────────────────────────────────────────

export const OnboardingActionRequest = Type.Object({
  evidence: Type.Optional(Type.String({ maxLength: 4000 })),
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

// POST /api/v1/tenant/support-consent-grants — the §4.2 SupportConsentGrantRequest (verbatim shape).
export const SupportConsentGrantRequest = Type.Object({
  scope: lit(SUPPORT_GRANT_SCOPE),
  patientIdsInScope: Type.Optional(
    Type.Array(Type.String({ format: "uuid" }), { minItems: 1, maxItems: 50 }),
  ),
  grantReason: Type.String({ minLength: 20, maxLength: 2000 }),
  expiresAtIsoOffsetHours: Type.Number({ minimum: 0.5, maximum: 72 }),
});
export const RevokeSupportConsentGrantRequest = Type.Object({
  revocationReason: Type.Optional(Type.String({ maxLength: 2000 })),
});

// POST /api/v1/tenant/dsar-export-jobs — the §4.2 DsarExportRequest (verbatim shape).
export const DsarExportRequest = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  requestSource: lit(DSAR_REQUEST_SOURCE),
  requestorIdentityVerificationEvidence: Type.String({ minLength: 20, maxLength: 5000 }),
  idempotencyKey: Type.Optional(Type.String({ maxLength: 256 })),
});
export const DsarFulfillRequest = Type.Object({});
export const DsarExtendRequest = Type.Object({
  extensionReason: Type.String({ minLength: 8, maxLength: 2000 }),
});
export const DsarDenyRequest = Type.Object({
  denialReason: Type.String({ minLength: 8, maxLength: 2000 }),
});

// POST /api/v1/tenant/tenant-export-jobs.
export const TenantExportRequest = Type.Object({
  exportReason: Type.Union([
    Type.Literal("migration"),
    Type.Literal("baa_termination"),
    Type.Literal("compliance_request"),
    Type.Literal("other"),
  ]),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

// POST /api/v1/tenant/baa/:id/attest.
export const BaaAttestRequest = Type.Object({
  attestationNote: Type.Optional(Type.String({ maxLength: 2000 })),
});

// POST /api/v1/tenant/feature-flags/:flagKey — tenant-toggleable flag write.
export const TenantFlagWriteRequest = Type.Object({
  enabled: Type.Boolean(),
});

// ── Queries (cursor / keyset pagination — §4.1 SD-052) ─────────────────────────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

export const TenantListQuerySchema = Type.Object({
  status: Type.Optional(lit(TENANT_STATUS)),
  planLabel: Type.Optional(Type.String({ maxLength: 128 })),
  createdAfter: Type.Optional(Type.String({ format: "date-time" })),
  search: Type.Optional(Type.String({ maxLength: 256 })),
  ...PageQuery,
});
export const SignupIntentListQuerySchema = Type.Object({
  status: Type.Optional(lit(SIGNUP_INTENT_STATUS)),
  ...PageQuery,
});
export const InvitationListQuerySchema = Type.Object(PageQuery);
export const SupportSessionListQuerySchema = Type.Object(PageQuery);
export const DsarJobListQuerySchema = Type.Object(PageQuery);
export const TenantExportJobListQuerySchema = Type.Object(PageQuery);
export const TemplateListQuerySchema = Type.Object(PageQuery);
export const PlainPageQuerySchema = Type.Object(PageQuery);

// ── Response views (read surfaces — the Phase-3 screens consume these) ─────────────────────────────────
// Mirror the repo/service DTO shapes so the generated client types the M34 read screens (the
// SaaS/Platform-ops console + the tenant admin onboarding/DSAR/BAA surfaces). Enriching only the READ
// responses keeps the contract from drifting from the validators (the M22/M5/M6 precedent).

/** One list page: `items` + the opaque `nextCursor`/`hasMore` envelope every list route returns. */
export const CursorPageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });

export const SignupIntentViewSchema = Type.Object({
  id: Type.String(),
  contactEmail: Type.String(),
  legalBusinessName: Type.String(),
  intendedFirstAdminEmail: Type.String(),
  intentStatus: lit(SIGNUP_INTENT_STATUS),
  source: lit(SIGNUP_INTENT_SOURCE),
  rejectionReason: Type.Union([Type.String(), Type.Null()]),
  tenantAccountId: Type.Union([Type.String(), Type.Null()]),
  receivedAt: Type.String({ format: "date-time" }),
  processedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export const SignupIntentListResponseSchema = CursorPageOf(SignupIntentViewSchema);

/** The public POST response: an opaque acknowledgement (never leaks the raw token or the intent id back
 *  to an unauthenticated caller beyond what's needed to drive the email-verification step). */
export const PublicSignupIntentAckSchema = Type.Object({
  signupIntentId: Type.String(),
  status: Type.Literal("new"),
});

export const TenantAccountViewSchema = Type.Object({
  organizationId: Type.String(),
  tenantAccountId: Type.String(),
  legalBusinessName: Type.String(),
  status: lit(TENANT_STATUS),
  planLabel: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
export const TenantListResponseSchema = CursorPageOf(TenantAccountViewSchema);

/** POST /public/signup-intents/:tokenHash/verify-email → single-use token consumed. */
export const VerifyEmailAckSchema = Type.Object({ verified: Type.Literal(true) });
/** POST /public/tenant-invitations/:tokenHash/accept → first-admin acceptance completed. */
/** `email` is the invited address (the token holder is that invitee) — the web page mails the password-reset link to it. */
export const AcceptInvitationAckSchema = Type.Object({
  accepted: Type.Literal(true),
  email: Type.String({ format: "email" }),
});

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
