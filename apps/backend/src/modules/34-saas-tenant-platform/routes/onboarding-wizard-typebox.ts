// apps/backend/src/modules/34-saas-tenant-platform/routes/onboarding-wizard-typebox.ts — M34 onboarding wizard v2.
//
// The request bodies and response views of the wizard routes on BOTH surfaces (platform `/platform/tenants/:orgSlug/...`
// and tenant `/tenant/...`). Bodies bound the RAW strings; the trimmed-length rules (evidence note, reason, display name,
// time zone) are enforced by the service (onboarding/evidence.ts, org-profile.ts), which is the authority.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { COMPLETION_MODES, STEP_OWNERS } from "../onboarding/model";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Instant = Type.String({ format: "date-time" });

// ── bodies ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Platform attestation: evidence plus the written reason the operator is settling this step on the tenant's behalf. */
export const PlatformAttestStepRequest = Type.Object({
  evidenceNote: Type.String({ minLength: 1, maxLength: 2000 }),
  evidenceRef: Type.Optional(Type.String({ maxLength: 500 })),
  reason: Type.String({ minLength: 8, maxLength: 1000 }),
});
export const TenantAttestStepRequest = Type.Object({
  evidenceNote: Type.String({ minLength: 1, maxLength: 2000 }),
  evidenceRef: Type.Optional(Type.String({ maxLength: 500 })),
});
/** The legacy `/complete` body: `completionEvidence` is ignored; `evidenceNote` is required at runtime (422 otherwise). */
export const TenantCompleteStepRequest = Type.Object({
  completionEvidence: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  evidenceNote: Type.Optional(Type.String({ maxLength: 2000 })),
  evidenceRef: Type.Optional(Type.String({ maxLength: 500 })),
});
export const PlatformReasonRequest = Type.Object({
  reason: Type.String({ minLength: 8, maxLength: 1000 }),
});
/** A re-open discards an attestation the audit trail relied on, so the tenant says why (the service trims and judges it). */
export const TenantReopenStepRequest = Type.Object({
  reason: Type.String({ minLength: 8, maxLength: 1000 }),
});
export const OrgProfileRequest = Type.Object(
  {
    displayName: Type.Optional(Type.String({ maxLength: 200 })),
    orgTimezone: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { minProperties: 1 },
);
export const SetComplianceOfficerRequest = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
});
/** The platform assignment also says why (8 to 500 characters, judged after trimming by the service). */
export const SetComplianceOfficerPlatformRequest = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  reason: Type.String({ minLength: 8, maxLength: 500 }),
});
export const GoLiveAttestRequest = Type.Object({
  attestationConfirmed: Type.Literal(true),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});

// ── views ────────────────────────────────────────────────────────────────────────────────────────────────────
const TASK_STATUS = ["pending", "in_progress", "done", "skipped", "blocked"] as const;

export const WizardStepViewSchema = Type.Object({
  id: Nullable(Type.String()),
  key: Type.String(),
  title: Type.String(),
  description: Type.String(),
  owner: lit(STEP_OWNERS),
  sequence: Type.Number(),
  optional: Type.Boolean(),
  status: lit(TASK_STATUS),
  locked: Type.Boolean(),
  lockedBy: Nullable(Type.String()),
  completionMode: lit(COMPLETION_MODES),
  evidence: Nullable(Type.Object({ note: Type.String(), ref: Nullable(Type.String()) })),
  attestedBy: Nullable(
    Type.Object({
      membershipId: Type.String(),
      actorKind: lit(["platform_ops", "tenant"] as const),
      at: Instant,
    }),
  ),
  assignedToMembershipId: Nullable(Type.String()),
  dueAt: Nullable(Instant),
  startedAt: Nullable(Instant),
  completedAt: Nullable(Instant),
  blockerReason: Nullable(Type.String()),
  skipRationale: Nullable(Type.String()),
  createdAt: Nullable(Instant),
  templateKey: Type.String(),
  isCanonical: Type.Boolean(),
  canonicalOrder: Type.Number(),
});

const GoLiveAttestationViewSchema = Type.Object({
  id: Type.String(),
  status: lit(["pending", "approved", "revoked"] as const),
  attestedByMembershipId: Type.String(),
  attestedAt: Instant,
  expiresAt: Nullable(Instant),
  attestationNote: Nullable(Type.String()),
  approvedByMembershipId: Nullable(Type.String()),
  approvedAt: Nullable(Instant),
  approvalReason: Nullable(Type.String()),
  revokedByMembershipId: Nullable(Type.String()),
  revokedAt: Nullable(Instant),
  revokeReason: Nullable(Type.String()),
});

export const GoLiveViewSchema = Type.Object({
  state: lit(["not_ready", "awaiting_attestation", "awaiting_approval", "live", "closed"] as const),
  attestation: Nullable(GoLiveAttestationViewSchema),
  failedGuards: Type.Array(Type.String()),
  complianceOfficerMembershipId: Nullable(Type.String()),
});

export const OrgProfileViewSchema = Type.Object({
  displayName: Type.String(),
  orgTimezone: Type.String(),
});

const WizardBase = {
  tenantAccountId: Type.String(),
  orgSlug: Type.String(),
  tenantStatus: Type.String(),
  currentStepKey: Nullable(Type.String()),
  steps: Type.Array(WizardStepViewSchema),
  goLive: GoLiveViewSchema,
};

/** `GET /api/v1/platform/tenants/:orgSlug/onboarding`. `tasks` and `currentStep` are the older names, kept as aliases. */
export const PlatformWizardResponseSchema = Type.Object({
  ...WizardBase,
  orgProfile: Nullable(OrgProfileViewSchema),
  currentStep: Nullable(Type.String()),
  tasks: Type.Array(WizardStepViewSchema),
});
/** `GET /api/v1/tenant/onboarding`. `items` is the older name; the list is the whole ordered wizard, so no cursor. */
export const TenantWizardResponseSchema = Type.Object({
  ...WizardBase,
  orgProfile: Nullable(OrgProfileViewSchema),
  items: Type.Array(WizardStepViewSchema),
  nextCursor: Nullable(Type.String()),
  hasMore: Type.Boolean(),
});
/** The go-live attest / approve / revoke responses: the wizard without the profile. */
export const GoLiveResponseSchema = Type.Object(WizardBase);
export const ComplianceOfficerResponseSchema = Type.Object({
  complianceOfficerMembershipId: Type.String(),
});

export type WizardStepViewDto = Static<typeof WizardStepViewSchema>;
