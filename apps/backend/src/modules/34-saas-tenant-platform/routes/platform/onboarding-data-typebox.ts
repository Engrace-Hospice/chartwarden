// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-typebox.ts — request/response
// contracts for the platform onboarding-data routes (`/api/v1/platform/tenants/:orgSlug/{provider-entities,
// locations,mac-credentials}`). The create/patch bodies are the tenant routes' OWN published bodies (M2's
// `org-admin-typebox`, which M34 may import) plus the platform-only `reason`, so the two surfaces cannot drift;
// the views are re-exported unchanged. Named `*-typebox` so the table-ownership heuristic never reads it as a
// Drizzle import.
import { type TSchema, Type } from "@sinclair/typebox";
import {
  LocationDetailSchema,
  ProviderEntityDetailSchema,
  LocationCreateRequestSchema as TenantLocationCreateRequest,
  LocationPatchRequestSchema as TenantLocationPatchRequest,
  ProviderEntityCreateRequestSchema as TenantProviderEntityCreateRequest,
  ProviderEntityPatchRequestSchema as TenantProviderEntityPatchRequest,
} from "../../../02-identity/routes/org-admin-typebox";
import { assertNoPatientIdentifier } from "../../onboarding/evidence";

export { LocationDetailSchema, ProviderEntityDetailSchema };

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const Iso = Type.String({ format: "date-time" });

/** The NORMALISED length is checked again in the route (`minLength` counts the spaces a whitespace-only reason is made of). */
export const ONBOARDING_REASON_MIN = 8;
export const ONBOARDING_REASON_MAX = 500;

/**
 * The reason as it is stored in the tenant-visible audit trail: whitespace runs (line breaks and tabs included) become
 * one space, control and format characters (`\p{C}`: NUL, zero-width, bidi overrides) are removed, and the ends are
 * trimmed. Whitespace is folded BEFORE the strip so "line one\nline two" never fuses into one word.
 */
export function normalizeReason(raw: string): string {
  const reason = raw
    .replace(/\s+/gu, " ")
    .replace(/\p{C}+/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  // The reason is copied into the tenant-visible audit trail: it is no place for a patient, so it goes through the same
  // identifier screen as every other wizard free text (judged AFTER the strip, so zero-width padding cannot split a value).
  assertNoPatientIdentifier("reason", reason);
  return reason;
}

export const OnboardingReasonSchema = Type.Object({
  reason: Type.String({
    minLength: ONBOARDING_REASON_MIN,
    maxLength: ONBOARDING_REASON_MAX,
    description: `Why the operator is entering this on the tenant's behalf (${ONBOARDING_REASON_MIN}-${ONBOARDING_REASON_MAX} characters after whitespace is collapsed and control characters are removed; a ticket reference, no patient information). Recorded on the audit row beside the operator and the tenant.`,
  }),
});

export const OnboardingResourceParamsSchema = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
  id: Type.String({ format: "uuid" }),
});

export const OnboardingProviderEntityCreateRequest = Type.Composite([
  TenantProviderEntityCreateRequest,
  OnboardingReasonSchema,
]);
export const OnboardingProviderEntityPatchRequest = Type.Composite([
  TenantProviderEntityPatchRequest,
  OnboardingReasonSchema,
]);
export const OnboardingLocationCreateRequest = Type.Composite([
  TenantLocationCreateRequest,
  OnboardingReasonSchema,
]);
export const OnboardingLocationPatchRequest = Type.Composite([
  TenantLocationPatchRequest,
  OnboardingReasonSchema,
]);

/**
 * The MAC credential body is M23's (`UpsertMacCredentialBodySchema`, which M34 may not import); M23 re-validates it
 * with that schema, so this is the published copy. `clientSecret` is write-only.
 */
export const OnboardingMacCredentialUpsertRequest = Type.Composite([
  Type.Object({
    providerEntityId: Type.String({ format: "uuid" }),
    macJurisdiction: Type.String({
      minLength: 1,
      maxLength: 32,
      description:
        "The MAC jurisdiction key the tenant's billing screen offers (e.g. noridian_jf, ngs_j6, cgs_j15); M23 refuses any other with a 422.",
    }),
    submitterId: Type.String({ minLength: 1, maxLength: 64 }),
    tradingPartnerId: Type.String({ minLength: 1, maxLength: 64 }),
    clientId: Type.String({ minLength: 1, maxLength: 256 }),
    clientSecret: Type.String({
      minLength: 1,
      maxLength: 4096,
      description: "Write-only: sealed under the tenant's own key and never returned.",
    }),
    baaRecordRef: Type.Optional(Type.String({ maxLength: 256 })),
    credentialExpiresAt: Type.Optional(Type.String({ format: "date-time" })),
  }),
  OnboardingReasonSchema,
]);

export const OnboardingMacCredentialViewSchema = Type.Object({
  credentialId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  macJurisdiction: Type.String(),
  submitterId: Type.String(),
  tradingPartnerId: Type.String(),
  clientId: Type.String(),
  hasSecret: Type.Boolean({ description: "The secret itself is never projected." }),
  baaRecordRef: Nullable(Type.String()),
  credentialExpiresAt: Nullable(Iso),
  lastSandboxTestAt: Nullable(Iso),
  version: Type.Integer(),
  createdAt: Iso,
  updatedAt: Iso,
});

/** One active member of the tenant, as the compliance officer picker needs it (no user id, no credential state). */
export const OnboardingMemberViewSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  displayName: Nullable(Type.String()),
  email: Nullable(Type.String()),
  roleKeys: Type.Array(Type.String(), {
    description:
      "Enabled, unexpired roles the member holds in the tenant (compliance_officer first in a picker).",
  }),
});
export const OnboardingMemberListSchema = Type.Object({
  items: Type.Array(OnboardingMemberViewSchema),
});

export const OnboardingProviderEntityListSchema = Type.Object({
  items: Type.Array(ProviderEntityDetailSchema),
});
export const OnboardingLocationListSchema = Type.Object({
  items: Type.Array(LocationDetailSchema),
});
export const OnboardingMacCredentialListSchema = Type.Object({
  items: Type.Array(OnboardingMacCredentialViewSchema),
});

/**
 * The state Medicaid trading-partner credential body is M24's (`UpsertCredentialBody`, which M34 may not import);
 * M24 re-validates it with that schema (unknown keys refused). Secrets (`clientSecret`, `sftpKey`) are write-only;
 * an omitted secret leaves the stored one untouched.
 */
export const OnboardingMedicaidCredentialUpsertRequest = Type.Composite([
  Type.Object({
    providerEntityId: Type.String({ format: "uuid" }),
    serviceState: Type.String({ pattern: "^[A-Z]{2}$", description: "Two-letter state code." }),
    channel: Type.Union([
      Type.Literal("direct_mmis"),
      Type.Literal("cco_clearinghouse"),
      Type.Literal("sftp"),
      Type.Literal("portal"),
      Type.Literal("state_proprietary"),
    ]),
    mcoId: Type.Optional(Type.String({ format: "uuid" })),
    tradingPartnerId: Type.String({ minLength: 1, maxLength: 128 }),
    clientId: Type.Optional(Type.String({ maxLength: 256 })),
    clientSecret: Type.Optional(Type.String({ maxLength: 4096 })),
    sftpHost: Type.Optional(Type.String({ maxLength: 256 })),
    sftpUser: Type.Optional(Type.String({ maxLength: 256 })),
    sftpKey: Type.Optional(Type.String({ maxLength: 16384 })),
    portalUrl: Type.Optional(Type.String({ maxLength: 1024 })),
    activeFrom: Type.String({ format: "date" }),
    activeTo: Type.Optional(Type.String({ format: "date" })),
  }),
  OnboardingReasonSchema,
]);

export const OnboardingMedicaidCredentialIdSchema = Type.Object({ id: Type.String() });

export const OnboardingMedicaidCredentialViewSchema = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  serviceState: Type.String(),
  channel: Type.String(),
  mcoId: Nullable(Type.String()),
  tradingPartnerId: Type.String(),
  clientId: Nullable(Type.String()),
  sftpHost: Nullable(Type.String()),
  portalUrl: Nullable(Type.String()),
  activeFrom: Type.String(),
  activeTo: Nullable(Type.String()),
  lastSandboxTestAt: Nullable(Iso),
  lastSandboxTestResult: Nullable(Type.String()),
  version: Type.Integer(),
  hasClientSecret: Type.Boolean({ description: "The secret itself is never projected." }),
  hasSftpKey: Type.Boolean({ description: "The key itself is never projected." }),
});

export const OnboardingMedicaidCredentialListSchema = Type.Object({
  items: Type.Array(OnboardingMedicaidCredentialViewSchema),
});
