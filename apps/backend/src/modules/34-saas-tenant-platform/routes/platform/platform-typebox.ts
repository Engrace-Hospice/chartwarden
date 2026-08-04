// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/platform-typebox.ts — M34 (§4.2).
//
// TypeBox request/response schemas for the platform-ops tenant-lifecycle route surface (§4.1 platform-ops
// table + §4.2 per-route specs). Named `platform-typebox` (NOT `*schema*`) so the table-ownership import
// heuristic never mistakes a TypeBox import for a Drizzle one (the M22 `documents-typebox` precedent).
// Validation runs through TypeBox `Value` → M1's VALIDATION_FAILED envelope (the same `parse(...)` the M22
// routes use). Org/actor binding is ALWAYS server-side (request.context); the body never carries an org id.
//
// The lifecycle-command bodies mirror §4.2: the status transition carries the eight legal `toStatus`
// literals (`destroyed` is NEVER permitted via the route — only the shred worker) + a non-empty
// `transitionReason`; provision/offboard/shred/dek-rotate carry the §4.2 inputs the worker job consumes.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import type {
  BaaRecordView as ServiceBaaRecordView,
  FeatureFlagView as ServiceFeatureFlagView,
  KeyRingMetadataView as ServiceKeyRingMetadataView,
  OnboardingTemplateView as ServiceOnboardingTemplateView,
  SignupIntentView as ServiceSignupIntentView,
  SupportSessionEventView as ServiceSupportSessionEventView,
  SupportSessionView as ServiceSupportSessionView,
  TenantInvitationView as ServiceTenantInvitationView,
  TenantOverview as ServiceTenantOverview,
  TenantSummaryView as ServiceTenantSummaryView,
} from "./service";

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

// §3.3 vocab mirrors (string-literal unions; the canonical types live in the seam / @wardenx/types).
// 'destroyed' is intentionally absent from the route-settable set (§4.2 — only the shred worker reaches it).
const SETTABLE_STATUS = [
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

const PLAN_LABEL = ["starter", "standard", "enterprise"] as const;
const EXPORT_PURPOSE = ["baa_termination", "migration"] as const;

// §3.6/§3.8/§3.9 + M1 feature_flag vocab mirrors (the canonical enums live in @wardenx/db; M34 never
// imports the M1 flag schema — these literal unions are local mirrors so no flag-schema edge is created).
const SUPPORT_SESSION_STATUS = ["open", "expired", "closed"] as const;
const SIGNUP_INTENT_STATUS = ["new", "qualified", "provisioned", "abandoned", "rejected"] as const;
const SIGNUP_INTENT_SOURCE = [
  "self_serve_form",
  "platform_ops_manual",
  "partner_referral",
] as const;
const BAA_STATUS = ["executed", "pending", "terminated", "missing"] as const;
const FLAG_KIND = ["product", "rollout", "kill_switch", "migration"] as const;
const FLAG_VALUE_TYPE = ["boolean", "string", "number", "json"] as const;
const ISO_DATE = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

// ── path params ──────────────────────────────────────────────────────────────────────────────────────
// The §4.1 platform routes key tenants by `:orgSlug` (the org's human slug; resolved to tenant_account
// server-side). Invitation/template routes key by uuid id / template key.
export const OrgSlugParamsSchema = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
});
export const InvitationParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
});
export const TemplateKeyParamsSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128 }),
});
// §4.1 — support-session / signup-intent / BAA routes key by uuid id; feature-flags by flag key.
export const SessionParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
});
export const IntentParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
});
export const BaaParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
});
export const FeatureFlagParamsSchema = Type.Object({
  flagKey: Type.String({ minLength: 1, maxLength: 128 }),
});

// ── bodies ─────────────────────────────────────────────────────────────────────────────────────────

// §4.2 — POST /platform/tenants (provision from a signup_intent OR raw input). Enqueues `tenant.provision`.
export const ProvisionTenantRequest = Type.Object({
  signupIntentId: Type.Optional(Type.String({ format: "uuid" })),
  legalBusinessName: Type.String({ minLength: 2, maxLength: 300 }),
  billingContactEmail: Type.String({ format: "email" }),
  breachNotificationContactEmail: Type.String({ format: "email" }),
  firstAdminEmail: Type.String({ format: "email" }),
  planLabel: lit(PLAN_LABEL),
});

// §4.2 — POST /platform/tenants/:orgSlug/status. The eleven-state machine guards apply server-side.
export const StatusTransitionRequest = Type.Object({
  toStatus: lit(SETTABLE_STATUS),
  transitionReason: Type.String({ minLength: 8, maxLength: 1000 }),
  sideEffectAcknowledgments: Type.Optional(
    Type.Object({
      sessionRevocationCascade: Type.Optional(Type.Boolean()),
      subscriptionCancellationScheduled: Type.Optional(Type.Boolean()),
    }),
  ),
});

// §4.1 — POST /platform/tenants/:orgSlug/offboard (active|suspended → offboarding_initiated cascade).
export const OffboardTenantRequest = Type.Object({
  transitionReason: Type.String({ minLength: 8, maxLength: 1000 }),
  exportPurpose: lit(EXPORT_PURPOSE),
});

// §4.1 — POST /platform/tenants/:orgSlug/shred (only when status='destruction_pending' + cert approved).
export const ShredTenantRequest = Type.Object({
  transitionReason: Type.String({ minLength: 8, maxLength: 1000 }),
  destructionCertificateId: Type.String({ format: "uuid" }),
});

// §4.1 — POST /platform/tenants/:orgSlug/dek-rotate (enqueues `tenant.dek_rotate`; manual only Phase 1).
export const DekRotateRequest = Type.Object({
  reason: Type.String({ minLength: 8, maxLength: 1000 }),
});

// §4.1 — POST /platform/tenant-invitations (issue platform → first-admin single-use token via M36).
export const IssueInvitationRequest = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
  firstAdminEmail: Type.String({ format: "email" }),
  expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
});

// §4.1 — POST /platform/onboarding-templates (add/edit a NON-canonical template; canonical=migration-only).
export const UpsertOnboardingTemplateRequest = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128 }),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
  canonicalOrder: Type.Integer({ minimum: 0, maximum: 1000 }),
  // `is_canonical=true` is migration-only (§4.1); the route refuses to set it (literal false).
  isCanonical: Type.Optional(Type.Literal(false)),
});

// §4.1 — support sessions (F01/D8/D16). Start references a consent grant (the actor + org are server-
// side, never the body); elevate/close carry no body of consequence (the §7.4 step-up rides headers).
export const StartSessionRequest = Type.Object({
  supportConsentGrantId: Type.String({ format: "uuid" }),
});
export const ElevateSessionRequest = Type.Object({});
export const CloseSessionRequest = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 1000 })),
});

// §4.1 — signup-intent queue (qualify → enqueues the `tenant.provision` flow; reject records a rationale).
export const QualifyIntentRequest = Type.Object({
  planLabel: lit(PLAN_LABEL),
});
export const RejectIntentRequest = Type.Object({
  rejectionReason: Type.String({ minLength: 8, maxLength: 1000 }),
});

// §3.8 — platform-tenant BAA register (create one per (tenant_account, addendum_version); update status).
export const CreateBaaRequest = Type.Object({
  tenantAccountId: Type.String({ format: "uuid" }),
  addendumVersion: Type.String({ minLength: 1, maxLength: 64 }),
  baaStatus: lit(BAA_STATUS),
  executedOn: Type.Optional(ISO_DATE),
  effectiveOn: Type.Optional(ISO_DATE),
  expiresOn: Type.Optional(ISO_DATE),
  breachNotificationContactEmail: Type.Optional(Type.String({ format: "email" })),
  breachNotificationContactPhone: Type.Optional(Type.String({ maxLength: 64 })),
});
export const UpdateBaaRequest = Type.Object({
  baaStatus: Type.Optional(lit(BAA_STATUS)),
  executedOn: Type.Optional(ISO_DATE),
  effectiveOn: Type.Optional(ISO_DATE),
  expiresOn: Type.Optional(ISO_DATE),
  breachNotificationContactEmail: Type.Optional(Type.String({ format: "email" })),
  breachNotificationContactPhone: Type.Optional(Type.String({ maxLength: 64 })),
  documentId: Type.Optional(Type.String({ format: "uuid" })),
});

// §4.7/D13 — feature-flag admin (delegates to M1's FeatureFlagAdmin seam). `organizationId` null = global.
export const UpsertFeatureFlagRequest = Type.Object({
  flagKey: Type.String({ minLength: 1, maxLength: 128 }),
  organizationId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  flagKind: lit(FLAG_KIND),
  valueType: lit(FLAG_VALUE_TYPE),
  value: Type.Unknown(),
  rolloutPercent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  rationale: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const KillSwitchRequest = Type.Object({
  killSwitchActive: Type.Boolean(),
  organizationId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
});

// ── queries (cursor / keyset pagination — §4.1) ───────────────────────────────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

// §4.1 — GET /platform/tenants filters: status, plan_label, created_after, search-by-legal-name.
export const TenantListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ maxLength: 64 })),
  planLabel: Type.Optional(Type.String({ maxLength: 64 })),
  createdAfter: Type.Optional(Type.String({ format: "date-time" })),
  search: Type.Optional(Type.String({ maxLength: 300 })),
  ...PageQuery,
});

export const InvitationListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ maxLength: 64 })),
  ...PageQuery,
});

export const OnboardingTemplateListQuerySchema = Type.Object(PageQuery);

// §4.1 — GET /platform/support-sessions (active + recent across tenants; filter tenant + status).
export const SupportSessionListQuerySchema = Type.Object({
  tenantAccountId: Type.Optional(Type.String({ format: "uuid" })),
  status: Type.Optional(lit(SUPPORT_SESSION_STATUS)),
  ...PageQuery,
});
export const SessionEventListQuerySchema = Type.Object(PageQuery);

// §4.1 — GET /platform/signup-intents (the triage queue; filter status + source).
export const SignupIntentListQuerySchema = Type.Object({
  status: Type.Optional(lit(SIGNUP_INTENT_STATUS)),
  source: Type.Optional(lit(SIGNUP_INTENT_SOURCE)),
  ...PageQuery,
});

// §4.1 — GET /platform/baa-register (across tenants; filter tenant + status).
export const BaaRegisterListQuerySchema = Type.Object({
  tenantAccountId: Type.Optional(Type.String({ format: "uuid" })),
  status: Type.Optional(lit(BAA_STATUS)),
  ...PageQuery,
});

// §4.1 — GET /platform/feature-flags (platform-global + per-tenant; filter org + kind).
export const FeatureFlagListQuerySchema = Type.Object({
  organizationId: Type.Optional(Type.String({ format: "uuid" })),
  flagKind: Type.Optional(lit(FLAG_KIND)),
  ...PageQuery,
});

// ── response views (read surfaces — the Phase-3 platform-ops screens consume these) ───────────────────
const CursorPageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });

export const TenantSummaryViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  orgSlug: Type.String(),
  legalBusinessName: Type.String(),
  status: Type.String(),
  planLabel: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
export const TenantListResponseSchema = CursorPageOf(TenantSummaryViewSchema);

export const TenantInvitationViewSchema = Type.Object({
  id: Type.String(),
  tenantAccountId: Type.String(),
  firstAdminEmail: Type.String(),
  status: Type.String(),
  issuedAt: Type.String({ format: "date-time" }),
  expiresAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export const InvitationListResponseSchema = CursorPageOf(TenantInvitationViewSchema);

export const OnboardingTemplateViewSchema = Type.Object({
  key: Type.String(),
  title: Type.String(),
  canonicalOrder: Type.Integer(),
  isCanonical: Type.Boolean(),
  createdAt: Type.String({ format: "date-time" }),
  id: Type.String(),
});
export const OnboardingTemplateListResponseSchema = CursorPageOf(OnboardingTemplateViewSchema);

export const SupportSessionViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  supportConsentGrantId: Type.String(),
  tenantAccountId: Type.Union([Type.String(), Type.Null()]),
  actorMembershipId: Type.String(),
  startedAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
  closedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  closeReason: Type.Union([Type.String(), Type.Null()]),
  status: lit(SUPPORT_SESSION_STATUS),
});
export const SupportSessionListResponseSchema = CursorPageOf(SupportSessionViewSchema);

export const SupportSessionEventViewSchema = Type.Object({
  id: Type.String(),
  supportSessionId: Type.String(),
  eventKind: Type.String(),
  resourceKind: Type.Union([Type.String(), Type.Null()]),
  resourceId: Type.Union([Type.String(), Type.Null()]),
  occurredAt: Type.String({ format: "date-time" }),
  actorIp: Type.Union([Type.String(), Type.Null()]),
});
export const SupportSessionEventListResponseSchema = CursorPageOf(SupportSessionEventViewSchema);

export const SignupIntentViewSchema = Type.Object({
  id: Type.String(),
  contactEmail: Type.String(),
  legalBusinessName: Type.String(),
  intendedFirstAdminEmail: Type.String(),
  intentStatus: lit(SIGNUP_INTENT_STATUS),
  source: lit(SIGNUP_INTENT_SOURCE),
  rejectionReason: Type.Union([Type.String(), Type.Null()]),
  receivedAt: Type.String({ format: "date-time" }),
  processedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  tenantAccountId: Type.Union([Type.String(), Type.Null()]),
});
export const SignupIntentListResponseSchema = CursorPageOf(SignupIntentViewSchema);

export const BaaRecordViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  tenantAccountId: Type.String(),
  addendumVersion: Type.String(),
  baaStatus: lit(BAA_STATUS),
  executedOn: Type.Union([Type.String(), Type.Null()]),
  effectiveOn: Type.Union([Type.String(), Type.Null()]),
  expiresOn: Type.Union([Type.String(), Type.Null()]),
  documentId: Type.Union([Type.String(), Type.Null()]),
  attestedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export const BaaRegisterListResponseSchema = CursorPageOf(BaaRecordViewSchema);

export const FeatureFlagViewSchema = Type.Object({
  id: Type.String(),
  flagKey: Type.String(),
  organizationId: Type.Union([Type.String(), Type.Null()]),
  flagKind: lit(FLAG_KIND),
  valueType: lit(FLAG_VALUE_TYPE),
  value: Type.Unknown(),
  rolloutPercent: Type.Union([Type.Integer(), Type.Null()]),
  killSwitchActive: Type.Boolean(),
  updatedAt: Type.String({ format: "date-time" }),
});
export const FeatureFlagListResponseSchema = CursorPageOf(FeatureFlagViewSchema);

// §5.2 — full tenant overview (account + latest status_event + key_ring meta + onboarding + BAA + counts).
export const TenantOverviewViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  orgSlug: Type.String(),
  legalBusinessName: Type.String(),
  status: Type.String(),
  planLabel: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  latestStatusEvent: Type.Union([
    Type.Object({
      id: Type.String(),
      toStatus: Type.String(),
      occurredAt: Type.String({ format: "date-time" }),
      reason: Type.String(),
    }),
    Type.Null(),
  ]),
  keyRing: Type.Union([
    Type.Object({
      currentDekVersion: Type.String(),
      dekLastRotatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
      destroyedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    }),
    Type.Null(),
  ]),
  onboarding: Type.Object({
    totalTasks: Type.Integer(),
    doneTasks: Type.Integer(),
    currentStep: Type.Union([Type.String(), Type.Null()]),
  }),
  baa: Type.Union([
    Type.Object({ status: Type.String(), expiresOn: Type.Union([Type.String(), Type.Null()]) }),
    Type.Null(),
  ]),
  activeGrants: Type.Integer(),
  activeSessions: Type.Integer(),
});

// §3.5 — metadata-only key-ring view (ciphertext is NEVER exposed; `tenant_key_ring_metadata_v`).
export const KeyRingMetadataViewSchema = Type.Object({
  id: Type.String(),
  tenantAccountId: Type.String(),
  currentDekVersion: Type.String(),
  currentDekKekId: Type.String(),
  priorDekVersionCount: Type.Integer(),
  dekCreatedAt: Type.String({ format: "date-time" }),
  dekLastRotatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  destroyedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  destructionCertificateId: Type.Union([Type.String(), Type.Null()]),
});

// ── §4.2 command acknowledgements (the worker-enqueue + synchronous-command routes' typed results) ──────
/** provision / shred / dek-rotate → `{ tenantAccountId, jobId }` (the enqueued §4.3 job id). */
export const TenantJobAckSchema = Type.Object({
  tenantAccountId: Type.String(),
  jobId: Type.String(),
});
/** status-transition / offboard → `{ tenantAccountId, status }` (the resulting lifecycle status). */
export const TenantStatusAckSchema = Type.Object({
  tenantAccountId: Type.String(),
  status: Type.String(),
});
/** DELETE tenant-invitation → `{ id, status: 'revoked' }`. */
export const RevokeInvitationAckSchema = Type.Object({
  id: Type.String(),
  status: Type.Literal("revoked"),
});
/** start support session → `{ sessionId, expiresAt }`. */
export const StartSessionAckSchema = Type.Object({
  sessionId: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
});
/** elevate support session → `{ elevationExpiresAt }`. */
export const ElevateSessionAckSchema = Type.Object({
  elevationExpiresAt: Type.String({ format: "date-time" }),
});
/** close support session → `{ sessionId, closeReason }`. */
export const CloseSessionAckSchema = Type.Object({
  sessionId: Type.String(),
  closeReason: Type.String(),
});
/** qualify signup intent → `{ intentId, intentStatus, jobId }` (enqueues the provision flow). */
export const QualifyIntentAckSchema = Type.Object({
  intentId: Type.String(),
  intentStatus: Type.String(),
  jobId: Type.String(),
});
/** reject signup intent → `{ intentId, intentStatus }`. */
export const RejectIntentAckSchema = Type.Object({
  intentId: Type.String(),
  intentStatus: Type.String(),
});

// Compile-time pins: each read DTO structurally conforms to its `service.ts` view (drift = a type error).
type Conforms<T extends V, V> = T;
type _TenantSummary = Conforms<Static<typeof TenantSummaryViewSchema>, ServiceTenantSummaryView>;
type _TenantOverview = Conforms<Static<typeof TenantOverviewViewSchema>, ServiceTenantOverview>;
type _KeyRing = Conforms<Static<typeof KeyRingMetadataViewSchema>, ServiceKeyRingMetadataView>;
type _Invitation = Conforms<Static<typeof TenantInvitationViewSchema>, ServiceTenantInvitationView>;
type _Template = Conforms<
  Static<typeof OnboardingTemplateViewSchema>,
  ServiceOnboardingTemplateView
>;
type _Session = Conforms<Static<typeof SupportSessionViewSchema>, ServiceSupportSessionView>;
type _SessionEvent = Conforms<
  Static<typeof SupportSessionEventViewSchema>,
  ServiceSupportSessionEventView
>;
type _Intent = Conforms<Static<typeof SignupIntentViewSchema>, ServiceSignupIntentView>;
type _Baa = Conforms<Static<typeof BaaRecordViewSchema>, ServiceBaaRecordView>;
type _Flag = Conforms<Static<typeof FeatureFlagViewSchema>, ServiceFeatureFlagView>;

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope (M22 `parse`). */
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
