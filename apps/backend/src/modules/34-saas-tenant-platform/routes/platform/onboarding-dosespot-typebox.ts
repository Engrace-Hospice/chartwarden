// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-dosespot-typebox.ts — request contracts of the
// platform copy of the DoseSpot registration routes (`/api/v1/platform/tenants/:orgSlug/dosespot…`, tenant onboarding slice 4).
// The bodies are M12's own (`PutClinicBodySchema`, `EnrollPrescriberVendorBodySchema`, which M34 may not import); M12 re-validates
// each with its schema, so these are the published copies plus the operator's `reason`. Credentials are write-only. Each is ONE
// flat object with `additionalProperties: false` (a Composite drops that flag, so an extra field would slip through).
import { Type } from "@sinclair/typebox";
import { OnboardingReasonSchema } from "./onboarding-data-typebox";

const { reason } = OnboardingReasonSchema.properties;
const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const OnboardingDoseSpotPutRequest = Type.Object(
  {
    environment: Type.Union([Type.Literal("sandbox"), Type.Literal("production")], {
      description:
        "The DoseSpot environment the clinic lives in. A name, never a URL: the host is platform configuration. Production needs the platform to have enabled it.",
    }),
    clinicId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    serviceClinicianId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    clinicKey: Type.Optional(
      Type.String({
        minLength: 8,
        maxLength: 512,
        description: "Write-only: sealed under the tenant's own key and never returned.",
      }),
    ),
    subscriptionKey: Type.Optional(
      Type.String({
        minLength: 8,
        maxLength: 512,
        description:
          "Write-only. Platform support may set the clinic's own Subscription-Key; a tenant administrator may only rotate one that was set.",
      }),
    ),
    reason,
  },
  { additionalProperties: false },
);

export const OnboardingDoseSpotEnrollRequest = Type.Object(
  {
    npi: Type.String({ pattern: "^[0-9]{10}$" }),
    firstName: Type.String({ minLength: 1, maxLength: 100 }),
    lastName: Type.String({ minLength: 1, maxLength: 100 }),
    reason,
  },
  { additionalProperties: false },
);

export const OnboardingDoseSpotMembershipParamsSchema = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
  membershipId: Type.String({ pattern: UUID_PATTERN }),
});
